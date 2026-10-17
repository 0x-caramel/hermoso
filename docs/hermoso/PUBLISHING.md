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

## Before you push

1. **Which branches go.** Publish `hermoso` (the fork), `hermoso-base` (the official commit it sits on) and, if you want
   them, `main`. Do **not** push the `backup/*` branches or `mullvad-vpn` (a separate, private fork whose commits carry
   another identity).
2. **GitHub Actions.** Actions are GitHub's robots: they run checks and tests by themselves every time something is pushed.
   Hermes' repository has over fifty of them, written for Nous Research's own servers, and in a new repository they would
   all start on your first push and mostly fail (red crosses everywhere). Two easy ways out: create the repository with the
   **Fork** button on `NousResearch/hermes-agent` (a fork starts with Actions switched off), or, in a new repository, open
   *Settings → Actions → General* and choose **Disable actions**.

## Publishing

```bash
git remote add origin https://github.com/0x-caramel/hermoso.git
git push origin hermoso hermoso-base main
```

Then, on GitHub:

- *Settings → General → Default branch*: `hermoso`.
- *Settings → Code security → Private vulnerability reporting*: **enable it**. [`SECURITY.md`](../../.github/SECURITY.md) tells
  people to use it.
- *About*: a description (e.g. "A bodyguard for the AI agent that works on your computer. Built on Hermes Desktop."),
  topics (`ai-agent`, `security`, `guardrails`, `hermes-agent`, `electron`, `mullvad`, `windows`), and a social-preview
  image (`docs/hermoso/logo.png` works).
- Open the front page and check that the images and links render.

## Releasing the Windows installer

```bash
node apps/desktop/fork/pack.mjs                 # builds and packs the app
node apps/desktop/fork/installer/build.mjs      # wraps it: apps/desktop/release/installer/Hermoso-Setup-<date>.exe
```

The second command prints the installer's SHA-256. Create a release, attach the `.exe`, and **paste the SHA-256 into the
release notes** (the README and SECURITY.md tell people to compare it). The installer is not code-signed, so Windows
SmartScreen will say "Unknown publisher"; say so in the release notes too.

## Keeping it current

When Nous Research ships a new Hermes: `node apps/desktop/fork/sync.mjs --check`, then `--rehearse`, then adopt (see
[`apps/desktop/fork/FORK.md`](../../apps/desktop/fork/FORK.md)). Publish the result as a new commit on `hermoso`
and a new installer.
