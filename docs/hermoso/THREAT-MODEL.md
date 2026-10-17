# Hermoso threat model

Hermoso exists to protect a person who lets an AI agent work on their own computer. This page says what he protects,
from what, how, and, just as important, **where the protection stops**. If a limit is not written here or in the
window, treat that as a bug in the documentation and [tell us](../../.github/SECURITY.md).

Hermoso is a guard, not a vault. He catches honest mistakes and obvious attacks, makes the rest visible, and makes a
number of bad outcomes reversible. He does not make an agent safe to run against someone who is determined to get
past him, and nothing in this repository should be read as saying so.

- [What he protects](#what-he-protects)
- [What he protects it from](#what-he-protects-it-from)
- [What he does not try to do](#what-he-does-not-try-to-do)
- [How the pieces trust each other](#how-the-pieces-trust-each-other)
- [Protection by protection](#protection-by-protection)
- [When something goes wrong: fail open or fail closed](#when-something-goes-wrong-fail-open-or-fail-closed)
- [What Hermoso keeps, and what leaves the computer](#what-hermoso-keeps-and-what-leaves-the-computer)
- [How each claim is checked](#how-each-claim-is-checked)

## What he protects

| Asset | Why it matters |
| --- | --- |
| **Your network identity** (your real IP address and the place you connect from) | An agent browses, installs and calls APIs for you. Every one of those requests carries the address of whatever connection it leaves through. |
| **Your files** | The agent can read, write and delete as you. One wrong `rm -rf`, one `git reset --hard`, one overwritten document. |
| **Your secrets** (SSH keys, tokens, browser data, password stores) | They are readable by anything running as you, including a tool the agent was talked into running. |
| **How your computer is set up** (startup programs, system folders, installed software, the VPN itself) | Persistence for an attacker, or a silent loss of protection for you. |
| **Your privacy** (that a conversation happened at all) | Chats, memories, logs and snapshots are kept on disk by default. |
| **Your decisions** | Anything irreversible should be *your* call, made knowingly, not a side effect. |

## What he protects it from

In rough order of how often they actually happen:

1. **The agent's honest mistakes.** A destructive command with a wrong path; a "cleanup" that goes too far; a change you
   did not want. No malice needed.
2. **The VPN dropping without you noticing.** The tunnel goes down; the agent carries on; its traffic leaves on your
   real address.
3. **The agent being talked into something.** Text in a web page, a file, an issue or a tool result that tells the model
   to read your keys, fetch and run a script, upload a folder, install a program, add a startup entry, or switch your
   VPN off (*prompt injection*).
4. **Traces you did not want kept.** A conversation that should not exist afterwards.
5. **The agent's reach being wider than the task needs.** Hermoso adds friction exactly where the effects cannot be
   undone, and nowhere else.

## What he does not try to do

Said plainly, so nobody relies on him for these:

- **He is not a sandbox.** The agent still runs as you, with your permissions. Hermoso sits *between* the agent and a
  list of risky things; he does not confine the agent's process. For real isolation, run the agent in a container or a
  VM (Hermes supports several terminal backends).
- **He does not defend against a malicious model provider, a compromised Hermes, or malware on your computer.** Anything
  that already runs as you can read Hermoso's files and talk to his bridge. His protection is aimed at the agent, not at
  other software with the same rights.
- **He does not hide what you send to your model provider.** The provider sees your prompts and the agent's tool results,
  with or without Hermoso, with or without a ghost window, with or without the VPN (the VPN hides *where* you are, not
  *what* you say).
- **He does not guarantee anything about packets.** The radar samples; it is evidence, not proof that nothing leaked.
- **He does not protect against someone with access to your unlocked computer.**
- **He does not replace Hermes' own safety features.** Hermes has its own approval modes and sandbox backends. Hermoso is
  designed to be useful *even when those are switched off* (his consent window is his own, not Hermes' approval gate),
  and he does not weaken them.

## How the pieces trust each other

```
 window (renderer)  ──hermoso:call──▶  main process  ◀──loopback HTTP + token──  agent's plugin (Python)
 shows and asks                        decides, owns the                         recognises, holds,
 never decides                         machine and the files                     asks; never decides
```

- **One door from the window.** The window talks to the app's main process through a single IPC channel,
  `hermoso:call`, with named methods and checked parameters. There is no generic "run this" call.
- **One door from the agent.** The plugin talks to the app over `http://127.0.0.1:<port>` with a random bearer token,
  generated at every start of the app and written to `.bridge.json` inside the Hermes home the app prepared. The plugin
  refuses to talk to anything that is not on `127.0.0.1`. A backend that outlives the app finds no answer and behaves
  as described under [fail open or fail closed](#when-something-goes-wrong-fail-open-or-fail-closed).
- **The agent cannot answer for you.** A consent request is shown by Hermoso in his own window (or, if no window shows
  it within 1.5 seconds, in a native dialog). The bridge has no route that answers a request, and a request that names
  a rule can only *select* words from a fixed table: the text you read is never taken from what the agent sent. If you
  do not answer in two minutes the answer is **no**.
- **The agent cannot edit Hermoso.** Writing into Hermoso's own folders and files is a *block* rule: refused with no
  question, whether the guardian is switched on or off.
- **Hermoso edits as little of yours as possible.** He installs his plugin into the Hermes home and enables it with a
  comment-preserving edit of the plugin list. He does not touch your model, keys or settings. Time Machine is switched
  on through one environment variable the backend reads at start, not through your config file.

## Protection by protection

### Shield: the agent stands still while the VPN is down

**What it guarantees.** While you require the VPN (Settings → VPN: enabled, blocking, not waived) and the tunnel is not
up, the agent is held: it waits inside the call to the model, and every tool about to run waits up to 20 seconds and is
then refused with the reason. Nothing it was about to do is lost; it goes on by itself when the tunnel is back. A
deliberate Teleport reconnect is never counted as a drop.

**How.** The app decides from the VPN controller's state; the plugin only asks. It holds the agent at the two places
Hermes lets a plugin hold it: an `llm_execution` middleware that *waits* (a middleware that raises is skipped by Hermes,
so refusing is not a way to hold) and a `pre_tool_call` hook.

**Where it stops.**
- A request Hermes had already sent when the tunnel dropped is not recalled.
- If you press **Stop** during a freeze, Hermes sends the one request it was holding and cancels it.
- Hermes' own helper calls (titles, summaries) are not held.
- A model on your own computer or local network is deliberately not held: nothing that leaves the machine goes
  through it.
- The radar reads TCP connections of the app and its descendants every few seconds, through `netstat` and the process
  list. A connection that opens and closes between two looks is not seen, UDP is not listed, and it is **Windows
  only** at the moment.
- **The only hard wall is Mullvad's own "Always require VPN"** (it blocks all traffic whenever the tunnel is down). It
  is a switch in the Shield section. Without it, Hermoso reacts within seconds; with it, there is no gap.

### Guardian: a person stands between the agent and what cannot be undone

**What it guarantees.** There are fourteen kinds of risky thing. For twelve of them the agent waits for your answer
(allow once, always allow this kind, deny; no answer is a no): deleting many files, running something downloaded,
rewriting git history or discarding changes, installing software, reading passwords/keys/browser data, writing into the
SSH folder, writing files that run by themselves, changing how the computer is set up, writing into system folders,
sending files to another computer, switching off or changing your VPN, and changing the agent's own settings. The other
two are **never allowed, asked or not**: wiping a disk, and editing Hermoso's own files.

**How.** The plugin recognises the kind in a `tool_execution` middleware before the tool runs (a middleware, not a
hook: a hook is cut off at about 30 seconds and you may need longer; a middleware can answer in place of the tool). The
words you read come from one table shared by both halves, `guardian-rules.json`.

**Where it stops.** The rules are text patterns over the tool's arguments. **This is a net with holes, not a sandbox.**
A command assembled at run time, an encoded payload, a script the agent writes and then runs, a tool Hermoso does not
know, or another plugin's tool can get past a pattern. The test table pins down both sides (what must be caught *and*
what everyday commands must not trigger), but a pattern list cannot be complete. Treat "the guardian said nothing" as
"nothing it recognises", not as "safe".

### Time Machine: make the agent's file changes reversible

**What it guarantees.** Just before the agent first changes a file in a turn, Hermes saves a snapshot of the project
folder (Hermes' own checkpoint manager: a shadow git store outside your project). *Rewind* puts the files back: what
the agent changed is restored, what it created is removed, and **files you edited by hand since are kept, not
overwritten**. The chat is left as it is, so the agent still knows what it did.

**Where it stops.** Only the open project folder. Folders that are too broad (your whole home) or hold too many files
(over 50,000) are not snapshotted, and files over 10 MB are left out. It undoes *file changes*, not side effects:
network calls made, packages installed, databases changed, processes started. Hermes keeps snapshots off unless asked;
Hermoso asks by default (one environment variable, read when the backend starts), and the switch in the Time Machine
section turns that off from the next start.

### Ghost: a window that keeps nothing

**What it guarantees.** A second Hermoso window whose Hermes home and app data live in one temporary folder. Only what
it needs to talk to the model (your model setup, keys and VPN choice) is **copied** in; never your chats, memories or
logs. What the ghost does lives in that folder and nowhere else, and the folder is deleted by the panic key
(`Ctrl+Alt+Shift+Backspace`) or button, by an ordinary close, and by a sweep at the next start for a folder nobody
owns (the computer went off first). Every deletion goes through one guard: only a direct child of the temporary root,
named like a ghost's, and a real folder.

**Where it stops.**
- *Deleted is not shredded.* A solid-state disk, the page file, hibernation, indexing and backups may keep traces.
- Your model's provider still sees what you send it.
- Files the agent writes into a project folder stay there.
- A ghost keeps nothing of the conversation *on this computer*; it is not anonymity.

### Teleport: change the exit country, for a while, and come back by itself

**What it guarantees.** Moves the Mullvad exit to another country for 1–60 minutes (10 by default). The way home is
written down *before* anything moves, survives a crash and a quit, and is followed at launch. An agent that asks for a
trip waits for your yes, in Hermoso's window, every time (unless you said "always" for that country; that can be taken
back).

**Where it stops.** It moves your whole computer's exit, not only the agent's. It changes where Mullvad exits, not what
a site learns from your account, cookies, browser geolocation or your language.

### Aura: for fun

Points and a level computed from the counters Hermoso keeps anyway. It changes nothing and protects nothing; it is here
because a guard with no glow is no fun.

## When something goes wrong: fail open or fail closed

| Situation | What happens | Why |
| --- | --- | --- |
| The agent runs **without a Hermoso app** (the official Hermes app, a terminal, cron) | The plugin does nothing; its tools are hidden from the model | There is nobody to ask and no VPN gate to honour; the plugin must not break other ways of running Hermes |
| The app **was there and stops answering** while a risky action waits | The risky action is **refused** | It can no longer be put to you |
| You **do not answer** within two minutes | **No** | Silence is not consent |
| **Guardian switched off** | Nothing is asked, but the *never allowed* rules still refuse | Wiping a disk and editing Hermoso's own files are not options |
| **VPN not required** in settings | The shield does not freeze anything | It only enforces what you asked for |
| The **VPN controller cannot tell** the tunnel state | Treated as "not up" while the VPN is required | A wrong "up" would be the dangerous answer |
| A **middleware raises** inside Hermes | Hermes skips it (fails open) | Hermoso therefore never refuses by raising: it returns a value or waits |
| A **trip** is interrupted (crash, quit, power) | The record written before the jump brings you home at the next launch | The way home exists before the way out |

## What Hermoso keeps, and what leaves the computer

Hermoso keeps four small files under the app's data folder, in `hermoso/`:

| File | Content |
| --- | --- |
| `teleport.json` | The trip in progress and where home is (removed when you are home) |
| `consent.json` | What you said "always allow" to, so it can be listed and taken back |
| `settings.json` | Your switches: guardian on/off, Time Machine on/off |
| `stats.json` | Counters (freezes, questions asked, refusals, rewinds, ghosts, teleports) and your last guardian decisions; the memory behind Aura |

**Nothing leaves your computer because of Hermoso.** He has no telemetry, no analytics and no network calls of his own:
the only network he speaks is `127.0.0.1` between the app and the plugin, plus the Mullvad command-line tool on your own
machine. What Hermes sends to your model provider is exactly what it would send without him.

## How each claim is checked

Every behaviour above has a test that fails if it stops being true, at three levels:

1. **Unit tests** of each piece against fakes: the shield's verdict, the radar's parsing and judging, the ledger, the
   guardian's rule table (what must be caught and what must not), consent, the bridge, the trip file, the ghost's
   deletion guard, Aura's arithmetic, the window's panels.
2. **End to end with the real agent**: a real Hermes backend, a scripted model that tries things, and a scripted
   `mullvad` command-line tool that records what actually moved. They prove, for instance, that nothing moves until you
   say yes, that a refused file is never written, that a held agent sends nothing until the tunnel is back, that a
   rewind restores and removes the right files, and that a ghost's chat is found only in the ghost's folder and nowhere
   in the main window's home.
3. **Real runs against real Mullvad** in a sandbox profile, with the packaged `.exe`: the freeze, the radar and the
   report were checked with the real tunnel going down and up.

What is **not** covered: macOS and Linux (Hermoso's radar and the ghost's cleaner are written for Windows), other VPNs,
long-running soak tests, and adversarial testing by a professional red team. If you do that, please
[tell us what you found](../../.github/SECURITY.md).
