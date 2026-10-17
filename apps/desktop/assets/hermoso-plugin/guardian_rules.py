"""The guardian's rules: what counts as a risky thing for the agent to do.

Pure functions, no network and no Hermes imports, so every rule has a test. ``review(tool, args)`` looks at what the
agent is about to run or write and answers ``None`` (nothing to worry about) or one ``Finding``:

* level ``ask``: the person is asked, in Hermoso, before it happens ("allow once", "always allow this kind", "deny");
* level ``block``: it is refused with no question: the agent has no reason to do it (wiping a drive, editing the
  file that holds the person's own answers).

The words the person reads (title, why, level) are NOT written here: they live in ``guardian-rules.json``, which the
Hermoso app reads too, so the agent never chooses what the person is told. This module only recognises the rule.

The rules look at text, so they are a net with holes, not a sandbox: a determined program can always find a way
around a pattern. They exist to catch the honest mistakes and the obvious attacks, and to put a person between the
agent and the few actions that cannot be undone. Anything not recognised is let through.
"""

from __future__ import annotations

import json
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Pattern, Tuple

# A command line longer than this is read only in part: a pattern never has to chew a whole file.
MAX_LINE = 4000
MAX_TEXT = 60000
DETAIL_LIMIT = 300

TABLE_FILE = Path(__file__).resolve().parent / "guardian-rules.json"


def load_table() -> Dict[str, Dict[str, str]]:
    """The words and levels, from guardian-rules.json. A missing or damaged file leaves the table empty: every rule
    then asks, in generic words, which is the safe way to be wrong."""
    try:
        data = json.loads(TABLE_FILE.read_text(encoding="utf-8-sig"))
        rules = data.get("rules") if isinstance(data, dict) else None
        return {k: v for k, v in rules.items() if isinstance(v, dict)} if isinstance(rules, dict) else {}
    except (OSError, ValueError):
        return {}


TABLE = load_table()


@dataclass(frozen=True)
class Finding:
    rule: str  # stable id: "always allow this kind" is remembered under it
    level: str  # "ask" | "block"
    title: str  # short noun phrase, shown on the "always allow" button
    why: str  # one plain sentence about the danger
    detail: str  # the command or path, clipped

    def as_json(self) -> Dict[str, str]:
        return {"rule": self.rule, "level": self.level, "title": self.title, "why": self.why, "detail": self.detail}


def _finding(rule: str, detail: str) -> Finding:
    meta = TABLE.get(rule, {})
    level = meta.get("level") if meta.get("level") in ("ask", "block") else "ask"
    return Finding(
        rule=rule,
        level=str(level),
        title=str(meta.get("title") or "Something risky"),
        why=str(meta.get("why") or "the guardian flagged it as risky"),
        detail=_clip(detail),
    )


def _re(pattern: str) -> Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


# One simple command: the stretch between separators, so a pattern about `rm` never reads past `&&`.
_CMD = r"[^;&|\n]*"
_END = r"(?=\s|$|;|&|\||\)|\"|')"
# Where a command can begin: the line, after a separator, after `cmd /c`, after `sudo`.
_START = r"(?:^|[;&|(]|\bcmd(?:\.exe)?\s+/[ck]\s+|\bsudo\s+)\s*"

# ── shell rules ─────────────────────────────────────────────────────────────────────────────────────

_ROOT_TARGET = r"(?:/\*?|~/?|\$home/?|\$\{home\}/?|%userprofile%\\?|\$env:userprofile\\?|[a-z]:[\\/]?\*?)"

CATASTROPHIC: List[Pattern[str]] = [
    _re(r"\brm\b" + _CMD + r"\s-[a-z]*r[a-z]*\b" + _CMD + r"\s['\"]?" + _ROOT_TARGET + r"['\"]?" + _END),
    _re(r"\brm\b" + _CMD + r"\s['\"]?" + _ROOT_TARGET + r"['\"]?\s+" + _CMD + r"-[a-z]*r[a-z]*\b"),
    _re(r"\b(?:rd|rmdir)\b" + _CMD + r"\s/s\b" + _CMD + r"\s['\"]?[a-z]:\\?['\"]?" + _END),
    _re(r"\bdel(?:ete)?\b" + _CMD + r"\s/[sq]\b" + _CMD + r"\s['\"]?[a-z]:\\\*?['\"]?" + _END),
    _re(
        r"\bremove-item\b(?=" + _CMD + r"-recurse)" + _CMD
        + r"\s['\"]?(?:[a-z]:\\?|\$home|\$env:userprofile|~)['\"]?" + _END
    ),
    _re(_START + r"format(?:\.com)?\s+[a-z]:"),
    _re(r"\bdiskpart\b"),
    _re(r"\bmkfs(?:\.\w+)?\b"),
    _re(r"\bdd\b" + _CMD + r"\bof=/dev/(?:sd|nvme|hd|vd|disk|mmcblk)"),
    _re(r"\bcipher\s+/w"),
    _re(r"\bvssadmin\b" + _CMD + r"\bdelete\s+shadows"),
    _re(r"\bwbadmin\b" + _CMD + r"\bdelete\b"),
    _re(r"\bbcdedit\b" + _CMD + r"\s/(?:delete|set)\b"),
]

