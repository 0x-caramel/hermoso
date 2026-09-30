/**
 * Fork self-update (Hermes (Mullvad) only).
 *
 * The official Hermes updates its runtime (the Python backend) and relaunches the desktop that
 * asked for it. This build is the fork's, so after an official update the relaunched app is the
 * OLD fork bundle running on a NEW runtime: the desktop code the runtime ships is not in it.
 * This module notices that at startup, before anything boots, and hands the app over to
 * fork/update.mjs, which runs fork/sync.mjs (replay the fork on the new official code, verify,
 * rebuild) and relaunches the new build. When anything goes wrong the previous build is
 * relaunched untouched and the reason is shown once.
 *
 * Why the app does not just quit at once: the official hand-off script relaunches the desktop
 * and waits for a WINDOW to appear; one that exits first reads as a failed launch and gets
 * relaunched again. So this module shows its own small window, and quits only after the
 * official script has finished with the update marker.
 *
 * Everything here is inert unless this is a packaged Windows build that sits in a fork checkout
 * (<repo>/apps/desktop/release/win-unpacked/Hermes.exe, or HERMES_FORK_REPO) and the official
 * runtime is provably ahead of the commit this bundle was stamped with.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { RUNTIME_PATHS } from './bundle-skew'

const STATE_FILE = 'fork-update.json'
const LOG_FILE = 'fork-update.log'
const HELPER = path.join('apps', 'desktop', 'fork', 'update.mjs')
const VIEWER = path.join('apps', 'desktop', 'fork', 'tail.mjs')

/**
 * The helper rewrites the state every few seconds while it works. A "running" state older than
 * this belongs to a helper that died, and no longer blocks a new launch.
 */
export const RUNNING_FRESH_MS = 3 * 60_000

/** Quit no sooner than this after the window is up when the official hand-off script is still running. */
const OFFICIAL_SCRIPT_GRACE_MS = 25_000
const QUIT_AFTER_MS = 3_000
const QUIT_AT_MOST_MS = 4 * 60_000

export type ForkUpdateStatus = 'current' | 'deferred' | 'done' | 'failed' | 'running'

export interface ForkUpdateState {
  announced?: boolean
  at: number
  conflicts?: string[]
  head: string
  reason?: string
  status: ForkUpdateStatus
}

export type ForkUpdateDecision =
  /** `remember` is a runtime commit that changed nothing the desktop ships: no need to ask git about it again. */
  | { action: 'none'; reason: string; remember?: string }
  /** An update to `head` is already running (a helper wrote its heartbeat moments ago): do not boot the stale app under it. */
  | { action: 'busy'; head: string; since: number }
  | { action: 'update'; desktopCommitsBehind: number; head: string; repoRoot: string; stampCommit: string }

export interface GitResult {
  code: null | number
  stdout: string
}

export interface ForkUpdateFacts {
  env: NodeJS.ProcessEnv
  execPath: string
  exists: (file: string) => boolean
  git: (args: string[], cwd: string) => GitResult
  isPackaged: boolean
  now: number
  platform: NodeJS.Platform
  readText: (file: string) => null | string
  resourcesPath: string
  runtimeRoot: string
  statePath: string
}

// ── the decision (pure) ─────────────────────────────────────────────────────────────────

const isOff = (value: string | undefined) => /^(?:0|false|no|off)$/i.test(String(value ?? '').trim())

/** <repo>/apps/desktop/release/win-unpacked/Hermes.exe -> <repo>, only when the fork's updater is there. */
export function forkRepoFor(
  execPath: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean
): null | string {
  const candidates = [env.HERMES_FORK_REPO, path.resolve(path.dirname(execPath), '..', '..', '..', '..')].filter(
    (candidate): candidate is string => Boolean(candidate)
  )

  return candidates.find(candidate => exists(path.join(candidate, HELPER))) ?? null
}

/** `JSON.parse` rejects a leading byte-order mark, which Windows PowerShell's `-Encoding utf8` writes. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export function parseForkUpdateState(raw: null | string): ForkUpdateState | null {
  if (!raw) {
    return null
  }

  try {
    const value = JSON.parse(stripBom(raw))

    return value && typeof value.head === 'string' && typeof value.status === 'string' && typeof value.at === 'number'
      ? (value as ForkUpdateState)
      : null
  } catch {
    return null
  }
}

/**
 * Should this launch update the fork first? The same proof the app's own "bundle out of date"
 * check uses (bundle-skew.ts): commits touching the shipped desktop paths exist in the runtime
 * AFTER the commit this bundle was stamped with, and the stamp is an ancestor of the runtime's
 * HEAD. Anything unknowable reads as "no", never as "update": this must not trigger a rebuild
 * on a guess.
 */
