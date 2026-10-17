"""Hermoso: the protection that rides along with the agent.

Registered by the Hermes plugin loader (``register(ctx)``). It registers its tools always, but they are shown to the
model only while a Hermoso desktop app is running and answering (see ``bridge.Link.available``): in any other
setting (the official Hermes app sharing this data folder, a terminal, cron) the plugin stays out of the way.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from . import teleport
from .bridge import Link

logger = logging.getLogger(__name__)


def _version() -> str:
    try:
        manifest = (Path(__file__).resolve().parent / "plugin.yaml").read_text(encoding="utf-8")
        found = re.search(r'^version:\s*"?([^"\r\n]+?)"?\s*$', manifest, re.MULTILINE)
        return found.group(1) if found else ""
    except OSError:
        return ""


__version__ = _version()


def register(ctx: Any) -> None:
    link = Link(version=__version__)
    teleport.register(ctx, link)
    logger.info("hermoso: registered (tools are shown while a Hermoso app is running)")
