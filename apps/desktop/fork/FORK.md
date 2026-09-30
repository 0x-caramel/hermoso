# Hermes (Mullvad) — this fork

The official Hermes Desktop, plus three things. Everything that is not upstream's lives in
`apps/desktop/fork/` or in a short list of hooks (see `hooks.json`).

| | What | Where |
| --- | --- | --- |
| **VPN gate** | Connects Mullvad on launch and holds the backend start until the tunnel is up; an egress gate holds every external request of the app until then; boot card, Settings → VPN, statusbar chip | `electron/mullvad.ts`, `vpn-controller.ts`, `egress-gate.ts`, `src/store/vpn.ts`, `src/components/vpn-gate-overlay.tsx`, `src/app/settings/vpn-settings.tsx`; invariants in `AGENTS.md` |
| **Own identity** | Its own AppUserModelID (`com.nousresearch.hermes.mullvad`), so Windows gives it its own taskbar button and icon instead of folding it into the official Hermes | `electron/main.ts` (one line), `fork/install-shortcut.ps1` |
| **Logo #E100FF** | The black of the official logo art becomes `#E100FF`; white and transparency are kept. The official install is untouched | `fork/brand/recolor.py` (+ the generated images, in the `brand:` commit) |

Start it from the Start Menu: **Hermes (Mullvad)**. The official **Hermes** shortcut keeps
starting the untouched official app. Both share the same profile and single-instance lock, so
close one before opening the other.

Rebuild after changing code: `node apps/desktop/fork/pack.mjs` (not plain `npm run pack`). It
stamps the bundle with the *official* commit the fork sits on instead of the fork's own commit:
the app's bundle-skew banner (desktop older than the backend after an official update) and the
first-launch bootstrap both read that stamp, and an unknown commit would silence the banner for
good. The banner is the fork's reminder to run `sync.mjs`.

## When the official Hermes updates

The fork is a short stack of commits on one official commit: branch `main` records that
commit, `mullvad-vpn` is `main` plus the fork. An update means: take the new official code,
put the fork's commits back on top, check nothing got lost, rebuild. That is `fork/sync.mjs`.

```
node apps/desktop/fork/sync.mjs --check       seconds; says whether the fork still applies. Writes nothing.
node apps/desktop/fork/sync.mjs --rehearse    the full replay + typecheck + unit tests + e2e on a scratch branch, then discards it
node apps/desktop/fork/sync.mjs               adopt it: same, then rebuild, refresh the shortcut, move the fork onto the new base
```

1. **Update the official runtime first.** That is the Python backend the fork talks to, and
   the code the fork is aligned to. `sync.mjs` reads the new code from that install by default
   (`--from runtime`); `--from remote` takes the tip of the official repository on GitHub
   instead (it can be ahead of the runtime).
2. Run `sync.mjs --check`, then `sync.mjs`.

### Updating from inside the fork (automatic)

**Update now** works from Hermes (Mullvad) itself. The official updater updates the runtime (and
the official Hermes) and relaunches the fork's *old* bundle. At startup, before it boots anything,
that bundle compares the official commit it was stamped with (see `pack.mjs`) with the runtime's
HEAD, with the same proof the app's own "bundle out of date" check uses (desktop paths changed
after the stamp). When the runtime is provably ahead it hands over (`electron/fork-update.ts`):

1. it shows a small "Updating Hermes (Mullvad)" window (the official hand-off script waits for a
   window to appear after the relaunch; an app that exits at once would be relaunched again),
   starts the Mullvad tunnel, starts `fork/update.mjs` **hidden**, and opens a black progress window
   (`fork/tail.mjs`) that only shows `fork-update.log` as it grows. The update must not depend on a
   window: closing a console kills what is attached to it, and a rebuild cut off half way would
   leave the fork half moved. Closing the progress window changes nothing;
2. `update.mjs` waits for the app to close and for the official script to let go of the update
   marker, waits for the tunnel when the VPN is required (otherwise the update is postponed to the
   next launch: nothing is built on the real IP), runs `sync.mjs`, and reopens the app: the new
   build when it worked, the previous build untouched when it did not;
3. a failed or postponed update is told once, at the next start, with the reason and the files
   that conflict. It is not retried for the same runtime commit; a newer one tries again.

It takes about 8 minutes after the official update (typecheck, tests, build, e2e, pack). It needs
this checkout where it was built, Node, Python with Pillow + numpy, git, and the network only when
the dependencies changed. State and log: `fork-update.json` / `fork-update.log` (the previous run's
is kept as `fork-update.previous.log`) in the app's userData. `HERMES_FORK_UPDATE=off` switches it
off. Opening the app while an update runs shows "updating" instead of booting the old build under it.

