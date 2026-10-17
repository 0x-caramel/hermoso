#!/usr/bin/env node
/**
 * fork/sync.mjs — keep this fork integrated when the official Hermes moves on.
 *
 * The fork is a short stack of commits on top of one official commit (branch `main` records
 * that commit; `mullvad-vpn` is main + the fork). An official update means: take the new
 * official code, put the fork's commits back on top of it, check that nothing was lost, and
 * rebuild. This script does that, and stops without changing anything when it cannot.
 *
 *   node fork/sync.mjs --check        fetch the new official code and report, in seconds, whether
 *                                     the fork still applies (nothing is written)
 *   node fork/sync.mjs --rehearse     do the whole thing on a scratch branch (replay, brand art,
 *                                     hook check, typecheck, unit tests, e2e), then discard it
 *   node fork/sync.mjs                adopt: same as --rehearse, then rebuild the app, refresh the
 *                                     Start Menu shortcut and move the fork onto the new base
 *
 * Other switches: --no-e2e (skip the slow e2e), --no-verify (skip typecheck, unit tests and e2e),
 * --no-build (adopt the source but do not rebuild the app), --force (allow an older target).
 *
 * Where the new official code comes from (--from):
 *   runtime   (default) the Hermes install on this machine, the one the official updater keeps
 *             current and the one the backend actually runs: fork and backend then always match
 *   remote    the tip of the official repository on GitHub (it can be ahead of the runtime)
 *   <path>    any git checkout
 *
 * Commits whose subject starts with "brand:" (the recolored logo art) are never replayed. The
 * art is regenerated from the new official files instead (fork/brand/recolor.py), so an
 * upstream change to those binaries can not conflict, and new art is picked up by itself.
 *
 * Exit codes: 0 done (or nothing to do), 1 the update does not apply cleanly / a check failed
 * (the fork is left exactly as it was), 2 refused to start (dirty tree, wrong branch, ...).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readIdentity } from './identity.mjs'
import { readStamp, stampEnv } from './pack.mjs'

export const DESKTOP = path.resolve(import.meta.dirname, '..')

// Who this fork is (fork/identity.json; the Mullvad fork has none and keeps its defaults): the branch it
// lives on, the branch that records the official commit under it, its name, the script that draws its art.
const IDENTITY = readIdentity(DESKTOP)
const FORK_BRANCH = IDENTITY.branch
const BASE_BRANCH = IDENTITY.base
const TARGET_REF = 'refs/fork/target'
const BRAND_PREFIX = 'brand:'
const GENERATED_PREFIX = 'generated:'
// Commits made of derived files: never replayed, regenerated from the new official code instead.
const DERIVED_PREFIXES = [BRAND_PREFIX, GENERATED_PREFIX]
const IS_WINDOWS = process.platform === 'win32'

// ── output ──────────────────────────────────────────────────────────────────────────────

const say = (...lines) => lines.forEach(l => console.log(l === '' ? '' : `[fork-sync] ${l}`))
const sub = (...lines) => lines.forEach(l => console.log(`             ${l}`))

class Refusal extends Error {
  constructor(message) {
    super(message)
    this.exitCode = 2
  }
}

class Failure extends Error {
  constructor(message) {
    super(message)
    this.exitCode = 1
  }
}

// ── process helpers ──────────────────────────────────────────────────────────────────────

const REPO = (() => {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: DESKTOP, encoding: 'utf8', windowsHide: true })

  if (r.status !== 0) {
    throw new Error(`${DESKTOP} is not inside a git checkout`)
  }

  return r.stdout.trim()
})()

function git(args, { cwd = REPO, allowFail = false, input } = {}) {
  // core.longpaths: upstream ships deep docs paths (website/i18n/...); a switch that stops half way
  // on Windows' 260-character limit would leave the tree in pieces.
  const r = spawnSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
    input,
    maxBuffer: 1 << 29,
    windowsHide: true
  })

  if (r.error) {
    throw r.error
  }

  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`)
  }

  return r
}

const gitOut = (args, options) => git(args, options).stdout.trim()

/** A long-running command with its output on screen. Returns the exit code. */
function sh(command, args, { cwd = DESKTOP, env, capture = false } = {}) {
  // npm/npx are .cmd shims on Windows and need a shell; one command string avoids Node's
  // "args with shell: true" deprecation. cmd.exe treats < > | & as operators, so quote those.
  const useShell = IS_WINDOWS && /^(npm|npx)$/.test(command)
  const quote = arg => (/[\s<>|&^"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
  const options = {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    ...(capture ? { encoding: 'utf8', maxBuffer: 1 << 28 } : {})
  }
  const r = useShell
    ? spawnSync([command, ...args.map(quote)].join(' '), { ...options, shell: true })
    : spawnSync(command, args, options)

  if (r.error) {
    throw r.error
  }

  if (capture) {
    return { output: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status ?? 1, stdout: r.stdout ?? '' }
  }

  return r.status ?? 1
}

function step(title, fn) {
  const started = Date.now()

  say(`${title} ...`)
  const result = fn()

  say(`${title}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  return result
}

// ── the fork's own state ─────────────────────────────────────────────────────────────────

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
}

const short = sha => sha.slice(0, 8)

function branchExists(name) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).status === 0
}

function currentBranch() {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
}

function inProgressOperation() {
  for (const marker of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    const p = gitOut(['rev-parse', '--git-path', marker])

    if (fs.existsSync(path.resolve(REPO, p))) {
      return marker
    }
  }

  return null
}

/**
 * The fork's commits, oldest first, split into what is replayed and what is regenerated: commits
 * whose subject starts with "brand:" (the logo art) or "generated:" (files a script derives from
 * the official code, like the i18n key catalog) hold derived files that would only ever conflict.
 */
export function readForkStack() {
  const shas = gitOut(['rev-list', '--reverse', `${BASE_BRANCH}..${FORK_BRANCH}`])
    .split('\n')
    .filter(Boolean)
  const commits = shas.map(sha => {
    const subject = gitOut(['log', '-1', '--format=%s', sha])

    return { derived: DERIVED_PREFIXES.some(prefix => subject.startsWith(prefix)), sha, subject }
  })

  const firstDerived = commits.findIndex(c => c.derived)

  if (firstDerived !== -1 && commits.slice(firstDerived).some(c => !c.derived)) {
    throw new Refusal(
      `a derived ("${DERIVED_PREFIXES.join('" / "')}") commit sits below a normal fork commit ` +
        `(${commits.find((c, i) => i > firstDerived && !c.derived).subject}). ` +
        `Keep those commits on top of the stack so they can be regenerated instead of replayed.`
    )
  }

  return {
    derived: commits.filter(c => c.derived),
    replay: commits.filter(c => !c.derived)
  }
}

function assertForkIsAStack() {
  if (!branchExists(FORK_BRANCH) || !branchExists(BASE_BRANCH)) {
    throw new Refusal(`expected branches "${BASE_BRANCH}" (the official base) and "${FORK_BRANCH}" (the fork) in ${REPO}`)
  }

  if (git(['merge-base', '--is-ancestor', BASE_BRANCH, FORK_BRANCH], { allowFail: true }).status !== 0) {
    throw new Refusal(`"${FORK_BRANCH}" is not built on top of "${BASE_BRANCH}"`)
  }
}

function assertCleanTree() {
  const dirty = gitOut(['status', '--porcelain', '--untracked-files=no'])

  if (dirty) {
    throw new Refusal(`the fork has uncommitted changes; commit or stash them first:\n${dirty}`)
  }

  const operation = inProgressOperation()

  if (operation) {
    throw new Refusal(`a git operation is in progress (${operation}); finish or abort it first`)
  }
}

function forkAppRunning() {
  if (!IS_WINDOWS) {
    return false
  }

  const exe = path.join(DESKTOP, 'release', 'win-unpacked', `${IDENTITY.executable}.exe`)
  const script =
    `(Get-CimInstance Win32_Process -Filter "Name='${IDENTITY.executable}.exe'" | ` +
    `Where-Object { $_.ExecutablePath -ieq '${exe.replace(/'/g, "''")}' } | Measure-Object).Count`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })

  return Number(r.stdout.trim()) > 0
}

// ── where the new official code comes from ───────────────────────────────────────────────

function runtimeRoot() {
  if (process.env.HERMES_DESKTOP_HERMES_ROOT) {
    return process.env.HERMES_DESKTOP_HERMES_ROOT
  }

  return IS_WINDOWS
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Hermes', 'hermes-agent')
    : path.join(os.homedir(), '.hermes', 'hermes-agent')
}

function fetchTarget(from) {
  git(['update-ref', '-d', TARGET_REF], { allowFail: true })

  if (from === 'remote') {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
    const branch = head.status === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main'

    say(`fetching the official ${branch} from origin ...`)
    git(['fetch', '--depth=1', '--no-tags', 'origin', `+${branch}:${TARGET_REF}`])

    return { label: `origin/${branch}`, sha: gitOut(['rev-parse', TARGET_REF]) }
  }

  const root = from === 'runtime' ? runtimeRoot() : path.resolve(from)

  if (!fs.existsSync(path.join(root, '.git'))) {
    throw new Refusal(`${root} is not a git checkout (from: ${from})`)
  }

  say(`reading the official code from ${root} ...`)
  git(['fetch', '--depth=1', '--no-tags', root, `+HEAD:${TARGET_REF}`])

  return { label: root, sha: gitOut(['rev-parse', TARGET_REF]) }
}

// ── the dry run: does the fork still apply? ───────────────────────────────────────────────

export function parseMergeTree(stdout) {
  const lines = stdout.split(/\r?\n/)
  const tree = lines[0].trim()
  const files = []
  let i = 1

  while (i < lines.length && lines[i] !== '') {
    files.push(lines[i++].trim())
  }

  const messages = lines.slice(i + 1).filter(Boolean)
  const kinds = new Map()

  for (const message of messages) {
    const m = /^CONFLICT \(([^)]+)\)/.exec(message)

    if (!m) {
      continue
    }

    for (const file of files) {
      if (message.includes(file) && !kinds.has(file)) {
        kinds.set(file, m[1])
      }
    }
  }

  return { files: files.map(file => ({ file, kind: kinds.get(file) ?? 'content' })), messages, tree }
}

function conflictHunks(tree, file) {
  const r = git(['show', `${tree}:${file}`], { allowFail: true })

  return r.status === 0 ? (r.stdout.match(/^<{7} /gm) ?? []).length : 0
}

function dryRun(target, stack) {
  const tip = stack.replay.at(-1)?.sha ?? BASE_BRANCH
  const r = git(['merge-tree', '--write-tree', '--name-only', `--merge-base=${BASE_BRANCH}`, target, tip], {
    allowFail: true
  })

  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git merge-tree failed (${r.status}): ${(r.stderr || '').trim()}`)
  }

  const parsed = parseMergeTree(r.stdout)

  return {
    clean: r.status === 0,
    conflicts: parsed.files.map(c => ({ ...c, hunks: c.kind === 'content' ? conflictHunks(parsed.tree, c.file) : 0 }))
  }
}

// ── the brand art ────────────────────────────────────────────────────────────────────────

function findPython() {
  const venv = IS_WINDOWS
    ? path.join(runtimeRoot(), 'venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot(), 'venv', 'bin', 'python')
  const candidates = [
    process.env.HERMES_FORK_PYTHON && { args: [], command: process.env.HERMES_FORK_PYTHON },
    { args: [], command: 'python' },
    { args: ['-3'], command: 'py' },
    { args: [], command: 'python3' },
    fs.existsSync(venv) && { args: [], command: venv }
  ].filter(Boolean)

  for (const candidate of candidates) {
    const r = spawnSync(candidate.command, [...candidate.args, '-c', 'import PIL, numpy'], {
      encoding: 'utf8',
      windowsHide: true
    })

    if (!r.error && r.status === 0) {
      return candidate
    }
  }

  throw new Refusal('no Python with Pillow and numpy found (pip install pillow numpy), needed to regenerate the logo art')
}

/**
 * Derived files other than the logo art (fork/generated.json): each step names a command of the
 * repo and the paths it writes, e.g. the i18n key catalog, which must list the fork's strings but
 * is a generated file that upstream rewrites all the time. Run after every replay; the result is
 * committed as "generated: <name>". No manifest, no steps.
 */
function readGeneratedSteps() {
  const file = path.join(import.meta.dirname, 'generated.json')

  if (!fs.existsSync(file)) {
    return []
  }

  return JSON.parse(fs.readFileSync(file, 'utf8')).steps ?? []
}

function recolorArgs(extra) {
  const python = findPython()

  return { args: [...python.args, path.join('fork', ...IDENTITY.brand.script.split('/')), ...extra], command: python.command }
}

function brandPreview(target, stack) {
  const { args, command } = recolorArgs(['--git-ref', target, '--list'])
  const r = spawnSync(command, args, { cwd: DESKTOP, encoding: 'utf8', windowsHide: true })

  if (r.status !== 0) {
    return { error: (r.stderr || r.stdout || `${IDENTITY.brand.script} failed`).trim() }
  }

  const next = r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.split('\t')[1])
  const tip = stack.derived.at(-1)?.sha
  const before = tip
    ? gitOut(['diff', '--name-only', stack.replay.at(-1)?.sha ?? BASE_BRANCH, tip])
        .split('\n')
        .filter(Boolean)
        .map(p => p.replace(/^apps\/desktop\//, ''))
        .filter(p => /^(assets|public)\//.test(p))
    : []

  return {
    added: next.filter(p => !before.includes(p)),
    next,
    removed: before.filter(p => !next.includes(p))
  }
}

// ── verification ─────────────────────────────────────────────────────────────────────────

function checkHooks() {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'hooks.json'), 'utf8'))
  const problems = []

  for (const [file, hooks] of Object.entries(manifest)) {
    if (file.startsWith('_')) {
      continue
    }

    const full = path.join(DESKTOP, file)

    if (!fs.existsSync(full)) {
      problems.push(`${file}: the file is gone (moved or renamed upstream?), ${hooks.length} hook(s) to re-home`)
      continue
    }

    const text = fs.readFileSync(full, 'utf8')

    for (const hook of hooks) {
      const found = text.split(hook.text).length - 1

      if (found < hook.min) {
        problems.push(`${file}: "${hook.text}" found ${found}x, expected at least ${hook.min} (${hook.why})`)
      }
    }
  }

  return problems
}

const FORK_UNIT_TESTS = [
  'electron/mullvad.test.ts',
  'electron/vpn-controller.test.ts',
  'electron/egress-gate.test.ts',
  'electron/fork-update.test.ts',
  'src/store/vpn.test.ts',
  'src/components/vpn-gate-overlay.test.tsx'
]

function depsChanged(oldBase, target) {
  return (
    git(['diff', '--quiet', oldBase, target, '--', 'package.json', 'package-lock.json', 'apps/desktop/package.json'], {
      allowFail: true
    }).status !== 0
  )
}

function mustSucceed(code, what) {
  if (code !== 0) {
    throw new Failure(`${what} failed (exit ${code})`)
  }
}

/** The newest `<prefix>-X.Y.Z-win32-x64` entry of Hermes' managed tools directory, or null. */
export function pickManaged(entries, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.(\\d+)\\.(\\d+)-win32-x64$`)

  return (
    entries
      .map(name => ({ match: pattern.exec(name), name }))
      .filter(entry => entry.match)
      .sort((a, b) => [1, 2, 3].reduce((delta, i) => delta || Number(b.match[i]) - Number(a.match[i]), 0))[0]?.name ?? null
  )
}

/**
 * The Node and npm Hermes' own updater builds with (%LOCALAPPDATA%\hermes\tools\node-*, npm-*): they
 * satisfy the engines the official lockfile pins, and need no download.
 */
function managedToolchain() {
  const local = process.env.LOCALAPPDATA

  if (!IS_WINDOWS || !local) {
    return null
  }

  const tools = path.join(local, 'hermes', 'tools')
  let entries = []

  try {
    entries = fs.readdirSync(tools)
  } catch {
    return null
  }

  const nodeDir = pickManaged(entries, 'node')
  const npmDir = pickManaged(entries, 'npm')

  if (!nodeDir || !npmDir) {
    return null
  }

  const node = path.join(tools, nodeDir, 'node.exe')
  const npmCli = path.join(tools, npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')

  return fs.existsSync(node) && fs.existsSync(npmCli) ? { node, npmCli } : null
}

/**
 * The official install: `npm ci` in the repo root. The root package.json pins `engines.npm` with
 * engine-strict (upstream excludes the npm versions that mishandle its release-age policy), so the
 * npm on this machine can be refused. First choice is the toolchain Hermes itself builds with; then
 * the plain npm; then the newest npm the range allows, through npx (no global npm is touched).
 */
function installDeps() {
  const managed = managedToolchain()

  if (managed) {
    say(`installing with Hermes' managed toolchain (${path.basename(path.dirname(managed.node))})`)

    const code = sh(managed.node, [managed.npmCli, 'ci', '--no-audit', '--no-fund'], {
      cwd: REPO,
      env: { PATH: `${path.dirname(managed.node)}${path.delimiter}${process.env.PATH ?? ''}` }
    })

    if (code === 0) {
      return
    }

    say('the managed toolchain could not install; trying the npm on this machine')
  }

  const plain = sh('npm', ['ci', '--no-audit', '--no-fund'], { capture: true, cwd: REPO })

  process.stdout.write(plain.output)

  if (plain.status === 0) {
    return
  }

  if (!/EBADENGINE/.test(plain.output)) {
    throw new Failure('npm ci failed')
  }

  const range = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).engines?.npm

  if (!range) {
    throw new Failure('npm refused the install (EBADENGINE) but the root package.json names no npm range')
  }

  const view = sh('npm', ['view', `npm@${range}`, 'version', '--json'], { capture: true, cwd: REPO })
  const versions = [].concat(view.status === 0 ? JSON.parse(view.stdout || '[]') : []).filter(v => /^\d+\.\d+\.\d+$/.test(v))
  const pick = versions.at(-1)

  if (!pick) {
    throw new Failure(`no npm version satisfies the engines range "${range}"`)
  }

  say(`the installed npm does not satisfy engines.npm (${range}); installing with npm ${pick} through npx`)
  mustSucceed(sh('npx', ['--yes', `npm@${pick}`, 'ci', '--no-audit', '--no-fund'], { cwd: REPO }), `npx npm@${pick} ci`)
}

// ── the run ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    check: false,
    force: false,
    from: 'runtime',
    help: false,
    noBuild: false,
    noE2e: false,
    noVerify: false,
    rehearse: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--check') options.check = true
    else if (arg === '--rehearse') options.rehearse = true
    else if (arg === '--no-build') options.noBuild = true
    else if (arg === '--no-e2e') options.noE2e = true
    else if (arg === '--no-verify') options.noVerify = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--from') options.from = argv[++i] ?? ''
    else throw new Refusal(`unknown option ${arg} (try --help)`)
  }

  if (!options.from) {
    throw new Refusal('--from needs a value: runtime, remote or a path')
  }

  return options
}

