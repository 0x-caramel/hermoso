# Publishing Hermoso

A checklist for putting this repository on GitHub. **Nothing here has been pushed anywhere**: every commit is local until
you decide.

## What is ready

| File | What it is |
| --- | --- |
| [`.github/README.md`](../../.github/README.md) | The front page. GitHub shows `.github/README.md` before the root `README.md`, so Hermes' own README is left untouched (and the fork keeps merging cleanly) |
| [`.github/SECURITY.md`](../../.github/SECURITY.md) | How to report a vulnerability, what counts, what does not |
| [`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) | The two rules of the fork, how to run the tests, what will not be merged |
| [`docs/hermoso/THREAT-MODEL.md`](THREAT-MODEL.md) | What each protection guarantees, and where it stops |
| [`LICENSE`](../../LICENSE) / [`NOTICE.hermoso.md`](../../NOTICE.hermoso.md) | MIT, with Nous Research's copyright kept and 0x-caramel's added; the portrait is the maintainer's own |
| `docs/hermoso/screenshots/` | The pictures the README shows (made by `apps/desktop/e2e/hermoso-screenshots.spec.ts`) |

## Already decided

- **The portrait** is the maintainer's own artwork (see [`NOTICE.hermoso.md`](../../NOTICE.hermoso.md)).
- **The history carries no personal e-mail.** Every Hermoso commit is authored as
  `0x-caramel <85824521+0x-caramel@users.noreply.github.com>` (GitHub's no-reply address, which still links the commits to the
  account). To check before pushing: `git log --format='%an <%ae> | %cn <%ce>' | sort -u`. The official Hermes commits
  below `hermoso-base` keep their own authors: they are already public.
- **The copyright holder** is 0x-caramel.
- **No response times are promised** in `SECURITY.md`: reports are answered as soon as possible.

## How it gets to GitHub

This copy of the repository is a *shallow* clone (it only has the last official Hermes commit, not its whole history), so
it cannot be pushed to a brand-new empty repository. The easy way is a **fork**: GitHub already has the whole history, so
only Hermoso's own commits travel. A fork also starts with GitHub Actions switched off, which is what you want (they are
GitHub's robots, which run checks every time something is pushed; Hermes has over fifty, written for Nous Research's
servers, and in a new repository they would all start and mostly fail).

1. Open <https://github.com/NousResearch/hermes-agent> and click **Fork** → *Create a new fork*.
2. **Repository name:** `hermoso`. **Description:** "A bodyguard for the AI agent that works on your computer. Built on
   Hermes Desktop." Leave *Copy the main branch only* ticked. Click **Create fork**.
3. Push the two branches (the remote is called `github`; `origin` stays pointed at Nous Research, which `sync.mjs` uses to
   fetch the official code, so never push there):

```bash
git remote add github https://github.com/0x-caramel/hermoso.git
git push github hermoso hermoso-base
```

Do **not** push `main` (the fork already has Nous Research's), the `backup/*` branches, or `mullvad-vpn` (a separate,
private fork whose commits carry another identity). The first push may open a GitHub sign-in window: sign in as
0x-caramel there, it is your own login.

If git ever says *shallow update not allowed*, run `git fetch --unshallow origin` once (it downloads the official history)
and push again.

## Then, on GitHub (a few clicks)

- *Settings → General → Default branch*: switch to `hermoso` (so the front page is Hermoso's README, not Hermes').
- *Settings → Code security → Private vulnerability reporting*: **enable it**. [`SECURITY.md`](../../.github/SECURITY.md) tells
  people to use it.
- *About* (the gear next to it): topics `ai-agent`, `security`, `guardrails`, `hermes-agent`, `electron`, `mullvad`,
  `windows`.
- *Actions*: leave them off.
- Open the front page and check that the images and links render.

## Releasing the Windows installer

```bash
node apps/desktop/fork/pack.mjs                 # builds and packs the app
node apps/desktop/fork/installer/build.mjs      # wraps it: apps/desktop/release/installer/Hermoso-Setup-<date>.exe
```

The second command prints the installer's SHA-256. Create a release, attach the `.exe`, and **paste the SHA-256 into the
release notes** (the README and SECURITY.md tell people to compare it). The installer is not code-signed, so Windows
SmartScreen will say "Unknown publisher"; say so in the release notes too.

For the first release the text is ready: [`RELEASE-2026.10.17.md`](RELEASE-2026.10.17.md) (it already has the SHA-256 of
`Hermoso-Setup-2026.10.17.exe`). On GitHub: *Releases → Draft a new release*, tag **`v2026.10.17`** (*Create new tag on
publish*, target `hermoso`), title **Hermoso 2026.10.17**, paste the text, drag the `.exe` in, **Publish release**. The
installer is `apps/desktop/release/installer/Hermoso-Setup-2026.10.17.exe`.

## Keeping it current

When Nous Research ships a new Hermes: `node apps/desktop/fork/sync.mjs --check`, then `--rehearse`, then adopt (see
[`apps/desktop/fork/FORK.md`](../../apps/desktop/fork/FORK.md)). Publish the result as a new commit on `hermoso`
and a new installer.
