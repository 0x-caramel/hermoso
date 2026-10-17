# Contributing to Hermoso

Thank you for helping. Hermoso is a small project with a clear job: **protect the person who runs an AI agent on their own
computer**. Contributions that make a protection more real, more honest or easier to trust are the most welcome.

> This file is about **Hermoso**. The repository also contains Hermes Agent, which has its own
> [CONTRIBUTING](../CONTRIBUTING.md) at the root: use that for anything that is not Hermoso's code, and send problems in
> Hermes itself to [Nous Research](https://github.com/NousResearch/hermes-agent).

## Before you start

Read the [threat model](../docs/hermoso/THREAT-MODEL.md). Two sentences from it shape every decision:

- *Hermoso is a guard, not a vault.* A protection that claims more than it does is worse than none.
- *If a limit is not written down, that is a bug in the documentation.*

## The two rules of this fork

**1. Hermoso stays out of upstream's way.** Hermoso lives in its own places:

| Where | What |
| --- | --- |
| `apps/desktop/electron/hermoso/` | the main process side (Electron-free modules, tested against fakes) |
| `apps/desktop/src/plugins/hermoso/` | the window: a bundled desktop plugin, English-only strings in `strings.ts` |
| `apps/desktop/assets/hermoso-plugin/` | the agent's plugin (Python), installed into each Hermes home |
| `apps/desktop/fork/` | identity, brand art, sync and pack tooling, the design notes in `FORK.md` |

Upstream-owned files are touched only at the hook points listed in `apps/desktop/fork/hooks.json`, a few lines each.
`fork/sync.mjs` checks that every hook survived an update. A change that needs a new hook has to say why in that file.

**2. Every protection ships with its limits and its tests.** A new protection or a change to one needs:

- tests at each level that applies: unit (against fakes), and end to end through the real agent when behaviour crosses
  the plugin;
- the limits, written where the person reads them (the window) *and* in the threat model;
- a decision about failure: what happens when Hermoso is missing, silent or confused (see the *fail open or fail
  closed* table in the threat model).

## What we will not merge

- Telemetry, analytics, or any network call of Hermoso's own. (His only traffic is `127.0.0.1`.)
- Anything that lets the agent answer for the person, choose the words the person reads, or edit Hermoso.
- Weakening a *never allowed* rule, or a refusal that raises (Hermes skips a middleware that raises, so a refusal must
  be a returned value or a wait).
- A claim without its limit.

## Setting up

You need Node (see `.nvmrc`), Python (see `.python-version`) for the plugin tests, and Windows for the end-to-end tests.

```bash
git switch hermoso
npm install                      # from the repository root
cd apps/desktop
```

```bash
npx vitest run electron/hermoso                  # main-process unit tests
npx vitest run --project ui src/plugins/hermoso  # the window's tests
python -B fork/plugin-tests/test_hermoso_plugin.py
python -B fork/plugin-tests/test_guardian_rules.py
npm run lint && npm run typecheck
```

End to end (a real Hermes backend, a scripted model, a scripted `mullvad`; they never touch your real VPN):

```bash
npm run build
HERMES_E2E_HERMES_ROOT="<your Hermes runtime>" npx playwright test e2e/hermoso-*.spec.ts
```

`HERMES_E2E_HERMES_ROOT` points at a Hermes checkout or runtime with its Python environment (for the official install
on Windows: `%LOCALAPPDATA%\Hermes\hermes-agent`). `HERMOSO_E2E_KEEP=1` keeps a failed run's sandbox for you to look at.

## Working on the branch

- Branch from `hermoso`. Commit messages follow the existing style: `feat(desktop): ...`, `fix(desktop): ...`,
  `test(desktop): ...`, with a body that says *why*.
- The fork is a short stack on one official Hermes commit. Two kinds of commit are **derived** and never edited by hand:
  `brand:` (the portrait on the official tiles, drawn by `fork/brand/hermoso.py`) and `generated:` (the i18n catalog).
  After normal commits, run `node apps/desktop/fork/sync.mjs --restack` to put them back on top.
- To move onto a newer official Hermes: `node apps/desktop/fork/sync.mjs --check`, then `--rehearse`, then adopt.
  The script stops without changing anything when it cannot.
- To build: `node apps/desktop/fork/pack.mjs` (not plain `npm run pack`: it stamps the *official* commit the fork sits on).

## Adding or changing a guardian rule

The guardian's words and patterns live in `assets/hermoso-plugin/guardian-rules.json` and `guardian_rules.py`, shared by
the plugin and the app. A rule change needs rows in `fork/plugin-tests/test_guardian_rules.py` for **what must be
caught** and for **what everyday commands must not trigger**: a rule that cries wolf gets switched off, and a switched
off guardian protects nobody.

## Pull requests

- Keep them small and about one thing. Say what you changed, why, and how you checked it.
- Say which limits you added or changed.
- Run the tests above. If you could not run the end-to-end ones, say so.

Be kind to the people you work with. Disagree about the code, not about the person.