A build that is NOT inside a fork checkout (the installer you give to someone: see "Giving it to
someone" below) has nothing to rebuild itself from, so it has no "Update now": the app answers
`external` ("Updates are managed by the package owner outside this app", hook
`forkUpdate.updateMechanism()`), and the owner sends a new installer after each alignment. Without
that, the official update would update that person's runtime, relaunch their stale bundle and go
round again.

Limits: conflicts still need a person (Claude): the update stops, the fork keeps working as it was.
The more often the official Hermes is updated, the fewer official commits pile up between two
updates, and the less likely they touch the fork's hooks.

### What the script guarantees

- It never changes the fork unless everything passed. A conflict, a lost hook, a failing
  typecheck, unit test or e2e rolls the branch, the working tree and the previous build back
  (`release/win-unpacked.bak`). Adopting keeps the old tip as `backup/mullvad-vpn-<time>`.
- `hooks.json` lists where the fork hooks into upstream files (for instance the two
  `await vpn.assertReady()` calls). A merge can be clean and still lose a hook because upstream
  moved the code around it; the script fails on that. The e2e (`e2e/vpn-gate.spec.ts`) proves the
  gate really holds the backend.
- `brand:` commits are never replayed. The logo art is regenerated from the new official files,
  so upstream changing or renaming those images can not conflict, and new images (upstream added
  dark variants and MSIX logos within two weeks) are picked up by themselves.

### When it says the fork does not apply

Textual conflicts are real work: upstream moved code the fork's hooks sit in. The script stops
and lists the files and hunks. Ask Claude to **align the fork** (resolve the conflicts on a
scratch branch, re-home the hooks that moved, update `hooks.json`, run the same verification).
After 16 days of upstream (2567 files in `apps/desktop`, `main.ts` +4.9k/−3.6k lines) it was
5 files and 14 hunks, nearly all "both sides added lines next to each other" plus hooks that
upstream re-homed. What moved that time, as a map for the next port:

- The update check moved out of `main.ts` into `updater/checkout.ts`; the fork's wait for the tunnel
  now sits at the top of `checkUpdates()` and covers every update mechanism.
- Connections became a registry (local, SSH, remote). Local starts still funnel through
  `runHermesStart` / `runPoolBackendStart`; SSH and remote dials go through
  `connectRegistryBackend`, which got its own `await vpn.assertReady()`.
- The eager start goes through `connectDesktopProfileRoute`; the VPN-aware log line wraps it.
- `e2e/fixtures.ts` lost `writeEnvFile` / `writeMockProviderConfig` (now in `tests-js/scripts/`).
- The root `package.json` pins `engines.npm` with engine-strict, which excludes some npm versions:
  `sync.mjs` falls back to `npx npm@<matching version> ci` when plain `npm ci` answers EBADENGINE.
- New locales (de, es, fr) are `defineLocale` overlays: the fork's strings fall back to English there.

## Giving it to someone

```
node apps/desktop/fork/pack.mjs                  the app, as always (after every change or alignment)
node apps/desktop/fork/installer/build.mjs       -> apps/desktop/release/installer/Hermes-Mullvad-Setup-<YYYY.M.D>.exe  (~105 MB)
```

The setup only wraps the tree `pack.mjs` built (it rebuilds nothing), so the other person gets the
bytes that were tested here. Per-user install (`%LOCALAPPDATA%\Programs\hermes-mullvad`, no
administrator prompt), Start Menu and Desktop shortcuts "Hermes (Mullvad)" with the magenta icon and
the fork's own AppUserModelID, an entry in Apps & features. The licence of Hermes (MIT) and a short
note are installed beside the app. It is **not signed** (that needs a publisher certificate): the
first run shows Windows SmartScreen's "unknown publisher", "More info", "Run anyway". Send it with a
link (Drive, OneDrive, WeTransfer): mail and most chat apps refuse `.exe`.

What the person needs: Windows 10/11 x64, the internet, and **Mullvad VPN with their own account**
(the gate says so and offers "Continue without VPN" for that launch if it is missing). It carries
nothing of yours: chats, keys and settings start from zero.

First start on a machine without Hermes: the app asks "Connect to existing Hermes" or "Install
Hermes locally"; the second installs it itself (the official `install.ps1`, pinned to the official
commit in the stamp, stage by stage), after the VPN gate, so the download goes through the tunnel
too. About 10 minutes. The renderer's 3-minute boot budget used to put a "Hermes couldn't start"
dialog over that healthy install; the hook `withTimeoutWhile(` in `use-gateway-boot.ts` renews the
budget while main reports an install (or the choice) in progress. A GitHub `HTTP 429` while fetching
`install.ps1` is rate limiting, not a bug: "Reload and retry".

Updates: **none inside the app** for that person. A build that is not inside a fork checkout answers
`external` (see "Updating from inside the fork"): About says "Updates are managed by the package
owner outside this app", there is no "Update now" to break it. After each alignment you run the two
commands above and send the new setup; installing it over the old one keeps their data (Hermes keeps
it in `%LOCALAPPDATA%\hermes`, outside the app). Their runtime is the one the first start installed;
if a newer setup warns that the backend is older than the app, they run `hermes update` once in
PowerShell. To remove it: Settings > Apps > Hermes (Mullvad); the data stays.

Tested for real (2026-10-01): silent install, shortcuts and AppUserModelID, the app booting and
answering `external`, the uninstaller leaving nothing but the data. An official Hermes on the same
machine is not touched; the two share the profile and the single-instance lock, so close one before
opening the other.

## Logo

```
python apps/desktop/fork/brand/recolor.py --list                 what it would tint
python apps/desktop/fork/brand/recolor.py                        regenerate from the official runtime copy
python apps/desktop/fork/brand/recolor.py --color E100FF --check verify no black logo art is left
python apps/desktop/fork/brand/recolor.py --preview out.png      before/after contact sheet
```

Every grey-scale image under `assets/` and `public/` with real black in it is tinted (icons,
`apple-touch-icon`, the brand mark, the intro texture, the dark variants, the MSIX logos);
colourful art, photos and real macOS `.icns` containers are left alone. It always reads the
pristine official files and refuses to tint art that is already tinted.

If the taskbar or Start Menu shows an old icon after a rebuild: `fork/install-shortcut.ps1`
(it also asks Explorer to refresh its icon cache).

## Needs

Node ≥ 20.11, git, Python with Pillow and numpy (logo regeneration), Mullvad VPN for the real gate.
`node --test apps/desktop/fork/sync.test.mjs` tests the sync tool on throw-away repositories.
