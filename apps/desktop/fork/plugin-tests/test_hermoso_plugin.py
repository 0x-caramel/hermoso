"""Tests for the Hermoso plugin (assets/hermoso-plugin), against a fake bridge on a real loopback socket.

Run:  python -B apps/desktop/fork/plugin-tests/test_hermoso_plugin.py     (no dependencies beyond the standard library)
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
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
        self.answers: Dict[Tuple[str, str], Tuple[int, Dict[str, Any]]] = {
            ("GET", "/v1/hello"): (200, {"ok": True, "app": "hermoso"})
        }
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

    def publish(self, directory: Path) -> None:
        """What the app does for the plugin: write its address and secret next to it."""
        (directory / ".bridge.json").write_text(json.dumps({"url": self.url, "token": self.token}), encoding="utf-8")

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


class Case(unittest.TestCase):
    def setUp(self) -> None:
        self.plugin = load_plugin()
        self.dir = Path(tempfile.mkdtemp(prefix="hermoso-plugin-test-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.bridge = FakeBridge()
        self.addCleanup(self.bridge.close)
        self.bridge.publish(self.dir)
        self.link = self.plugin.bridge.Link(directory=self.dir, version="9.9.9")
        self.ctx = FakeCtx()
        self.plugin.teleport.register(self.ctx, self.link)

    def call(self, tool: str, args: Any = None) -> Dict[str, Any]:
        raw = self.ctx.tools[tool]["handler"](args if args is not None else {})
        self.assertIsInstance(raw, str, "a tool handler must return a JSON string")
        return json.loads(raw)


class Registration(unittest.TestCase):
    def test_registers_four_tools_each_hidden_unless_the_app_is_there_and_no_hooks(self) -> None:
        plugin = load_plugin()
        ctx = FakeCtx()
        plugin.register(ctx)
        self.assertEqual(
            sorted(ctx.tools), ["hermoso_exits", "hermoso_return_home", "hermoso_teleport", "hermoso_where_am_i"]
        )
        self.assertEqual(ctx.hooks, [], "no approval hook: the person's yes is asked by the app, not by Hermes' gate")
        for name, tool in ctx.tools.items():
            self.assertEqual(tool["toolset"], "hermoso")
            self.assertTrue(callable(tool["check_fn"]), name)
            schema = tool["schema"]
            self.assertEqual(schema["name"], name)
            self.assertTrue(schema["description"])
            self.assertEqual(schema["parameters"]["type"], "object")
        self.assertEqual(ctx.tools["hermoso_teleport"]["schema"]["parameters"]["required"], ["country", "reason"])

    def test_the_first_sentence_says_it_all_because_that_is_all_the_hermes_catalog_lists(self) -> None:
        # Hermes defers a plugin's tools behind tool_search and lists each by its first sentence, clipped at 60 characters.
        plugin = load_plugin()
        ctx = FakeCtx()
        plugin.register(ctx)
        for name, tool in ctx.tools.items():
            first = tool["schema"]["description"].split(". ")[0].strip()
            self.assertLessEqual(len(first), 60, f"{name}: {first!r}")
            self.assertGreaterEqual(len(first), 20, name)

    def test_the_tools_are_hidden_when_no_app_is_running(self) -> None:
        plugin = load_plugin()
        ctx = FakeCtx()
        directory = Path(tempfile.mkdtemp(prefix="hermoso-plugin-test-"))
        self.addCleanup(shutil.rmtree, directory, True)
        plugin.teleport.register(ctx, plugin.bridge.Link(directory=directory))
        for name, tool in ctx.tools.items():
            self.assertFalse(tool["check_fn"](), name)

    def test_the_manifest_declares_what_the_plugin_registers(self) -> None:
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
        for name in ("hermoso_teleport", "hermoso_return_home", "hermoso_where_am_i", "hermoso_exits"):
            self.assertIn(name, manifest)
        self.assertIn("name: hermoso", manifest)
        self.assertNotIn("provides_hooks", manifest)

    def test_the_version_comes_from_the_manifest(self) -> None:
        plugin = load_plugin()
        self.assertRegex(plugin.__version__, r"^\d+\.\d+\.\d+$")


class FindingTheApp(unittest.TestCase):
    def setUp(self) -> None:
        self.plugin = load_plugin()
        self.dir = Path(tempfile.mkdtemp(prefix="hermoso-plugin-test-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write(self, text: str) -> None:
        (self.dir / ".bridge.json").write_text(text, encoding="utf-8")

    def test_reads_the_address_and_secret_the_app_published(self) -> None:
        self.write(json.dumps({"url": "http://127.0.0.1:5555/", "token": "abc"}))
        bridge = self.plugin.bridge.Bridge.from_file(self.dir)
        self.assertEqual(bridge.url, "http://127.0.0.1:5555")

    def test_a_missing_or_damaged_file_is_no_app(self) -> None:
        make = self.plugin.bridge.Bridge.from_file
        self.assertIsNone(make(self.dir))
        for text in ("", "{ not json", "[]", "null", json.dumps({"url": "http://127.0.0.1:5"}), json.dumps({"token": "t"})):
            self.write(text)
            self.assertIsNone(make(self.dir), text)

    def test_only_a_loopback_http_address_is_ever_used(self) -> None:
        make = self.plugin.bridge.Bridge.from_file
        for url in ("http://example.com:5", "https://127.0.0.1:5", "http://localhost:5", "http://127.0.0.2:5", "ftp://127.0.0.1:5"):
            self.write(json.dumps({"url": url, "token": "t"}))
            self.assertIsNone(make(self.dir), url)

    def test_a_file_with_a_byte_order_mark_is_fine(self) -> None:
        (self.dir / ".bridge.json").write_bytes(b"\xef\xbb\xbf" + json.dumps({"url": "http://127.0.0.1:5", "token": "t"}).encode())
        self.assertIsNotNone(self.plugin.bridge.Bridge.from_file(self.dir))


class Availability(Case):
    def test_available_when_a_hermoso_answers_with_this_secret(self) -> None:
        self.assertTrue(self.link.available())
        self.assertEqual(self.bridge.requests[-1]["path"], "/v1/hello?plugin=9.9.9")
        self.assertEqual(self.bridge.requests[-1]["auth"], "Bearer tok")

    def test_not_available_when_something_else_answers_or_nothing_does(self) -> None:
        self.bridge.answers[("GET", "/v1/hello")] = (200, {"ok": True, "app": "somebody-else"})
        self.assertFalse(self.plugin.bridge.Link(directory=self.dir).available())
        self.bridge.answers[("GET", "/v1/hello")] = (200, {"ok": False})
        self.assertFalse(self.plugin.bridge.Link(directory=self.dir).available())
        wrong = FakeBridge(token="other")
        self.addCleanup(wrong.close)
        wrong.publish(self.dir)
        wrong.token = "different"
        self.assertFalse(self.plugin.bridge.Link(directory=self.dir).available())

    def test_not_available_when_the_port_is_dead(self) -> None:
        gone = FakeBridge()
        gone.publish(self.dir)
        gone.close()
        self.assertFalse(self.plugin.bridge.Link(directory=self.dir).available())

    def test_the_answer_is_kept_for_a_few_seconds_so_the_app_is_not_asked_every_turn(self) -> None:
        link = self.plugin.bridge.Link(directory=self.dir)
        before = len(self.bridge.requests)
        for _ in range(5):
            self.assertTrue(link.available())
        self.assertEqual(len(self.bridge.requests) - before, 1)


class Teleport(Case):
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
        # the agent does not say who it is: the app knows that a request through the bridge is the agent's
        self.assertEqual(request["body"], {"country": "Germany", "reason": "compare\n prices", "minutes": 15})

    def test_a_city_is_passed_along_only_when_given(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (200, {"ok": True, "state": state()})
        self.call("hermoso_teleport", {"country": "de", "city": "Frankfurt", "reason": "x"})
        self.assertEqual(self.bridge.requests[-1]["body"]["city"], "Frankfurt")
        self.call("hermoso_teleport", {"country": "de", "reason": "x"})
        self.assertNotIn("city", self.bridge.requests[-1]["body"])

    def test_a_no_from_the_person_is_final_and_says_so(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/jump")] = (
            200,
            {"ok": False, "code": "denied", "message": "The user said no."},
        )
        result = self.call("hermoso_teleport", {"country": "de", "reason": "x"})
        self.assertEqual((result["ok"], result["error"]), (False, "denied"))
        self.assertIn("no", result["message"])

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
        before = len(self.bridge.requests)
        for args in ({}, {"country": ""}, {"country": "   "}, {"reason": "x"}):
            self.assertEqual(self.call("hermoso_teleport", args)["error"], "missing-country")
        self.assertEqual(len(self.bridge.requests), before)

    def test_a_door_that_refuses_the_secret_is_reported_not_raised(self) -> None:
        self.bridge.token = "changed"
        self.assertEqual(self.call("hermoso_teleport", {"country": "de", "reason": "x"})["error"], "unauthorized")

    def test_no_app_running_is_reported_not_raised(self) -> None:
        (self.dir / ".bridge.json").unlink()
        for tool, args in (
            ("hermoso_teleport", {"country": "de", "reason": "x"}),
            ("hermoso_return_home", {}),
            ("hermoso_where_am_i", {}),
            ("hermoso_exits", {}),
        ):
            result = self.call(tool, args)
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


class FollowingTheApp(Case):
    def test_a_backend_that_outlives_the_app_finds_the_next_one_by_itself(self) -> None:
        self.bridge.answers[("GET", "/v1/teleport/state")] = (200, {"ok": True, "state": state("France", 5)})
        self.assertEqual(self.call("hermoso_where_am_i")["country"], "France")

        # the app quits and starts again: a new port, a new secret, the same plugin instance
        self.bridge.close()
        second = FakeBridge(token="second-secret")
        self.addCleanup(second.close)
        second.answers[("GET", "/v1/teleport/state")] = (200, {"ok": True, "state": state("Sweden", 5)})
        second.publish(self.dir)
        self.assertEqual(self.call("hermoso_where_am_i")["country"], "Sweden")
        self.assertEqual(second.requests[-1]["auth"], "Bearer second-secret")

    def test_the_tools_disappear_when_the_app_quits_and_come_back_when_it_does(self) -> None:
        check = self.ctx.tools["hermoso_teleport"]["check_fn"]
        self.link._checked_at = 0.0
        self.assertTrue(check())
        (self.dir / ".bridge.json").unlink()
        self.link._checked_at = 0.0
        self.assertFalse(check())
        self.bridge.publish(self.dir)
        self.link._checked_at = 0.0
        self.assertTrue(check())


class OtherTools(Case):
    def test_return_home(self) -> None:
        self.bridge.answers[("POST", "/v1/teleport/home")] = (200, {"ok": True, "state": state(None, phase="idle")})
        result = self.call("hermoso_return_home")
        self.assertTrue(result["ok"])
        self.assertEqual(result["phase"], "idle")
        self.assertEqual(self.bridge.requests[-1]["body"], {})

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


if __name__ == "__main__":
    unittest.main(verbosity=1)
