# Security policy

Hermoso exists to protect people who run an AI agent on their own computer, so a hole in Hermoso is exactly the kind of
bug we want to hear about. He is also **young and unaudited**: assume there are bugs, and help us find them.

Read the [threat model](../docs/hermoso/THREAT-MODEL.md) first. It says what each protection guarantees and where it
stops, so you know which behaviour is a known limit and which is a bug.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Go to the **Security** tab of this repository and choose **Report a vulnerability** (GitHub's private reporting).
2. Say what you found, how to reproduce it (the smaller the better), the version or commit, and what you think the
   impact is.

This is a one-person volunteer project, so there are no fixed response times: reports are read as soon as possible, and
you will be told what is thought of yours (a bug, or a known limit, in which case the answer points at where it is
written) and what will be done about it. Fixes come as soon as they can. Nothing that mentions you is published without
asking you first, and you are credited if you wish.

## What counts as a vulnerability in Hermoso

A bug where Hermoso fails to do what the [threat model](../docs/hermoso/THREAT-MODEL.md) says, or says something that is
not true. For example:

- **Consent.** The agent (or anything other than the person) can answer a consent request, can make Hermoso show words
  of its own instead of the fixed table, or can get a risky action done without the question being asked, while the
  guardian is on.
- **Self-protection.** The agent can read or change Hermoso's own files, or get past a *never allowed* rule.
- **The bridge.** Someone other than the agent's plugin can use the loopback bridge (a missing or weak token check, a
  token that leaks into a log or a URL, a route that does more than documented, a way in from a web page).
- **Shield.** The agent keeps running (a request reaches the model, a tool runs) while Hermoso says it is frozen; or the
  radar reports a clean machine while a connection leaves outside the tunnel.
- **Ghost.** Any way for a ghost to delete something that is not its own folder; a chat of the main window found in a
  ghost, or a ghost's chat found in the main window's home or data; a folder left behind after panic or a normal close.
- **Time Machine.** A rewind that deletes or overwrites something the person edited by hand, or something outside the
  project folder.
- **Teleport.** A trip that does not bring the person home, or a way to leave the computer's Mullvad settings different
  from how they were found.
- **Honesty.** A screen, message or document that claims more than the code does.

## Bypasses of the guardian's patterns

The guardian recognises risky actions by **patterns** and is documented as a net with holes. A command that gets past a
pattern is therefore not a surprise, **but we still want it**: send the exact tool call that slipped through. Each one
becomes a row in the test table (what must be caught), after a fix window.

## Out of scope

- Vulnerabilities in **Hermes Agent or Hermes Desktop themselves**: report them to
  [Nous Research](https://github.com/NousResearch/hermes-agent/security).
- Vulnerabilities in **Mullvad VPN**: report them to Mullvad VPN AB.
- Anything that needs **malware already running with the user's rights**, or a person with access to an unlocked
  computer. Hermoso protects the person from the agent, not the computer from other software.
- A **model provider** seeing what you send it, and *deleted is not shredded* (a ghost's folder is deleted, not wiped
  from the disk): both are stated limits.
- Findings that need **disabling a protection first** (for example, with the guardian switched off, a risky action goes
  through: that is what the switch means. The *never allowed* rules still hold, and a bypass of those is in scope).

## Supported versions

Only the latest release and the `hermoso` branch get fixes.

## Verifying what you download

The Windows installer is **not code-signed**, so Windows SmartScreen shows "Unknown publisher". Every release lists the
SHA-256 of its installer: compare it with `Get-FileHash` before you run it, or build from source and compare nothing at
all.