export function decideForkUpdate(facts: ForkUpdateFacts): ForkUpdateDecision {
  const none = (reason: string): ForkUpdateDecision => ({ action: 'none', reason })

  if (!facts.isPackaged || facts.platform !== 'win32') {
    return none('not a packaged Windows build')
  }

  if (isOff(facts.env.HERMES_FORK_UPDATE)) {
    return none('switched off (HERMES_FORK_UPDATE)')
  }

  const repoRoot = forkRepoFor(facts.execPath, facts.env, facts.exists)

  if (!repoRoot) {
    return none('this build is not inside a fork checkout')
  }

  const stampCommit = (() => {
    try {
      const raw = facts.readText(path.join(facts.resourcesPath, 'install-stamp.json'))

      return String(JSON.parse(raw ? stripBom(raw) : '{}').commit ?? '')
    } catch {
      return ''
    }
  })()

  if (!/^[0-9a-f]{40}$/.test(stampCommit) || /^0+$/.test(stampCommit)) {
    return none('the bundle has no usable build stamp')
  }

  const headResult = facts.git(['rev-parse', 'HEAD'], facts.runtimeRoot)
  const head = headResult.stdout.trim()

  if (headResult.code !== 0 || !/^[0-9a-f]{40}$/.test(head)) {
    return none('the runtime checkout is unreadable')
  }

  if (head === stampCommit) {
    return none('the bundle is on the runtime commit')
  }

  const state = parseForkUpdateState(facts.readText(facts.statePath))

  if (state?.head === head) {
    // 'done' belongs here too: an update that finished for this very commit and left a bundle that
    // still reports an older stamp must not be run again, launch after launch.
    if (state.status === 'failed' || state.status === 'current' || state.status === 'done') {
      return none(`already looked at ${head.slice(0, 8)}: ${state.status}`)
    }

    if (state.status === 'running' && facts.now - state.at < RUNNING_FRESH_MS) {
      return { action: 'busy', head, since: state.at }
    }
  }

  // Fail-quiet, like the app's own skew check: an unknown or unrelated stamp is not proof of anything.
  if (facts.git(['merge-base', '--is-ancestor', stampCommit, head], facts.runtimeRoot).code !== 0) {
    return none('the stamp commit is not an ancestor of the runtime (unknowable)')
  }

  const count = Number.parseInt(
    facts
      .git(['rev-list', '--count', `${stampCommit}..${head}`, '--', ...RUNTIME_PATHS], facts.runtimeRoot)
      .stdout.trim(),
    10
  )

  if (!(count > 0)) {
    return { action: 'none', reason: 'the runtime moved, but nothing the desktop ships changed', remember: head }
  }

  return { action: 'update', desktopCommitsBehind: count, head, repoRoot, stampCommit }
}

// ── words (the window and the notices) ──────────────────────────────────────────────────

type Language = 'en' | 'it'

const WORDS = {
  en: {
    busyBody: (since: string) =>
      `Hermes (Mullvad) is being updated (started at ${since}). Open it again in a few minutes; it reopens by itself when it is done.`,
    busyTitle: 'Updating',
    conflictReason: (count: number) =>
      `The fork does not apply cleanly on the new official code: ${count} file(s) conflict:`,
    consoleTitle: 'Hermes (Mullvad) - update',
    deferredBody:
      'The VPN was not connected, so the update waits for the next launch. Hermes (Mullvad) keeps working as it was.',
    deferredTitle: 'Fork update postponed',
    failedBody: (reason: string) =>
      `Hermes (Mullvad) could not be updated to the new official version, and keeps working as it was.\n\n${reason}\n\nAsk Claude to "align the fork".`,
    failedTitle: 'Fork update did not go through',
    windowBody:
      'Hermes was updated. The fork is being rebuilt on the new code: about 8 minutes, then it reopens by itself.',
    windowHint: 'Progress is in the black window that opens next to this one.',
    windowTitle: 'Updating Hermes (Mullvad)'
  },
  it: {
    busyBody: (since: string) =>
      `Hermes (Mullvad) si sta aggiornando (iniziato alle ${since}). Riaprilo tra qualche minuto: si riapre da solo a fine aggiornamento.`,
    busyTitle: 'Aggiornamento in corso',
    conflictReason: (count: number) =>
      `Il fork non si applica pulito sul codice ufficiale nuovo: ${count} file in conflitto:`,
    consoleTitle: 'Hermes (Mullvad) - aggiornamento',
    deferredBody:
      'La VPN non era connessa, quindi l’aggiornamento aspetta il prossimo avvio. Hermes (Mullvad) funziona come prima.',
    deferredTitle: 'Aggiornamento del fork rimandato',
    failedBody: (reason: string) =>
      `Non sono riuscito ad aggiornare Hermes (Mullvad) alla nuova versione ufficiale: continua a funzionare come prima.\n\n${reason}\n\nScrivi a Claude: "allinea il fork".`,
    failedTitle: 'Aggiornamento del fork non riuscito',
    windowBody:
      'Hermes è stato aggiornato. Sto ricompilando il fork sul codice nuovo: ci vogliono circa 8 minuti, poi si riapre da solo.',
    windowHint: 'L’avanzamento è nella finestra nera che si apre accanto a questa.',
    windowTitle: 'Aggiorno Hermes (Mullvad)'
  }
} as const