# Touching Hermoso's own state (the person's answers, the trip file, the way the plugin finds the app) is never the
# agent's business: editing it would forge a yes.
TAMPER_HERMOSO = _re(r"(?:[\\/]hermoso[\\/][\w.-]*\.json|\.bridge\.json|[\\/]plugins[\\/]hermoso\b)")

# The order matters where two rules could both match: the specific one comes first (stopping the VPN's service is
# "vpn-tamper", not just "system-change").
ASK_SHELL: List[Tuple[str, Pattern[str]]] = [
    (
        "vpn-tamper",
        _re(
            r"\bmullvad(?:\.exe)?\b" + _CMD + r"\b(?:disconnect|lockdown-mode\s+set\s+off|auto-connect\s+set\s+off"
            r"|account\s+logout|relay\s+set|reconnect|lan\s+set|obfuscation|split-tunnel|dns\s+set|always-require-vpn)\b"
            r"|\b(?:sc|net)(?:\.exe)?\s+(?:stop|config|delete)\s+[\"']?mullvad|\btaskkill\b" + _CMD
            + r"(?:mullvad|openvpn|wireguard|nordvpn|protonvpn|expressvpn)|\bstop-service\b" + _CMD
            + r"(?:mullvad|openvpn|wireguard)"
            r"|\bnetsh\s+interface\s+set\s+interface\b" + _CMD + r"mullvad|\bdisable-netadapter\b" + _CMD + r"mullvad"
            r"|\bwireguard(?:\.exe)?\s+/uninstalltunnelservice"
        ),
    ),
    (
        "delete-many",
        _re(
            r"(?:\brm\b" + _CMD + r"\s-[a-z]*r|\b(?:rd|rmdir)\b" + _CMD + r"\s/s\b|\bdel(?:ete)?\b" + _CMD + r"\s/s\b"
            r"|\bremove-item\b" + _CMD + r"-recurse|\bfind\b" + _CMD + r"\s-delete\b|\bgit\s+clean\b" + _CMD
            + r"\s-[a-z]*[fd]|\bshred\b|\bsrm\b|\brobocopy\b" + _CMD + r"/(?:mir|purge)\b)"
        ),
    ),
    (
        "git-destructive",
        _re(
            r"\bgit\s+push\b" + _CMD + r"\s(?:--force(?:-with-lease)?|-f)\b"
            r"|\bgit\s+reset\s+--hard\b|\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)|\bgit\s+restore\b" + _CMD + r"\s\.(?:\s|$)"
            r"|\bgit\s+branch\s+(?-i:-D)\b|\bgit\s+stash\s+(?:drop|clear)\b|\bgit\s+filter-(?:branch|repo)\b"
            r"|\bgit\s+reflog\s+expire\b|\bgit\s+gc\s+--prune=now\b"
        ),
    ),
    (
        "download-and-run",
        _re(
            r"\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b" + _CMD + r"\|\s*(?:sudo\s+)?"
            r"(?:sh|bash|zsh|python[\d.]*|node|iex|invoke-expression|powershell(?:\.exe)?|pwsh)\b"
            r"|\b(?:iex|invoke-expression)\b" + _CMD + r"(?:downloadstring|webrequest|\birm\b|\biwr\b|\bcurl\b)"
            r"|\bcertutil\b" + _CMD + r"-urlcache|\bbitsadmin\b" + _CMD + r"/transfer"
            r"|\b(?:sh|bash)\s+-c\s+[\"']?\$\(\s*(?:curl|wget)"
            r"|\bpowershell(?:\.exe)?\b" + _CMD + r"\s-(?:enc|encodedcommand)\s+[a-z0-9+/=]{20,}"
            r"|\bmshta\b\s+https?:|\brundll32\b" + _CMD + r"javascript:|\bbase64\s+-d\b" + _CMD + r"\|\s*(?:sh|bash)\b"
        ),
    ),
    (
        "secrets",
        _re(
            r"\bmimikatz\b|\blsass\b|\bntds\.dit\b|\bvaultcmd\b|\bcmdkey\s+/list\b|\breg\s+save\s+hklm\\sam\b"
            r"|\bsecurity\s+find-generic-password\b|/etc/shadow\b|\bget-credential\b"
            r"|\b(?:cat|type|more|less|head|tail|get-content|gc|cp|copy|xcopy|robocopy|tar|zip|7z|compress-archive|scp"
            r"|rsync|base64|sqlite3|strings|findstr|grep|select-string|rg|xxd|od|certutil)\b" + _CMD
            + r"(?:\.ssh[\\/]|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws[\\/]credentials|\.kube[\\/]config|\.npmrc|\.pypirc"
            r"|\.netrc|\.git-credentials|\.docker[\\/]config\.json|[\\/]login data|[\\/]cookies(?:\.sqlite)?\b"
            r"|\bkey[34]\.db\b|\blogins\.json\b|\.gnupg[\\/]|\bwallet\.dat\b|\.hermes[\\/]\.env|[\\/]hermes[\\/]\.env\b"
            r"|[\\/]hermes[\\/]auth\.json)"
        ),
    ),
    (
        "upload",
        _re(
            r"\bcurl\b" + _CMD + r"\s(?:(?-i:-F|-T)(?=[\s=]|$)|--form\b|--upload-file\b|--data-binary\s+@|-d\s*@|--data\s+@)"
            r"|\bwget\b" + _CMD + r"--post-file|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b" + _CMD + r"-infile\b"
            r"|\bscp\b" + _CMD + r"\s\S+:\S*|\brsync\b" + _CMD + r"\s\S+@\S+:|\b(?:nc|ncat|netcat)\b" + _CMD + r"\s(?:-e\b|<)"
            r"|/dev/tcp/|\btftp\b|\bsend-mailmessage\b|\bsendmail\b"
        ),
    ),
    (
        "system-change",
        _re(
            r"\breg(?:\.exe)?\s+(?:add|delete|import)\b|\bschtasks\b" + _CMD + r"/(?:create|change)\b"
            r"|\bsc(?:\.exe)?\s+(?:create|config|delete|stop)\b|\bnetsh\b" + _CMD + r"\b(?:advfirewall|interface|winhttp)\b"
            r"|\bset-executionpolicy\b|\bnew-service\b|\bset-mppreference\b|\badd-mppreference\b" + _CMD + r"exclusion"
            r"|\btakeown\b|\bicacls\b" + _CMD + r"/grant\b|\bnet\s+(?:user|localgroup)\b|\bsudo\b|\bchmod\s+-r\s+7[0-7]7"
            r"|\bchown\s+-r\b|\bcrontab\b|\bsystemctl\b" + _CMD + r"\b(?:enable|disable|mask|stop)\b"
            r"|currentversion[\\/]run\b|\\start menu\\programs\\startup|\bwmic\b" + _CMD + r"\bcall\b"
        ),
    ),
    (
        "install-software",
        _re(
            r"\b(?:winget|choco|scoop)\s+install\b|\bnpm\s+(?:i|install|add)\b" + _CMD + r"\s(?:-g|--global)\b"
            r"|\bpip3?\s+install\b" + _CMD
            + r"(?:git\+|https?://|\.zip\b|\.tar\.gz\b|\.whl\b|--index-url|--extra-index-url|\s-i\s+http)"
            r"|\bnpm\s+(?:i|install)\b" + _CMD + r"(?:github:|git\+|https?://)|\bmsiexec\b"
            r"|\bstart-process\b" + _CMD + r"-verb\s+runas"
        ),
    ),
]

