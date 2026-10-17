"""Teleport for the agent: change the Mullvad exit country for a while, with the user's approval.

Four tools and one approval hook. The agent never touches Mullvad: it asks the Hermoso app (through the bridge),
which does the work, remembers where "home" is, and brings the connection back by itself when the time is up.

Mullvad is system-wide: a jump moves the WHOLE computer's internet exit, not just this chat. So every
``hermoso_teleport`` call is escalated to the human approval gate (``pre_tool_call`` -> ``approve``) with a
plain-language message, and the tool descriptions tell the model to use it sparingly.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

from .bridge import Bridge, BridgeError

TOOLSET = "hermoso"

# Words for the model, in order of importance: when to use it, what it costs, how to give it back.
TELEPORT = {
    "name": "hermoso_teleport",
    "description": (
        "Temporarily move this computer's internet exit to another country through the Mullvad VPN, so a site or "
        "service sees you from there (geo-blocked content, regional prices, how a page looks from abroad). "
        "It changes the exit of the WHOLE computer, not only this chat, and the user is asked to approve every jump. "
        "Use it only when the task really needs another location, and say why in `reason`. It returns home by itself "
        "after `minutes` (default 10, at most 60); call hermoso_return_home as soon as you are done. "
        "Use hermoso_exits to see the countries and cities that exist."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "country": {
                "type": "string",
                "description": "Country to exit from: a name ('Germany') or a two-letter code ('de').",
            },
            "city": {
                "type": "string",
                "description": "Optional city in that country (name or code). Leave out to let Mullvad choose.",
            },
            "minutes": {
                "type": "integer",
                "description": "How long to stay, 1 to 60. Default 10. Ask for what you need, no more.",
            },
            "reason": {
                "type": "string",
                "description": "One short sentence the user will read when asked to approve (what you need it for).",
            },
        },
        "required": ["country", "reason"],
    },
}

RETURN_HOME = {
    "name": "hermoso_return_home",
    "description": (
        "Bring the internet exit back to where it was before hermoso_teleport. Call it as soon as the task that "
        "needed another country is done; it does nothing if you are already home."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

WHERE_AM_I = {
    "name": "hermoso_where_am_i",
    "description": (
        "Where the internet exit is right now: at home, or teleported (which country, since when, when it returns)."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

EXITS = {
    "name": "hermoso_exits",
    "description": "The countries (and their cities) Mullvad can exit from, with the codes hermoso_teleport accepts.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _json(value: Dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False)


def _error(code: str, message: str) -> str:
    return _json({"ok": False, "error": code, "message": message})


def _describe(state: Dict[str, Any]) -> Dict[str, Any]:
    """The part of the app's state an agent needs: where it is, and until when."""
    trip = state.get("trip") or None
    out: Dict[str, Any] = {"phase": state.get("phase", "idle")}
    home = state.get("home") or None
    if home:
        out["home"] = home.get("label") or "where Mullvad was"
    if trip:
        out["country"] = trip.get("countryName") or trip.get("country")
        if trip.get("city"):
            out["city"] = trip["city"]
        until = trip.get("until")
        if isinstance(until, (int, float)):
            out["returns_in_minutes"] = max(0, round((until / 1000.0 - time.time()) / 60.0, 1))
    return out