export const languageFor = (locale: string): Language => (/^it\b/i.test(locale) ? 'it' : 'en')

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, c => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)

export function updatingWindowHtml(language: Language): string {
  const t = WORDS[language]

  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>${escapeHtml(t.windowTitle)}</title>
<style>
  html,body{height:100%;margin:0;background:#14171c;color:#e6e8eb;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
  main{height:100%;box-sizing:border-box;padding:34px 38px;display:flex;flex-direction:column;justify-content:center;gap:14px}
  h1{margin:0;font-size:20px;font-weight:600}
  p{margin:0;color:#a9afb8}
  .hint{font-size:13px;color:#7f8791}
  .spin{width:26px;height:26px;border:3px solid #2b3038;border-top-color:#e100ff;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
<main><div class="spin" role="status"></div><h1>${escapeHtml(t.windowTitle)}</h1><p>${escapeHtml(t.windowBody)}</p><p class="hint">${escapeHtml(t.windowHint)}</p></main></html>`
}

// ── Hermes' managed Node (what the official updater builds with) ──────────────────────────

/** Newest %LOCALAPPDATA%\hermes\tools\node-*-win32-x64\node.exe, else whatever `node` is on PATH. */
export function findHelperNode(
  env: NodeJS.ProcessEnv,
  readdir: (dir: string) => string[],
  exists: (file: string) => boolean
): string {
  const local = env.LOCALAPPDATA

  if (local) {
    const tools = path.join(local, 'hermes', 'tools')

    const versions = readdir(tools)
      .map(name => ({ match: /^node-(\d+)\.(\d+)\.(\d+)-win32-x64$/.exec(name), name }))
      .filter(entry => entry.match)
      .sort((a, b) => {
        for (let i = 1; i <= 3; i++) {
          const delta = Number(b.match![i]) - Number(a.match![i])

          if (delta) {
            return delta
          }
        }

        return 0
      })

    for (const { name } of versions) {
      const node = path.join(tools, name, 'node.exe')

      if (exists(node)) {
        return node
      }
    }
  }

  return 'node'
}

// ── the shell (side effects) ────────────────────────────────────────────────────────────

type UpdateWindow = InstanceType<ForkUpdateShell['BrowserWindow']>

export interface ForkUpdateShell {
  app: { exit: (code?: number) => void; getLocale: () => string; relaunch: () => void }
  BrowserWindow: new (options: Electron.BrowserWindowConstructorOptions) => {
    close: () => void
    isDestroyed: () => boolean
    loadURL: (url: string) => Promise<void>
  }
  dialog: { showMessageBox: (options: Electron.MessageBoxOptions) => Promise<unknown> }
  env: NodeJS.ProcessEnv
  execPath: string
  /** Runs git in a directory. Defaults to the real binary (`gitBinary`); injectable for tests. */
  git?: ForkUpdateFacts['git']
  gitBinary: () => string
  hermesHome: string
  isPackaged: boolean
  /** Truthy while the official hand-off script still owns the update marker. */
  liveUpdate: () => unknown
  log: (message: string) => void
  resolveRuntimeRoot: () => string
  resourcesPath: string
  /** Starts the tunnel (single-flight); the helper checks it is up before it builds. */
  startVpn: () => void
  userDataDir: string
  vpnRequired: () => boolean
}

function gitRunner(binary: string) {
  return (args: string[], cwd: string): GitResult => {
    const r = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 20_000, windowsHide: true })

    return { code: r.error ? null : r.status, stdout: r.stdout ?? '' }
  }
}

function readText(file: string): null | string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function writeState(statePath: string, state: ForkUpdateState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function createForkUpdate(shell: ForkUpdateShell) {
  const statePath = path.join(shell.userDataDir, STATE_FILE)
  const logPath = path.join(shell.userDataDir, LOG_FILE)
  const log = (message: string) => shell.log(`[fork-update] ${message}`)

  const git: ForkUpdateFacts['git'] = (args, cwd) => (shell.git ?? gitRunner(shell.gitBinary()))(args, cwd)

  const facts = (): ForkUpdateFacts => ({
    env: shell.env,
    execPath: shell.execPath,
    exists: file => fs.existsSync(file),
    git,
    isPackaged: shell.isPackaged,
    now: Date.now(),
    platform: process.platform,
    readText,
    resourcesPath: shell.resourcesPath,
    runtimeRoot: shell.resolveRuntimeRoot(),
    statePath
  })

  const record = (state: ForkUpdateState) => {
    try {
      writeState(statePath, state)
    } catch (error) {
      log(`could not write ${statePath}: ${(error as Error).message}`)
    }
  }

  function spawnHelper(decision: Extract<ForkUpdateDecision, { action: 'update' }>, runtimeRoot: string): void {
    const node = findHelperNode(
      shell.env,
      dir => {
        try {
          return fs.readdirSync(dir)
        } catch {
          return []
        }
      },
      file => fs.existsSync(file)
    )

    const args = [
      path.join(decision.repoRoot, HELPER),
      '--pid',
      String(process.pid),
      '--exe',
      shell.execPath,
      '--repo',
      decision.repoRoot,
      '--runtime',
      runtimeRoot,
      '--target',
      decision.head,
      '--state',
      statePath,
      '--marker',
      path.join(shell.hermesHome, '.hermes-update-in-progress'),
      '--vpn',
      shell.vpnRequired() ? 'required' : 'off',
      '--lang',
      languageFor(shell.app.getLocale()),
      ...(shell.env.HERMES_FORK_UPDATE_SYNC ? ['--sync', shell.env.HERMES_FORK_UPDATE_SYNC] : []),
      ...(isOff(shell.env.HERMES_FORK_UPDATE_RELAUNCH) ? ['--no-relaunch'] : [])
    ]

    const cwd = decision.repoRoot
    const language = languageFor(shell.app.getLocale())

    // A fresh log for this run (the previous one is kept next to it): the progress window reads it from the top.
    try {
      fs.renameSync(logPath, logPath.replace(/\.log$/, '.previous.log'))
    } catch {
      void 0
    }

    // The update runs HIDDEN. Closing a console window kills what is attached to it, and an updater cut
    // off in the middle of a rebuild leaves the fork half moved; so no window is the updater's own.
    // `detached` is what lets it outlive this app: on Windows Node puts every child that is NOT detached
    // in a job object that kills it when the parent exits, and this app quits seconds from now.
    const worker = spawn(node, [...args, '--log', logPath], {
      cwd,
      detached: true,
      env: shell.env,
      stdio: 'ignore',
      windowsHide: true
    })

    worker.on('error', error => {
      // The updater never started: do not strand the user on the update window.
      log(`the updater could not start: ${error.message}`)
      record({
        at: Date.now(),
        head: decision.head,
        reason: `the updater could not start (${error.message})`,
        status: 'failed'
      })
      shell.app.relaunch()
      shell.app.exit(0)
    })

    worker.unref()

    // The progress window only SHOWS the log (fork/tail.mjs). `start` with a title opens it in its own
    // visible console; the wrapper cmd.exe is hidden and exits at once. Same wrapper the official
    // hand-off uses, minus /b. Closing it early changes nothing.
    const viewer = spawn(
      'cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        'start',
        WORDS[language].consoleTitle,
        node,
        path.join(decision.repoRoot, VIEWER),
        '--log',
        logPath,
        '--state',
        statePath,
        '--target',
        decision.head,
        '--lang',
        language
      ],
      { cwd, env: shell.env, stdio: 'ignore', windowsHide: true }
    )

    viewer.on('error', error => log(`the progress window could not start: ${error.message}`))
    viewer.unref()
  }

  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return {
    /**
     * Who updates this build, when the fork has a say in it. A build that does not sit in a fork
     * checkout (an installer somebody was given) has nothing to rebuild itself from: the official
     * "Update now" there would update the runtime, relaunch this stale bundle and go round again.
     * It answers 'external' ("updates are managed by the package owner"). A build inside the
     * checkout, an unpackaged run, or a run with the self-update switched off leaves the stamp's
     * answer alone (`undefined`).
     */
    updateMechanism(): 'external' | undefined {
      if (!shell.isPackaged || process.platform !== 'win32' || isOff(shell.env.HERMES_FORK_UPDATE)) {
        return undefined
      }

      try {
        if (forkRepoFor(shell.execPath, shell.env, file => fs.existsSync(file))) {
          return undefined
        }
      } catch {
        return undefined
      }

      log(
        'this build is not inside a fork checkout: the official update would leave it stale, so updates are owner-managed'
      )

      return 'external'
    },

    /**
     * One-time notice about the last update attempt, if it ended badly and the user has not been told.
     * Call once the app is ready.
     */
    announceLastResult(): void {
      const state = parseForkUpdateState(readText(statePath))

      if (!state || state.announced || (state.status !== 'failed' && state.status !== 'deferred')) {
        return
      }

      record({ ...state, announced: true })

      const t = WORDS[languageFor(shell.app.getLocale())]
      const failed = state.status === 'failed'
      const conflicts = state.conflicts ?? []

      // A conflict has a plain-language line of its own; any other reason is sync.mjs' own words.
      const reason = [conflicts.length ? t.conflictReason(conflicts.length) : state.reason, ...conflicts.slice(0, 8)]
        .filter(Boolean)
        .join('\n')

      void shell.dialog
        .showMessageBox({
          buttons: ['OK'],
          detail: failed ? t.failedBody(reason || '—') : t.deferredBody,
          message: failed ? t.failedTitle : t.deferredTitle,
          type: failed ? 'warning' : 'info'
        })
        .catch(() => undefined)
    },

    /**
     * Returns true when this launch was taken over (handed to the updater, or refused because an
     * update is already running): the caller must then boot nothing. Never throws: a bug here must
     * not stop the app from opening.
     */
    takeOverIfStale(): boolean {
      let decision: ForkUpdateDecision

      try {
        decision = decideForkUpdate(facts())
      } catch (error) {
        log(`could not decide: ${(error as Error).message}`)

        return false
      }

      if (decision.action === 'none') {
        log(`no update: ${decision.reason}`)

        // The runtime moved without desktop changes: remember it so the next launch skips the git calls.
        if (decision.remember) {
          record({ at: Date.now(), head: decision.remember, status: 'current' })
        }

        return false
      }

      if (decision.action === 'busy') {
        const t = WORDS[languageFor(shell.app.getLocale())]

        log(`an update to ${decision.head.slice(0, 8)} is already running; not booting the old build under it`)
        void shell.dialog
          .showMessageBox({
            buttons: ['OK'],
            message: t.busyTitle,
            detail: t.busyBody(clock(decision.since)),
            type: 'info'
          })
          .catch(() => undefined)
          .then(() => shell.app.exit(0))

        return true
      }

      const startedAt = Date.now()
      let window: null | UpdateWindow = null

      try {
        const runtimeRoot = shell.resolveRuntimeRoot()

        log(
          `${decision.desktopCommitsBehind} desktop commit(s) behind the runtime ` +
            `(${decision.stampCommit.slice(0, 8)} -> ${decision.head.slice(0, 8)}): updating the fork before boot`
        )
        record({ at: startedAt, head: decision.head, status: 'running' })

        shell.startVpn()

        const officialStillRunning = Boolean(shell.liveUpdate())
        const language = languageFor(shell.app.getLocale())

        window = new shell.BrowserWindow({
          autoHideMenuBar: true,
          backgroundColor: '#14171c',
          height: 300,
          maximizable: false,
          resizable: false,
          show: true,
          title: WORDS[language].windowTitle,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          width: 560
        })

        void window
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(updatingWindowHtml(language))}`)
          .catch(() => undefined)

        spawnHelper(decision, runtimeRoot)

        // Quit once the helper has had time to start and the official script is done with the marker.
        const waitMs = officialStillRunning ? OFFICIAL_SCRIPT_GRACE_MS : QUIT_AFTER_MS

        const timer = setInterval(() => {
          const elapsed = Date.now() - startedAt

          if ((elapsed >= waitMs && !shell.liveUpdate()) || elapsed >= QUIT_AT_MOST_MS) {
            clearInterval(timer)
            shell.app.exit(0)
          }
        }, 1000)

        return true
      } catch (error) {
        log(`could not hand over to the updater: ${(error as Error).message}`)
        record({ at: Date.now(), head: decision.head, reason: (error as Error).message, status: 'failed' })

        if (window && !window.isDestroyed()) {
          window.close()
        }

        return false
      }
    }
  }
}