# `rm -rf node_modules` and friends are what a build does every day: not worth a question.
_REGENERABLE = frozenset(
    {
        "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "dist", "build", "out",
        "target", ".next", ".nuxt", ".turbo", ".parcel-cache", "coverage", ".coverage", "htmlcov", ".tox", ".venv",
        "venv", ".gradle", "tmp", "temp",
    }
)

_RM = _re(r"^\s*(?:sudo\s+)?rm\s+(.*)$")


def _only_regenerable(command: str) -> bool:
    """True for `rm -rf <build output> ...` where every target is a folder a build recreates."""
    match = _RM.match(command)
    if not match:
        return False
    targets = [token for token in match.group(1).split() if not token.startswith("-")]
    if not targets:
        return False
    for target in targets:
        cleaned = target.strip("'\"")
        if cleaned.startswith(("/", "~", "$")) or ".." in cleaned.split("/") or re.match(r"^[a-z]:", cleaned, re.I):
            return False
        name = posixpath.basename(cleaned.rstrip("/\\")).lower()
        if name not in _REGENERABLE and not name.endswith(".egg-info"):
            return False
    return True


# ── writing files ───────────────────────────────────────────────────────────────────────────────────

_PATHS: List[Tuple[str, Pattern[str]]] = [
    ("hermoso-tamper", TAMPER_HERMOSO),
    (
        "system-files",
        _re(
            r"^[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata)[\\/]|[\\/]system32[\\/]"
            r"|^/(?:etc|usr|bin|sbin|boot|lib|lib64|opt|var/lib)/|^/system/"
        ),
    ),
    (
        "startup-files",
        _re(
            r"start menu[\\/]programs[\\/]startup|\.config[\\/]autostart|[\\/]launchagents[\\/]|[\\/]launchdaemons[\\/]"
            r"|[\\/]\.(?:bashrc|bash_profile|zshrc|profile|zprofile)$|[\\/](?:microsoft\.)?powershell_profile\.ps1$"
            r"|[\\/]profile\.ps1$|[\\/]\.git[\\/]hooks[\\/]"
        ),
    ),
    ("ssh-files", _re(r"[\\/]\.ssh[\\/]")),
    ("agent-config", _re(r"[\\/]\.?hermes[\\/](?:config\.yaml|\.env|auth\.json|plugins[\\/]|hooks[\\/])")),
]


