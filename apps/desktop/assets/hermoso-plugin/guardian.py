"""Guardian for the agent: a person stands between the agent and the few things that cannot be undone.

``guardian_rules`` recognises a risky tool call (deleting a folder, rewriting git history, running what was downloaded,
reading keys, switching the VPN off, writing where programs start by themselves...). This module asks the person about
it, through the Hermoso app, BEFORE the tool runs.

It is a ``tool_execution`` middleware rather than a ``pre_tool_call`` hook for two reasons: a hook is cut off after
about 30 s and the person may need longer, and a middleware can answer in place of the tool (it returns a refusal
without calling ``next_call``). A middleware that RAISES is skipped by Hermes and the tool runs anyway, so a refusal
is always a returned value, never an exception.

The app asks in its own window, not through Hermes' approval gate (with approvals off, in "smart" mode or under YOLO
that gate says yes without a human). The words the person reads come from ``guardian-rules.json``, not from the
agent. With no Hermoso app to ask (the official Hermes app sharing this data folder, a terminal, cron) there is
nobody to ask and the guardian does nothing; if the app was there a moment ago and stops answering, the risky action
is refused, because it can no longer be put to the person.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, Optional, Tuple

from . import guardian_rules
from .bridge import BridgeError, Link

logger = logging.getLogger(__name__)

# The app gives the person two minutes to answer; this is a little longer, so the app's "no answer" arrives first.
ASK_TIMEOUT = 150.0

_ADVICE = "Do not try again or look for another way to do it. Tell the user what you wanted to do and why, and let them decide."


def refusal(finding: guardian_rules.Finding, answer: str) -> str:
    """What the model gets back instead of the tool's result."""
    if answer == "blocked":
        message = "Hermoso's guardian does not allow this: %s. %s" % (finding.title, finding.why)
        advice = "Do not try again or look for another way to do it."
    elif answer == "timeout":
        message = "The user did not answer in time, so this was not done: %s." % finding.title
        advice = _ADVICE
    elif answer == "unreachable":
        message = "Hermoso stopped answering, so the user could not be asked and this was not done: %s." % finding.title
        advice = _ADVICE
    else:
        message = "The user said no to this: %s." % finding.title
        advice = _ADVICE
    return json.dumps(
        {"error": message + " " + advice, "blocked_by": "hermoso-guardian", "rule": finding.rule, "answer": answer},
        ensure_ascii=False,
    )


class Guardian:
    def __init__(self, link: Link, review: Callable[[str, Any], Optional[guardian_rules.Finding]] = guardian_rules.review) -> None:
        self.link = link
        self.review = review

    def ask(self, tool_name: str, finding: guardian_rules.Finding) -> Tuple[bool, str]:
        """Put the finding to the person through the app. (allowed, answer). Only an explicit yes from the app is a yes."""
        try:
            reply = self.link.require().post(
                "/v1/guardian/ask", dict(finding.as_json(), tool=tool_name), timeout=ASK_TIMEOUT
            )
        except BridgeError:
            return False, "unreachable"
        answer = str(reply.get("answer") or "")
        return reply.get("ok") is True and reply.get("allowed") is True, answer

    def tool_execution(self, tool_name: str = "", args: Any = None, next_call: Optional[Callable[..., Any]] = None, **_: Any) -> Any:
        if next_call is None:
            return None
        finding = self.review(tool_name, args)
        if finding is None or not self.link.available():
            return next_call()
        allowed, answer = self.ask(tool_name, finding)
        if allowed:
            return next_call()
        logger.warning("hermoso: the guardian refused %s (%s): %s", tool_name, finding.rule, answer or "no")
        return refusal(finding, answer)


def register(ctx: Any, link: Link) -> Guardian:
    guardian = Guardian(link)
    ctx.register_middleware("tool_execution", guardian.tool_execution)
    return guardian
