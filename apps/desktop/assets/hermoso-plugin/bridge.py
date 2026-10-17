"""The plugin's side of the bridge to the Hermoso desktop app.

The app listens on 127.0.0.1 (a port the system picked) and hands the backends it starts two environment
variables: ``HERMOSO_BRIDGE_URL`` and ``HERMOSO_BRIDGE_TOKEN``. Without them this plugin is inert: the backend
was not started by Hermoso (the official Hermes sharing this data folder, a cron job, a terminal), and there
is nothing to talk to.

Every call is plain JSON over HTTP with a bearer token. Nothing here ever raises into the agent: a failure is a
``BridgeError`` with a short machine-readable ``code``, which the tools turn into a JSON answer.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

# A jump waits for the tunnel to come up in another country (up to 30 s in the app) and a return too.
DEFAULT_TIMEOUT = 75.0


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
    def from_env(cls, env: Optional[Dict[str, str]] = None) -> Optional["Bridge"]:
        source = os.environ if env is None else env
        url = (source.get("HERMOSO_BRIDGE_URL") or "").strip()
        token = (source.get("HERMOSO_BRIDGE_TOKEN") or "").strip()
        if not url or not token or not url.startswith("http://127.0.0.1:"):
            return None
        return cls(url, token)

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
