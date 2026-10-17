# Publishing Hermoso

A checklist for whoever puts this repository on GitHub. **Nothing here has been pushed anywhere**: every commit is local
until you decide.

## What is ready

| File | What it is |
| --- | --- |
| [`.github/README.md`](../../.github/README.md) | The front page. GitHub shows `.github/README.md` before the root `README.md`, so Hermes' own README is left untouched (and the fork keeps merging cleanly) |
| [`.github/SECURITY.md`](../../.github/SECURITY.md) | How to report a vulnerability, what counts, what does not |
| [`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) | The two rules of the fork, how to run the tests, what will not be merged |
| [`docs/hermoso/THREAT-MODEL.md`](THREAT-MODEL.md) | What each protection guarantees, and where it stops |
| [`LICENSE`](../../LICENSE) / [`NOTICE.hermoso.md`](../../NOTICE.hermoso.md) | MIT, with Nous Research's copyright kept; the portrait is excluded and flagged |
| `docs/hermoso/screenshots/` | The pictures the README shows (made by `apps/desktop/e2e/hermoso-screenshots.spec.ts`) |

## Before you push: five things only you can decide

1. **The portrait.** `apps/desktop/fork/brand/hermoso/source.png` (and the logo and icons drawn from it) is not covered by
   the MIT licence, and the project does not know who made it. Be sure you may publish it, or swap it for your own art
   (see [`NOTICE.hermoso.md`](../../NOTICE.hermoso.md)). If in doubt, publish without it first: the code does not need it.
2. **Your name and e-mail in the history.** Every Hermoso commit is authored with the identity in `git config`
   (`git log hermoso-base..hermoso --format='%an <%ae>' | sort -u`). Pushing makes that public. To publish under GitHub's
   no-reply address instead, set it *before* pushing and rewrite the author:

   ```bash
   git branch backup/before-reauthor        # a way back
   git switch hermoso
   git config user.email "<id>+<username>@users.noreply.github.com"
   git rebase --exec "git commit --amend --reset-author --no-edit" hermoso-base   # only the fork's own commits move
   ```

   (Official Hermes commits, below `hermoso-base`, keep their own authors: they are already public.)
3. **The copyright holder.** `LICENSE` and `NOTICE.hermoso.md` say "the Hermoso authors". Put your name there if you want it.
4. **Which branches go.** Publish `hermoso` (the fork), `hermoso-base` (the official commit it sits on) and, if you want
   them, `main`. Do **not** push the `backup/*` branches or `mullvad-vpn` (a separate, private fork).
5. **GitHub Actions.** Hermes' own workflows (over fifty of them) are written for Nous Research's infrastructure. In a GitHub
   *fork* they start disabled; in a brand-new repository they would run on your first push and mostly fail. Either create the
   repository as a fork of `NousResearch/hermes-agent`, or switch Actions off under *Settings → Actions → General* until you
   have chosen which workflows you want.

## Publishing

```bash
git remote add origin https://github.com/<you>/hermoso.git     # a fork, or an empty repository
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
SmartScreen will say "Unknown publisher" once; say so in the release notes too.

## Keeping it current

When Nous Research ships a new Hermes: `node apps/desktop/fork/sync.mjs --check`, then `--rehearse`, then adopt (see
[`apps/desktop/fork/FORK.md`](../../apps/desktop/fork/FORK.md)). Publish the result as a new commit on `hermoso`
and a new installer.
