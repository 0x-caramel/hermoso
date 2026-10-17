"""The plugin's side of the bridge to the Hermoso desktop app.

While Hermoso runs, it writes its address and a fresh secret into ``.bridge.json`` next to this plugin (inside
the Hermes home it prepared) and removes the file when it quits. The plugin reads that file every time it needs
the app, so it follows the app across restarts: a backend that outlives the app that started it, or one started
by another program sharing this Hermes home, finds the new app by itself. When no Hermoso is running there is no
file, or nothing answers at the address in it: the plugin's tools are then hidden from the model (see
``available``), which is what keeps it out of the way in the official Hermes app and in a terminal.

Every call is plain JSON over HTTP on 127.0.0.1 with a bearer token. Nothing here ever raises into the agent: a
failure is a ``BridgeError`` with a short machine-readable ``code``, which the tools turn into a JSON answer.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

BRIDGE_FILE = ".bridge.json"

# A jump waits for the person to answer (up to two minutes) and then for the tunnel to come up in another country
# (up to 30 s in the app), so a call may legitimately take a while.
DEFAULT_TIMEOUT = 180.0

# How long "the app answered" stays true: the model's tool list is built often, the app must not be asked each time.
AVAILABLE_FOR = 15.0


class BridgeError(Exception):
    """The app did not give an answer: unreachable, refused, or an error from the other side."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


class Bridge:
    def __init__(self, url: str, token: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.url = url.rstrip("/")
        self._token = token
        self.timeout = timeout
        # Never through a proxy: this is a loopback call, and a system proxy would only break (or snoop on) it.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def from_file(cls, directory: Optional[Path] = None, timeout: float = DEFAULT_TIMEOUT) -> Optional["Bridge"]:
        """The bridge the running app published next to the plugin, or None when there is none (or it is damaged)."""
        folder = directory if directory is not None else Path(__file__).resolve().parent
        try:
            data = json.loads((folder / BRIDGE_FILE).read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return None
        url = str(data.get("url") or "").strip() if isinstance(data, dict) else ""
        token = str(data.get("token") or "").strip() if isinstance(data, dict) else ""
        if not url.startswith("http://127.0.0.1:") or not token:
            return None
        return cls(url, token, timeout)

    def get(self, path: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        return self._call("GET", path, None, timeout)

    def post(self, path: str, body: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
        return self._call("POST", path, body or {}, timeout)

    def _call(self, method: str, path: str, body: Optional[Dict[str, Any]], timeout: Optional[float]) -> Dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method)
        request.add_header("Authorization", "Bearer " + self._token)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(request, timeout=timeout or self.timeout) as response:
                return self._decode(response.read())
        except urllib.error.HTTPError as error:
            # The app answers refusals with {"ok": false, "code": ...}; surface its code, not the HTTP detail.
            code = "http-%d" % error.code
            try:
                code = str(self._decode(error.read()).get("code") or code)
            except BridgeError:
                pass
            raise BridgeError(code, "the Hermoso app refused the request (%s)" % code) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            raise BridgeError("unreachable", "the Hermoso app did not answer (%s)" % (error,)) from None

    @staticmethod
    def _decode(raw: bytes) -> Dict[str, Any]:
        try:
            value = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            raise BridgeError("bad-response", "the Hermoso app sent something that is not JSON") from None
        if not isinstance(value, dict):
            raise BridgeError("bad-response", "the Hermoso app sent something that is not an object")
        return value


class Link:
    """What the tools hold: finds the running app each time, and says whether it is there."""

    def __init__(self, directory: Optional[Path] = None, version: str = "") -> None:
        self.directory = directory
        self.version = version
        self._checked_at = 0.0
        self._answered = False

    def bridge(self) -> Optional[Bridge]:
        return Bridge.from_file(self.directory)

    def require(self) -> Bridge:
        bridge = self.bridge()
        if bridge is None:
            raise BridgeError("unreachable", "the Hermoso app is not running")
        return bridge

    def hello(self, bridge: Optional[Bridge] = None) -> bool:
        """Ask the app who it is. True only for a Hermoso that answers with this secret."""
        bridge = bridge or self.bridge()
        if bridge is None:
            return False
        try:
            reply = bridge.get("/v1/hello?plugin=%s" % self.version, timeout=2.0)
        except BridgeError:
            return False
        return reply.get("ok") is True and reply.get("app") == "hermoso"

    def available(self) -> bool:
        """The tools' ``check_fn``: show them to the model only while a Hermoso is running (cached briefly)."""
        now = time.monotonic()
        if now - self._checked_at < AVAILABLE_FOR:
            return self._answered
        self._answered = self.hello()
        self._checked_at = now
        return self._answered
