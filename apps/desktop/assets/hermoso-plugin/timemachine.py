"""The Time Machine's one command: put the project folder back to a snapshot, the safe way.

Hermes snapshots the working folder just before the agent first changes a file in a turn (see Hermes' own checkpoint
manager) and lists them over its gateway, which is how the Hermoso page lists them. What the gateway's own restore
does is the classic one: it puts back what the snapshot holds but leaves behind the files the agent CREATED after
it. The safe restore (what Hermes' ``/rollback`` does in the terminal) goes further: it undoes what Hermes itself
wrote, deleting the files it created, and keeps everything the person edited by hand since. That is the one the
page needs, and no gateway call reaches it, so it is a slash command the page runs for the chat that is open:

    /hermoso-rewind <snapshot>      put the project back; the answer is one line of JSON
    /hermoso-rewind                 list the snapshots of this chat's project folder (for a person typing it)

A slash command is the person's: the agent cannot type one. It runs inside Hermes' own process with the chat's project
folder bound, so this module uses Hermes' checkpoint manager directly and never guesses a folder. It never raises
into Hermes: any failure is an answer that says so.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict

logger = logging.getLogger(__name__)

COMMAND = "hermoso-rewind"

# What a snapshot id looks like: a git commit hash, whole or abbreviated. Nothing else reaches the manager.
SNAPSHOT_ID = re.compile(r"^[0-9a-f]{7,64}$")


def _json(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _failure(message: str) -> str:
    return _json({"success": False, "error": message})


def _hermes() -> Any:
    """Hermes' own pieces, imported when needed: the plugin loads in places that do not have them."""
    from agent.runtime_cwd import scoped_session_cwd  # type: ignore[import-not-found]
    from tools.checkpoint_manager import CheckpointManager  # type: ignore[import-not-found]

    return CheckpointManager(enabled=True), scoped_session_cwd()


def _listing(manager: Any, cwd: str) -> str:
    snapshots = manager.list_checkpoints(cwd) or []
    if not snapshots:
        return "No snapshots yet for %s. One is taken just before the agent first changes a file in a turn." % cwd
    lines = ["Snapshots of %s (newest first):" % cwd]
    for entry in snapshots[:20]:
        lines.append("  %s  %s  %s" % (str(entry.get("short_hash") or entry.get("hash", ""))[:8], entry.get("timestamp", ""), entry.get("reason", "")))
    lines.append("Put the project back with /%s <snapshot>." % COMMAND)
    return "\n".join(lines)


def rewind(raw_args: str = "") -> str:
    try:
        manager, cwd = _hermes()
    except Exception as error:  # Hermes without checkpoints, or not running this plugin inside its gateway
        return _failure("Hermes' snapshots are not available here (%s)." % (error,))
    cwd = str(cwd or "").strip()
    if not cwd:
        return _failure("This chat has no project folder to put back.")

    tokens = str(raw_args or "").split()
    if not tokens:
        try:
            return _listing(manager, cwd)
        except Exception as error:
            return _failure("Could not list the snapshots (%s)." % (error,))

    snapshot = tokens[0].lower()
    if not SNAPSHOT_ID.match(snapshot):
        return _failure("That is not a snapshot id.")
    try:
        # safe=True, never a file: undo what Hermes wrote (deleting what it created), keep what the person edited.
        result = manager.restore(cwd, snapshot, safe=True)
    except Exception as error:
        logger.warning("hermoso: the rewind failed: %s", error)
        return _failure("The rewind failed (%s)." % (error,))
    if not isinstance(result, dict):
        return _failure("Hermes did not say how the rewind went.")
    return _json(result)


def register(ctx: Any) -> None:
    ctx.register_command(
        COMMAND,
        rewind,
        description="Hermoso Time Machine: put the project folder back to a snapshot (keeps what you edited yourself)",
        args_hint="<snapshot>",
    )
