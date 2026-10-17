"""Hermoso: the protection that rides along with the agent.

Registered by the Hermes plugin loader (``register(ctx)``). It does anything only when the backend was started by
the Hermoso desktop app, which hands it a local bridge address and a token through the environment; in any other
backend (the official Hermes app sharing this data folder, a terminal, cron) it stays out of the way.
"""

from __future__ import annotations

import logging
from typing import Any

from . import teleport
from .bridge import Bridge

logger = logging.getLogger(__name__)

__version__ = "0.1.0"


def register(ctx: Any) -> None:
    bridge = Bridge.from_env()
    if bridge is None:
        logger.info("hermoso: not started by the Hermoso app (no bridge in the environment); staying inactive")
        return
    teleport.register(ctx, bridge)
    logger.info("hermoso: active (bridge %s)", bridge.url)
