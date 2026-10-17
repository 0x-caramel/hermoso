"""Tests for the Hermoso plugin (assets/hermoso-plugin), against a fake bridge on a real loopback socket.

Run:  python -B apps/desktop/fork/plugin-tests/test_hermoso_plugin.py     (no dependencies beyond the standard library)
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.dont_write_bytecode = True

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "assets" / "hermoso-plugin"


def load_plugin():
    """The plugin directory has a hyphen in its name: load it as the package `hermoso`, like Hermes does."""
    for name in [n for n in sys.modules if n == "hermoso" or n.startswith("hermoso.")]:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        "hermoso", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["hermoso"] = module
    spec.loader.exec_module(module)
    return module


class FakeBridge:
    """A loopback server that checks the bearer token and answers scripted JSON per (method, path)."""

    def __init__(self, token: str = "tok") -> None:
        self.token = token
        self.answers: Dict[Tuple[str, str], Tuple[int, Dict[str, Any]]] = {}
        self.requests: List[Dict[str, Any]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self, method: str) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                outer.requests.append(
                    {
                        "method": method,
                        "path": self.path,
                        "auth": self.headers.get("Authorization"),
                        "type": self.headers.get("Content-Type"),
                        "body": json.loads(raw) if raw else None,
                    }
                )
                if self.headers.get("Authorization") != "Bearer " + outer.token:
                    status, payload = 401, {"ok": False, "code": "unauthorized"}
                else:
                    status, payload = outer.answers.get((method, self.path.split("?")[0]), (404, {"ok": False, "code": "not-found"}))
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:  # noqa: N802
                self._answer("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._answer("POST")

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def env(self) -> Dict[str, str]:
        return {"HERMOSO_BRIDGE_URL": self.url, "HERMOSO_BRIDGE_TOKEN": self.token}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeCtx:
    def __init__(self) -> None:
        self.tools: Dict[str, Dict[str, Any]] = {}
        self.hooks: List[Tuple[str, Any]] = []

    def register_tool(self, name: str, toolset: str, schema: dict, handler: Any, **kwargs: Any) -> None:
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_hook(self, name: str, callback: Any) -> None:
        self.hooks.append((name, callback))


def state(country: Optional[str] = "Germany", minutes: float = 10.0, phase: str = "away") -> Dict[str, Any]:
    trip = None
    if country:
        trip = {"country": "de", "countryName": country, "city": None, "until": (time.time() + minutes * 60) * 1000}
    return {"phase": phase, "home": {"label": "country no"} if trip else None, "trip": trip}


class PluginTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.plugin = load_plugin()
        self.bridge = FakeBridge()
        self.addCleanup(self.bridge.close)
        self.ctx = FakeCtx()
        self.plugin.teleport.register(self.ctx, self.plugin.bridge.Bridge(self.bridge.url, "tok", timeout=5.0))

    def call(self, tool: str, args: Any = None) -> Dict[str, Any]:
        raw = self.ctx.tools[tool]["handler"](args if args is not None else {})
        self.assertIsInstance(raw, str, "a tool handler must return a JSON string")
        return json.loads(raw)

    def hook(self) -> Any:
        return [callback for name, callback in self.ctx.hooks if name == "pre_tool_call"][0]


class Registration(unittest.TestCase):
    def test_inert_without_the_bridge_environment(self) -> None:
        plugin = load_plugin()
        ctx = FakeCtx()
        saved = {k: os.environ.pop(k, None) for k in ("HERMOSO_BRIDGE_URL", "HERMOSO_BRIDGE_TOKEN")}
        try:
            plugin.register(ctx)
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])

    def test_the_bridge_address_must_be_loopback_and_have_a_token(self) -> None:
        plugin = load_plugin()
        make = plugin.bridge.Bridge.from_env
        self.assertIsNone(make({}))
        self.assertIsNone(make({"HERMOSO_BRIDGE_URL": "http://127.0.0.1:5", "HERMOSO_BRIDGE_TOKEN": ""}))
        self.assertIsNone(make({"HERMOSO_BRIDGE_URL": "http://example.com:5", "HERMOSO_BRIDGE_TOKEN": "t"}))
        self.assertIsNone(make({"HERMOSO_BRIDGE_URL": "https://127.0.0.1:5", "HERMOSO_BRIDGE_TOKEN": "t"}))
        self.assertIsNotNone(make({"HERMOSO_BRIDGE_URL": "http://127.0.0.1:5", "HERMOSO_BRIDGE_TOKEN": "t"}))

    def test_active_with_the_environment_registers_four_tools_and_the_approval_hook(self) -> None:
        plugin = load_plugin()
        bridge = FakeBridge()
        self.addCleanup(bridge.close)
        ctx = FakeCtx()
        old = {k: os.environ.get(k) for k in bridge.env()}
        os.environ.update(bridge.env())
        try:
            plugin.register(ctx)
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertEqual(
            sorted(ctx.tools), ["hermoso_exits", "hermoso_return_home", "hermoso_teleport", "hermoso_where_am_i"]
        )
        self.assertEqual([name for name, _ in ctx.hooks], ["pre_tool_call"])
        for name, tool in ctx.tools.items():
            self.assertEqual(tool["toolset"], "hermoso")
            schema = tool["schema"]
            self.assertEqual(schema["name"], name)
            self.assertTrue(schema["description"])
            self.assertEqual(schema["parameters"]["type"], "object")
        self.assertEqual(ctx.tools["hermoso_teleport"]["schema"]["parameters"]["required"], ["country", "reason"])

    def test_the_manifest_declares_what_the_plugin_registers(self) -> None:
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
        for name in ("hermoso_teleport", "hermoso_return_home", "hermoso_where_am_i", "hermoso_exits", "pre_tool_call"):
            self.assertIn(name, manifest)
        self.assertIn("name: hermoso", manifest)


class Teleport(PluginTestCase):
    def test_a_jump_goes_to_the_app_with_the_token_and_comes_back_as_json(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (200, {"ok": True, "state": state("Germany", 15)})
        result = self.call("hermoso_teleport", {"country": " Germany ", "minutes": "15", "reason": "  compare\n prices "})
        self.assertTrue(result["ok"])
        self.assertEqual(result["country"], "Germany")
        self.assertEqual(result["home"], "country no")
        self.assertGreater(result["returns_in_minutes"], 14)
        self.assertIn("hermoso_return_home", result["message"])
        request = self.bridge.requests[-1]
        self.assertEqual(request["auth"], "Bearer tok")
        self.assertEqual(request["type"], "application/json")
        self.assertEqual(
            request["body"], {"country": "Germany", "by": "agent", "reason": "compare\n prices", "minutes": 15}
        )

    def test_a_city_is_passed_along_only_when_given(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (200, {"ok": True, "state": state()})
        self.call("hermoso_teleport", {"country": "de", "city": "Frankfurt", "reason": "x"})
        self.assertEqual(self.bridge.requests[-1]["body"]["city"], "Frankfurt")
        self.call("hermoso_teleport", {"country": "de", "reason": "x"})
        self.assertNotIn("city", self.bridge.requests[-1]["body"])

    def test_a_refusal_from_the_app_comes_back_as_an_error_with_its_reason(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (
            200,
            {"ok": False, "code": "unknown-destination", "message": 'Mullvad has no servers in "Atlantis".'},
        )
        result = self.call("hermoso_teleport", {"country": "Atlantis", "reason": "x"})
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["error"], "unknown-destination")
        self.assertIn("Atlantis", result["message"])

    def test_a_missing_country_never_reaches_the_app(self) -> None:
        for args in ({}, {"country": ""}, {"country": "   "}, {"reason": "x"}):
            self.assertEqual(self.call("hermoso_teleport", args)["error"], "missing-country")
        self.assertEqual(self.bridge.requests, [])

    def test_a_door_that_refuses_the_token_is_reported_not_raised(self) -> None:
        plugin = self.plugin
        ctx = FakeCtx()
        plugin.teleport.register(ctx, plugin.bridge.Bridge(self.bridge.url, "WRONG", timeout=5.0))
        raw = ctx.tools["hermoso_teleport"]["handler"]({"country": "de", "reason": "x"})
        self.assertEqual(json.loads(raw)["error"], "unauthorized")

    def test_a_closed_door_is_reported_not_raised(self) -> None:
        plugin = self.plugin
        gone = FakeBridge()
        url = gone.url
        gone.close()
        ctx = FakeCtx()
        plugin.teleport.register(ctx, plugin.bridge.Bridge(url, "tok", timeout=2.0))
        for tool, args in (
            ("hermoso_teleport", {"country": "de", "reason": "x"}),
            ("hermoso_return_home", {}),
            ("hermoso_where_am_i", {}),
            ("hermoso_exits", {}),
        ):
            result = json.loads(ctx.tools[tool]["handler"](args))
            self.assertEqual(result["ok"], False, tool)
            self.assertEqual(result["error"], "unreachable", tool)

    def test_handlers_never_raise_on_odd_input(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (200, {"ok": True, "state": state()})
        for args in (None, [], "text", 5, {"country": 5, "minutes": "soon", "reason": None}):
            raw = self.ctx.tools["hermoso_teleport"]["handler"](args)
            self.assertIsInstance(json.loads(raw), dict)

    def test_the_loopback_call_ignores_a_system_proxy(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/state")] = (200, {"ok": True, "state": state(None, phase="idle")})
        old = os.environ.get("HTTP_PROXY")
        os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
        try:
            self.assertTrue(self.call("hermoso_where_am_i")["ok"])
        finally:
            if old is None:
                os.environ.pop("HTTP_PROXY", None)
            else:
                os.environ["HTTP_PROXY"] = old


class OtherTools(PluginTestCase):
    def test_return_home(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/home")] = (200, {"ok": True, "state": state(None, phase="idle")})
        result = self.call("hermoso_return_home")
        self.assertTrue(result["ok"])
        self.assertEqual(result["phase"], "idle")
        self.assertEqual(self.bridge.requests[-1]["body"], {"by": "agent"})

    def test_a_failed_return_says_so(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/home")] = (200, {"ok": False, "code": "failed", "message": "retrying in 15s"})
        result = self.call("hermoso_return_home")
        self.assertEqual((result["ok"], result["error"]), (False, "failed"))

    def test_where_am_i_when_away_and_when_home(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/state")] = (200, {"ok": True, "state": state("France", 5)})
        away = self.call("hermoso_where_am_i")
        self.assertEqual((away["phase"], away["country"]), ("away", "France"))
        self.bridge.answers[("GET", "/v1/teleport/state")] = (200, {"ok": True, "state": state(None, phase="idle")})
        home = self.call("hermoso_where_am_i")
        self.assertEqual(home["phase"], "idle")
        self.assertNotIn("country", home)

    def test_exits_are_compact(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/destinations")] = (
            200,
            {"ok": True, "countries": [{"code": "de", "name": "Germany", "cities": [{"code": "fra", "name": "Frankfurt"}, {"code": "ber", "name": "Berlin"}]}]},
        )
        self.assertEqual(
            self.call("hermoso_exits"),
            {"ok": True, "countries": [{"code": "de", "name": "Germany", "cities": ["fra", "ber"]}]},
        )


class ApprovalHook(PluginTestCase):
    def test_every_teleport_goes_to_the_human_gate_with_the_place_the_length_and_the_reason(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/resolve")] = (
            200,
            {"ok": True, "country": {"code": "de", "name": "Germany"}, "city": {"code": "fra", "name": "Frankfurt"}},
        )
        verdict = self.hook()(tool_name="hermoso_teleport", args={"country": "germany", "city": "fra", "minutes": 20, "reason": "see the real price"})
        self.assertEqual(verdict["action"], "approve")
        self.assertEqual(verdict["rule_key"], "hermoso:teleport:de")
        message = verdict["message"]
        for expected in ("Germany (Frankfurt)", "20 min", "see the real price", "ALL of this computer's internet traffic"):
            self.assertIn(expected, message)
        self.assertIn("/v1/teleport/resolve?country=germany&city=fra", self.bridge.requests[-1]["path"])

    def test_the_length_is_clamped_like_the_app_does(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/resolve")] = (200, {"ok": True, "country": {"code": "de", "name": "Germany"}, "city": None})
        for given, shown in ((999, "60 min"), (0, "10 min"), (-3, "1 min"), ("x", "10 min"), (None, "10 min")):
            verdict = self.hook()(tool_name="hermoso_teleport", args={"country": "de", "minutes": given, "reason": "r"})
            self.assertIn(shown, verdict["message"], given)

    def test_still_asks_when_the_app_cannot_resolve_the_name(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/resolve")] = (200, {"ok": False, "code": "unknown-destination"})
        verdict = self.hook()(tool_name="hermoso_teleport", args={"country": "Atlantis", "reason": "r"})
        self.assertEqual(verdict["action"], "approve")
        self.assertIn("Atlantis", verdict["message"])

    def test_still_asks_when_the_app_is_not_answering(self) -> None:
        gone = FakeBridge()
        url = gone.url
        gone.close()
        ctx = FakeCtx()
        self.plugin.teleport.register(ctx, self.plugin.bridge.Bridge(url, "tok", timeout=2.0))
        hook = [callback for name, callback in ctx.hooks if name == "pre_tool_call"][0]
        verdict = hook(tool_name="hermoso_teleport", args={"country": "de", "reason": "r"})
        self.assertEqual(verdict["action"], "approve")

    def test_leaves_every_other_tool_alone(self) -> None:
        for name in ("terminal", "web_search", "hermoso_return_home", "hermoso_where_am_i", "hermoso_exits", ""):
            self.assertIsNone(self.hook()(tool_name=name, args={"country": "de"}), name)
        self.assertEqual(self.bridge.requests, [])

    def test_nothing_to_approve_without_a_country(self) -> None:
        for args in ({}, {"country": ""}, {"country": "  "}, None, "x"):
            self.assertIsNone(self.hook()(tool_name="hermoso_teleport", args=args))

    def test_accepts_the_extra_keyword_arguments_hermes_passes(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/resolve")] = (200, {"ok": True, "country": {"code": "de", "name": "Germany"}, "city": None})
        verdict = self.hook()(
            tool_name="hermoso_teleport", args={"country": "de", "reason": "r"}, task_id="t", session_id="s", tool_call_id="c", turn_id="n"
        )
        self.assertEqual(verdict["action"], "approve")


if __name__ == "__main__":
    unittest.main(verbosity=1)
