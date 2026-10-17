## Hermoso 2026.10.17

**The brother who protects.** A bodyguard for the AI agent that works on your computer, built on Hermes Desktop.
First public release. **Windows 10/11, 64-bit.**

### Download

`Hermoso-Setup-2026.10.17.exe` (105 MB)

**SHA-256:** `06c036dcf5576018774b108af2ca11790b932399f34afe0d6c704a3dc4daa425`

Check it before you run it (PowerShell, in the folder of the download):

```powershell
Get-FileHash .\Hermoso-Setup-2026.10.17.exe -Algorithm SHA256
```

### What he does

- **Shield:** when the VPN tunnel drops, the agent stands still until it is back. A radar shows where the app's
  connections really go.
- **Guardian:** a person decides, in plain words, before the agent does something that cannot be undone. Wiping a disk
  and editing Hermoso himself are never allowed.
- **Time Machine:** the project is snapshotted before the agent changes files; one click rewinds and your own edits are
  kept.
- **Ghost:** a window that keeps nothing, deleted on a panic key, on close, or at the next start.
- **Teleport:** move the Mullvad exit country for a while; it comes back by itself.
- **Aura:** a glow that grows with what he did for you. Just for fun.

### Before you install

- The installer is **not code-signed**: Windows SmartScreen shows "Unknown publisher". *More info*, then *Run anyway*.
- **Mullvad VPN** (installed, account logged in) is needed for the VPN gate, Shield and Teleport. Guardian, Time Machine
  and Ghost do not need it.
- **Windows only**, **early and not audited.** Hermoso is a guard, not a vault: read the
  [threat model](https://github.com/0x-caramel/hermoso/blob/hermoso/docs/hermoso/THREAT-MODEL.md) to know where each protection stops.
- Unofficial fork: not affiliated with Nous Research or Mullvad VPN AB.

Step by step: [INSTALL.md](https://github.com/0x-caramel/hermoso/blob/hermoso/docs/hermoso/INSTALL.md).

### Built on

Hermes Desktop by Nous Research (official commit `12e4d3e2`), MIT licensed.
