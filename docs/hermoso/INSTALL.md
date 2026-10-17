# Install Hermoso (Windows)

Five minutes, no command line. Hermoso is **Windows 10/11 only** for now.

## What you need

| | |
| --- | --- |
| **A Windows 10 or 11 PC** (64-bit) | The installer is per-user: it does not ask for an administrator password. |
| **The internet, the first time** | Hermoso installs the Hermes runtime itself on first start (a few minutes). |
| **[Mullvad VPN](https://mullvad.net)** installed, with an account logged in | Needed for the VPN gate, the Shield and Teleport. Guardian, Time Machine and Ghost work without it, and you can start without the VPN once ("Continue without VPN") or switch the requirement off in *Settings → VPN*. |

## 1. Download

Go to the **Releases** page of this repository and download `Hermoso-Setup-<date>.exe`.

Optional but recommended: check that you got the file that was published. In PowerShell, in the folder you downloaded it to:

```powershell
Get-FileHash .\Hermoso-Setup-<date>.exe -Algorithm SHA256
```

The hash must match the one in the release notes.

## 2. Install

1. Double-click the `.exe`.
2. **Windows SmartScreen says "Unknown publisher".** That is normal: the installer is not code-signed (a signing
   certificate costs money, and this is a small project). Click **More info**, then **Run anyway**.
3. It installs in a few seconds, and adds **Hermoso** to the Start Menu and the Desktop.

Hermoso lives next to the official Hermes, not on top of it: he has his own name, icon and taskbar button, and the
official Hermes keeps starting untouched. **Both use the same profile, so close one before you open the other.**

## 3. First start

1. Start Menu → **Hermoso**.
2. He connects Mullvad for you and holds the agent back until the tunnel is up. (No Mullvad? Choose *Continue without
   VPN*.)
3. On a computer that has never had Hermes you may see a card **"Set up Hermes Desktop"**: choose **Install Hermes
   locally** and wait a few minutes. Then pick your model provider, like in Hermes.
4. If you already use Hermes, you will find your chats, keys and settings as they were: same profile.

## 4. Your first five minutes

Open **Hermoso** in the left bar. One section per protection, Aura on top.

| You want to… | Do this |
| --- | --- |
| See the agent stop when the VPN drops | In the Mullvad app press *Disconnect*. The chip at the bottom right says "Frozen · VPN down" and the agent waits. Press *Connect* and it goes on by itself. |
| Make a leak impossible | Shield → switch **Always require VPN** on (Mullvad then blocks all traffic whenever the tunnel is down). Switch it off if you lose the internet and do not want that. |
| Be asked before something risky | Nothing to do: it is on. Ask the agent to write a file in `.git\hooks` or to delete a folder, and a dialog asks you first. **Deny** and nothing happens. |
| Undo what the agent did to your files | Open a chat in a **project folder** (not your whole home). Time Machine lists a snapshot for every turn that changed files: **See changes**, then **Rewind to here**. Files you edited yourself are kept. |
| Chat without leaving a trace | Ghost → **Open a ghost window**. Everything lives in a temporary folder. **Panic** (or `Ctrl+Alt+Shift+Backspace`) deletes it and closes the window. |
| Look like you are somewhere else for a while | Teleport → pick a country → **Teleport**. It comes back by itself (10 minutes by default) or press **Return home**. |
| Watch the glow grow | Aura, on top of the page and in the status bar. Just for fun. |

Every section says, in plain words, what it does **not** do. The long version is the
[threat model](THREAT-MODEL.md): read it once.

## Settings you may want

- **Guardian** and **Time Machine** each have a switch in their section. (With the guardian off, wiping a disk and editing
  Hermoso himself are still never allowed.) Time Machine applies from the next start.
- **VPN**: *Settings → VPN*. "Use Mullvad VPN", "Wait for the VPN before starting", and the country to connect to.

## Update

New versions come as a new installer. Run it over the old one: your data stays.

## Uninstall

*Settings → Apps → Hermoso*. Your data stays in `%LOCALAPPDATA%\hermes` (shared with Hermes); delete that folder by hand
if you want it gone too.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Set up Hermes Desktop" | First time on this PC: **Install Hermes locally**. |
| It waits for the VPN and never starts | Mullvad is not installed or not logged in. Install it and sign in, or choose **Continue without VPN**. |
| It does not open, or opens the other app | Hermes and Hermoso share one profile: close the other one first. |
| The internet is gone after a test | **Always require VPN** is on and the tunnel is down. Connect Mullvad, or switch the toggle off. |
| No snapshots in Time Machine | The chat is not in a project folder, the folder is too big or too broad (your whole home), or the snapshots were switched off. |
| A ghost left a folder behind | It is deleted at the next start. Look for `hermoso-ghost-…` in your temporary folder. |

Found a bug? Open an issue. Found a way past a protection? Read [SECURITY](../../.github/SECURITY.md) first.

## Build it yourself instead

See *Install → From source* in the [README](../../.github/README.md#install).