function reportConflicts(dry) {
  say(`the fork does NOT apply cleanly: ${dry.conflicts.length} file(s) conflict`)

  for (const c of dry.conflicts) {
    sub(`${c.file}  (${c.kind}${c.hunks ? `, ${c.hunks} hunk${c.hunks === 1 ? '' : 's'}` : ''})`)
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)

  if (options.help) {
    const header = /\/\*\*([\s\S]*?)\*\//.exec(fs.readFileSync(import.meta.filename, 'utf8'))[1]

    console.log(header.replace(/^ \* ?/gm, '').trim())

    return 0
  }

  assertForkIsAStack()

  const adopt = !options.check && !options.rehearse
  const branch = currentBranch()

  if (branch !== FORK_BRANCH && !options.check) {
    throw new Refusal(`check out "${FORK_BRANCH}" first (on "${branch}" now)`)
  }

  if (!options.check) {
    assertCleanTree()
  }

  if (adopt && !options.noBuild && forkAppRunning()) {
    throw new Refusal(`${IDENTITY.displayName} is running; close it first (the build replaces its files)`)
  }

  const stack = readForkStack()
  const base = gitOut(['rev-parse', BASE_BRANCH])

  say(`fork:    ${FORK_BRANCH}  (${stack.replay.length} commit(s) to replay, ${stack.derived.length} derived commit(s) to regenerate, on official ${short(base)})`)

  const target = fetchTarget(options.from)
  const targetDate = Number(gitOut(['log', '-1', '--format=%ct', target.sha]))
  const baseDate = Number(gitOut(['log', '-1', '--format=%ct', base]))

  say(`target:  ${short(target.sha)}  ${gitOut(['log', '-1', '--format=%cs  %s', target.sha])}`)
  sub(`from ${target.label}`)

  if (target.sha === base) {
    say('the fork is already on this official version; nothing to do')

    return 0
  }

  if (targetDate < baseDate && !options.force) {
    throw new Refusal(`the target is OLDER than the current base (${short(target.sha)} vs ${short(base)}); pass --force to go back`)
  }

  const dry = dryRun(target.sha, stack)
  const brand = brandPreview(target.sha, stack)

  if (brand.error) {
    say(`logo art: could not be assessed (${brand.error.split('\n')[0]})`)
  } else {
    const list = names => (names.length > 4 ? `${names.slice(0, 4).join(', ')} (+${names.length - 4} more)` : names.join(', '))

    say(
      `logo art: ${brand.next.length} image(s) will be tinted at the target` +
        (brand.added.length ? `; new: ${list(brand.added)}` : '') +
        (brand.removed.length ? `; no longer tinted: ${list(brand.removed)}` : '')
    )
  }

  if (!dry.clean) {
    reportConflicts(dry)
    say('', 'Nothing was changed. Resolve the conflicts once (ask Claude: "allinea il fork") and run this again.')

    return 1
  }

  say('the fork replays cleanly on the target (3-way merge, nothing written)')

  if (options.check) {
    say('', `--check only: run without it to ${options.rehearse ? 'rehearse' : 'rehearse (--rehearse) or adopt'} the update.`)

    return 0
  }

  return replayAndVerify({ base, brand, options, stack, target })
}

