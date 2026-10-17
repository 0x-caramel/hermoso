"""Shield for the agent: while the VPN is required and its tunnel is not up, the agent stands still.

The Hermoso app watches the VPN and decides (``GET /v1/shield/state``: ``frozen`` is true exactly when the person's
settings require the tunnel and it is not up; a planned reconnect, like a Teleport, never counts). This module only
asks, at the two places where Hermes lets a plugin hold the agent:

* the call to the model provider (``llm_execution`` middleware). This is the real freeze: an agent that cannot think
  cannot act. It WAITS inside the call, because a middleware that raises is skipped by Hermes (it fails open) while
  one that waits holds the call. A model on this very computer or on the local network is not held: nothing that
  leaves the machine goes through it.
* a tool that is about to run (``pre_tool_call`` hook). It waits a few seconds for the tunnel to come back, then is
  refused with a message that says why, and nothing was run. A hook has about 30 s before Hermes fails it closed, so
  the wait is shorter than that.

Without a Hermoso app to ask (the official Hermes app sharing this data folder, a terminal, cron) there is no VPN
gate to honor, so the shield does nothing.

What this does not do, said plainly: it cannot stop a request Hermes had already sent when the tunnel dropped, nor
Hermes' own helper calls (titles, summaries), and if the person presses Stop during a freeze Hermes sends the one
request it was holding and cancels it. The only hard guarantee against a leak while the tunnel is down is Mullvad's
"Always require VPN", which the Hermoso app can switch on.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import time
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

from .bridge import BridgeError, Link

logger = logging.getLogger(__name__)

# How often a frozen agent asks the app whether the tunnel is back.
POLL_SECONDS = 1.0
# How long a tool waits for the tunnel before it is refused. Under Hermes' own 30 s limit for a pre_tool_call hook.
TOOL_WAIT_SECONDS = 20.0
# Do not write the same line to the log every second.
NOTE_EVERY_SECONDS = 30.0

# These only read a catalog or talk to the Hermoso app on this computer (nothing leaves it), or they are the way
# out of a trip: they are never held. Everything else is, because most tools can reach the network.
ALWAYS_ALLOWED = frozenset(
    {
        "clarify",
        "hermoso_exits",
        "hermoso_return_home",
        "hermoso_where_am_i",
        "tool_call",
        "tool_describe",
        "tool_search",
    }
)

FROZEN_MESSAGE = (
    "Hermoso froze the agent: the VPN tunnel is down, so this was not run. Nothing is lost: it works again by itself "
    "when the tunnel is back. Do not try again now; tell the user the VPN is down and wait."
)


def _interrupted() -> bool:
    """Whether the person asked this turn to stop (Hermes' own per-thread signal). False outside Hermes."""
    try:
        from tools.interrupt import is_interrupted  # type: ignore[import-not-found]

        return bool(is_interrupted())
    except Exception:
        return False


def holds_local_models() -> bool:
    """For tests only: HERMOSO_SHIELD_HOLD_LOCAL=1 holds the call to a model on this computer too, so a test can
    use a scripted model on 127.0.0.1 and still see the freeze. Nobody needs it otherwise."""
    return os.environ.get("HERMOSO_SHIELD_HOLD_LOCAL", "").strip().lower() in ("1", "true", "yes", "on")


def is_local_endpoint(base_url: Any) -> bool:
    """True for a model server on this computer or on the local network: a request to it never leaves the machine
    for the internet, so a missing tunnel cannot expose the real address through it."""
    try:
        host = (urlparse(str(base_url or "")).hostname or "").strip().lower()
    except ValueError:
        return False
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False  # a name we cannot place: assume the internet
    return address.is_loopback or address.is_private or address.is_link_local


class Shield:
    def __init__(
        self,
        link: Link,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
        interrupted: Callable[[], bool] = _interrupted,
    ) -> None:
        self.link = link
        self._sleep = sleep
        self._now = now
        self._interrupted = interrupted
        self._noted_at: Optional[float] = None

    def verdict(self) -> Optional[Dict[str, Any]]:
        """What the app says right now, or None when there is no app to ask (the shield then does nothing)."""
        bridge = self.link.bridge()
        if bridge is None:
            return None
        try:
            reply = bridge.get("/v1/shield/state", timeout=2.0)
        except BridgeError:
            return None
        return reply if reply.get("ok") is True else None

    def frozen(self) -> bool:
        verdict = self.verdict()
        return bool(verdict and verdict.get("frozen") is True)

    def _note(self, what: str) -> None:
        now = self._now()
        if self._noted_at is None or now - self._noted_at >= NOTE_EVERY_SECONDS:
            self._noted_at = now
            logger.warning("hermoso: %s", what)

    def wait_until_clear(self, limit: Optional[float], what: str) -> bool:
        """Wait while the shield says frozen. True: clear, go on. False: still frozen, because the limit passed or
        the person pressed Stop."""
        started = self._now()
        while self.frozen():
            self._note("the VPN tunnel is down, holding %s" % what)
            if self._interrupted():
                return False
            if limit is not None and self._now() - started >= limit:
                return False
            self._sleep(POLL_SECONDS)
        return True

    # ── the two places Hermes lets a plugin hold the agent ──

    def pre_tool_call(self, tool_name: str = "", args: Any = None, **_: Any) -> Optional[Dict[str, Any]]:
        if tool_name in ALWAYS_ALLOWED:
            return None
        if self.wait_until_clear(TOOL_WAIT_SECONDS, "the tool " + (tool_name or "call")):
            return None
        return {"action": "block", "message": FROZEN_MESSAGE}

    def llm_execution(self, request: Any = None, next_call: Optional[Callable[..., Any]] = None, base_url: Any = "", **_: Any) -> Any:
        if next_call is None:
            return None
        if holds_local_models() or not is_local_endpoint(base_url):
            # No limit: a frozen agent stays frozen until the tunnel is back, or the person stops it.
            self.wait_until_clear(None, "the call to the model")
        return next_call()


def register(ctx: Any, link: Link) -> Shield:
    shield = Shield(link)
    ctx.register_hook("pre_tool_call", shield.pre_tool_call)
    ctx.register_middleware("llm_execution", shield.llm_execution)
    return shield