def _clip(text: str, limit: int = DETAIL_LIMIT) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _lines(text: Any) -> Iterable[str]:
    if not isinstance(text, str):
        return
    for line in text[:MAX_TEXT].splitlines():
        line = line.strip()
        if line:
            yield line[:MAX_LINE]


def review_command(command: Any) -> Optional[Finding]:
    """A shell command (or several lines of them)."""
    lines = list(_lines(command))
    for line in lines:
        if TAMPER_HERMOSO.search(line):
            return _finding("hermoso-tamper", line)
        if any(pattern.search(line) for pattern in CATASTROPHIC):
            return _finding("catastrophic", line)
    for line in lines:
        for rule, pattern in ASK_SHELL:
            if not pattern.search(line):
                continue
            if rule == "delete-many" and _only_regenerable(line):
                continue
            return _finding(rule, line)
    return None


_PYTHON_DANGER = _re(r"\bshutil\.rmtree\(|\bos\.removedirs\(")


def review_code(code: Any) -> Optional[Finding]:
    """Python the agent is about to run: the shell rules on its text (it can call a shell), plus the few
    destructive calls that have no shell spelling."""
    found = review_command(code)
    if found is not None:
        return found
    for line in _lines(code):
        if _PYTHON_DANGER.search(line):
            return _finding("delete-many", line)
    return None


def review_path(path: Any) -> Optional[Finding]:
    """A file the agent is about to create or overwrite."""
    if not isinstance(path, str) or not path.strip():
        return None
    text = path.strip().replace("\\\\", "\\")
    for rule, pattern in _PATHS:
        if pattern.search(text):
            return _finding(rule, text)
    return None


_PATCH_FILE = _re(r"^\*{3}\s*(?:Update|Add|Delete|Move to)\s+File:\s*(.+)$")


def _patch_paths(args: Dict[str, Any]) -> List[str]:
    paths = []
    if isinstance(args.get("path"), str):
        paths.append(args["path"])
    for line in _lines(args.get("patch")):
        match = _PATCH_FILE.match(line)
        if match:
            paths.append(match.group(1).strip())
    return paths


_REVIEWERS: Dict[str, Callable[[Dict[str, Any]], Optional[Finding]]] = {
    "terminal": lambda args: review_command(args.get("command")),
    "execute_code": lambda args: review_code(args.get("code")),
    "write_file": lambda args: review_path(args.get("path")),
    "patch": lambda args: next((f for f in (review_path(p) for p in _patch_paths(args)) if f), None),
}


def review(tool_name: str, args: Any) -> Optional[Finding]:
    """What the guardian makes of one tool call. Never raises: a rule that cannot read its input lets it through."""
    reviewer = _REVIEWERS.get(tool_name)
    if reviewer is None or not isinstance(args, dict):
        return None
    try:
        return reviewer(args)
    except Exception:
        return None