function replayAndVerify({ base, options, stack, target }) {
  const adopt = !options.rehearse
  const syncBranch = `fork-sync/${stamp()}`
  const oldTip = gitOut(['rev-parse', FORK_BRANCH])
  let restoredRelease = false

  const rollback = reason => {
    say(`rolling back (${reason})`)

    git(['cherry-pick', '--abort'], { allowFail: true })

    if (currentBranch() === syncBranch) {
      git(['reset', '--hard'], { allowFail: true })
      git(['switch', FORK_BRANCH], { allowFail: true })
    }

    if (branchExists(syncBranch)) {
      git(['branch', '-D', syncBranch], { allowFail: true })
    }

    restoreReleaseIfBroken()
    restoredRelease = true
  }

  try {
    step(`replaying ${stack.replay.length} fork commit(s) on ${short(target.sha)}`, () => {
      git(['switch', '-c', syncBranch, TARGET_REF])

      if (stack.replay.length) {
        const r = git(['cherry-pick', '--empty=drop', ...stack.replay.map(c => c.sha)], { allowFail: true })

        if (r.status !== 0) {
          throw new Failure(`cherry-pick stopped: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 6).join(' / ')}`)
        }
      }
    })

    const runE2e = !options.noVerify && !options.noE2e && !options.noBuild
    const needsBuild = !options.noBuild && (adopt || runE2e)
    const generated = readGeneratedSteps()

    // Dependencies first: the generated files are produced by the repo's own scripts.
    if ((!options.noVerify || needsBuild || generated.length) && depsChanged(base, target.sha)) {
      step('dependencies changed upstream: npm ci', installDeps)
    }

    step('regenerating the logo art from the new official files', () => {
      const { args, command } = recolorArgs(['--git-ref', TARGET_REF])

      mustSucceed(sh(command, args), IDENTITY.brand.script)

      git(['add', '-A', '--', 'apps/desktop/assets', 'apps/desktop/public'])

      if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0) {
        git(['commit', '-q', '-m', `${BRAND_PREFIX} ${IDENTITY.brand.commit} (regenerated on ${short(target.sha)})`])
      }

      const check = recolorArgs(['--check'])

      mustSucceed(sh(check.command, check.args), `${IDENTITY.brand.script} --check`)
    })

    for (const item of generated) {
      step(`regenerating ${item.name}`, () => {
        mustSucceed(sh(item.run[0], item.run.slice(1), { cwd: path.join(REPO, item.cwd ?? '.') }), item.run.join(' '))

        git(['add', '-A', '--', ...item.paths])

        if (git(['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0) {
          git(['commit', '-q', '-m', `${GENERATED_PREFIX} ${item.name} (regenerated on ${short(target.sha)})`])
        }
      })
    }

    step('checking the fork is still wired into the new code', () => {
      const problems = checkHooks()

      if (problems.length) {
        for (const p of problems) sub(`MISSING  ${p}`)

        throw new Failure(`${problems.length} hook(s) lost in the merge (see fork/hooks.json)`)
      }
    })

    if (!options.noVerify) {
      step('typecheck', () => mustSucceed(sh('npm', ['run', 'typecheck']), 'typecheck'))
      step('fork unit tests', () => mustSucceed(sh('npx', ['vitest', 'run', ...FORK_UNIT_TESTS]), 'unit tests'))
      step('fork updater tests', () =>
        mustSucceed(
          sh('node', ['--test', path.join('fork', 'update.test.mjs'), path.join('fork', 'tail.test.mjs')]),
          'fork/update.test.mjs, fork/tail.test.mjs'
        )
      )
    }

    if (needsBuild) {
      step('building the app bundle', () => {
        // Stamped as the OFFICIAL commit (see fork/pack.mjs): the skew banner and the bootstrap pin read it.
        mustSucceed(sh('npm', ['run', 'build'], { env: stampEnv(target.sha) }), 'build')

        const stamped = readStamp().commit

        if (stamped !== target.sha) {
          throw new Failure(`the build stamp pins ${String(stamped).slice(0, 12)}, expected the official ${short(target.sha)}`)
        }
      })
    }

    if (runE2e) {
      step('e2e: the gate holds the backend until the tunnel is up', () => {
        mustSucceed(
          sh('npx', ['playwright', 'test', 'e2e/vpn-gate.spec.ts', '--reporter=line'], {
            env: { HERMES_E2E_HERMES_ROOT: runtimeRoot() }
          }),
          'e2e/vpn-gate.spec.ts'
        )
      })
    }

    if (!adopt) {
      rollback('rehearsal: everything passed, nothing is kept')
      say('', `Rehearsal passed: the update to ${short(target.sha)} applies and verifies. Run without --rehearse to adopt it.`)

      return 0
    }

    if (!options.noBuild) {
      step('packing the app', () => {
        mustSucceed(sh('npm', ['run', 'builder', '--', '--dir', '--publish', 'never'], { env: stampEnv(target.sha) }), 'electron-builder')
      })

      if (IS_WINDOWS) {
        step('refreshing the Start Menu shortcut', () => {
          mustSucceed(
            sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join('fork', 'install-shortcut.ps1')]),
            'install-shortcut.ps1'
          )
        })
      }
    }
  } catch (error) {
    if (!restoredRelease) {
      rollback(error.message.split('\n')[0])
    }

    throw error
  }

  // Everything passed: move the refs. The previous fork tip stays reachable as a backup branch.
  const backup = `backup/${FORK_BRANCH}-${stamp()}`

  git(['branch', backup, oldTip])
  git(['branch', '-f', BASE_BRANCH, target.sha])
  git(['branch', '-f', FORK_BRANCH, syncBranch])
  git(['switch', FORK_BRANCH])
  git(['branch', '-D', syncBranch])

  say(
    '',
    `Done. The fork now sits on official ${short(target.sha)} (${stack.replay.length} commit(s) replayed, logo art regenerated).`,
    options.noBuild
      ? 'The app was NOT rebuilt (--no-build): run "node fork/pack.mjs" in apps/desktop.'
      : `Start it from the Start Menu: "${IDENTITY.shortcutName}".`,
    `Rollback: git switch ${backup}${options.noBuild ? '' : '; the previous build is release/win-unpacked.bak'}.`
  )

  return 0
}

function restoreReleaseIfBroken() {
  const dir = path.join(DESKTOP, 'release', 'win-unpacked')
  const backup = `${dir}.bak`

  try {
    if (!fs.existsSync(path.join(dir, `${IDENTITY.executable}.exe`)) && fs.existsSync(backup)) {
      fs.rmSync(dir, { force: true, recursive: true })
      fs.renameSync(backup, dir)
      say('restored the previous build from release/win-unpacked.bak')
    }
  } catch (error) {
    say(`could not restore the previous build: ${error.message}`)
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)

if (isMain) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[fork-sync] ${error.exitCode === 2 ? 'refused' : 'failed'}: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