def _clean_minutes(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def make_tools(bridge: Bridge):
    """The four handlers, closed over a bridge. Each returns a JSON string and never raises."""

    def teleport(args: Any, **_: Any) -> str:
        args = args if isinstance(args, dict) else {}
        country = str(args.get("country") or "").strip()
        if not country:
            return _error("missing-country", "Say which country (a name like 'Germany' or a code like 'de').")
        body: Dict[str, Any] = {
            "country": country,
            "by": "agent",
            "reason": str(args.get("reason") or "").strip()[:200] or None,
        }
        city = str(args.get("city") or "").strip()
        if city:
            body["city"] = city
        minutes = _clean_minutes(args.get("minutes"))
        if minutes is not None:
            body["minutes"] = minutes
        try:
            reply = bridge.post("/v1/teleport/jump", body)
        except BridgeError as error:
            return _error(error.code, error.message)
        if not reply.get("ok"):
            return _error(str(reply.get("code") or "failed"), str(reply.get("message") or "the jump did not work"))
        where = _describe(reply.get("state") or {})
        return _json(
            {
                "ok": True,
                "message": "The internet exit is now in %s. Call hermoso_return_home when you are done." % where.get("country", country),
                **where,
            }
        )

    def return_home(args: Any = None, **_: Any) -> str:
        try:
            reply = bridge.post("/v1/teleport/home", {"by": "agent"})
        except BridgeError as error:
            return _error(error.code, error.message)
        if not reply.get("ok"):
            return _error(str(reply.get("code") or "failed"), str(reply.get("message") or "could not come back"))
        return _json({"ok": True, "message": "The internet exit is back home.", **_describe(reply.get("state") or {})})

    def where_am_i(args: Any = None, **_: Any) -> str:
        try:
            reply = bridge.get("/v1/teleport/state")
        except BridgeError as error:
            return _error(error.code, error.message)
        return _json({"ok": True, **_describe(reply.get("state") or {})})

    def exits(args: Any = None, **_: Any) -> str:
        try:
            reply = bridge.get("/v1/teleport/destinations")
        except BridgeError as error:
            return _error(error.code, error.message)
        countries = []
        for country in reply.get("countries") or []:
            countries.append(
                {
                    "code": country.get("code"),
                    "name": country.get("name"),
                    "cities": [city.get("code") for city in country.get("cities") or []],
                }
            )
        return _json({"ok": True, "countries": countries})

    return teleport, return_home, where_am_i, exits


def make_approval_hook(bridge: Bridge):
    """``pre_tool_call``: every teleport goes to the human gate, with the place and the length in the message."""

    def on_pre_tool_call(tool_name: str = "", args: Any = None, **_: Any) -> Optional[Dict[str, str]]:
        if tool_name != "hermoso_teleport" or not isinstance(args, dict):
            return None
        country = str(args.get("country") or "").strip()
        if not country:
            return None  # the tool answers with what is missing; nothing to approve yet
        name, code = country, country.lower()
        try:
            query = "/v1/teleport/resolve?country=%s" % quote(country)
            city = str(args.get("city") or "").strip()
            if city:
                query += "&city=%s" % quote(city)
            resolved = bridge.get(query, timeout=10.0)
            if resolved.get("ok"):
                name = (resolved.get("country") or {}).get("name") or name
                code = (resolved.get("country") or {}).get("code") or code
                if resolved.get("city"):
                    name = "%s (%s)" % (name, resolved["city"].get("name") or city)
        except BridgeError:
            pass  # the tool itself will report the problem; the approval still names what was asked for
        minutes = _clean_minutes(args.get("minutes")) or 10
        minutes = max(1, min(60, minutes))
        reason = str(args.get("reason") or "").strip() or "no reason given"
        return {
            "action": "approve",
            "message": (
                "Hermoso Teleport: send ALL of this computer's internet traffic (not only Hermoso) through %s "
                "for %d min, then come back by itself. Why: %s" % (name, minutes, reason[:200])
            ),
            "rule_key": "hermoso:teleport:%s" % code,
        }

    return on_pre_tool_call


def register(ctx: Any, bridge: Bridge) -> None:
    teleport, return_home, where_am_i, exits = make_tools(bridge)
    ctx.register_tool(name="hermoso_teleport", toolset=TOOLSET, schema=TELEPORT, handler=teleport, emoji="🌀")
    ctx.register_tool(name="hermoso_return_home", toolset=TOOLSET, schema=RETURN_HOME, handler=return_home, emoji="🏠")
    ctx.register_tool(name="hermoso_where_am_i", toolset=TOOLSET, schema=WHERE_AM_I, handler=where_am_i, emoji="📍")
    ctx.register_tool(name="hermoso_exits", toolset=TOOLSET, schema=EXITS, handler=exits, emoji="🌍")
    ctx.register_hook("pre_tool_call", make_approval_hook(bridge))
