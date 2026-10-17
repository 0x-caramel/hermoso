/**
 * Ghost (main process, Electron-free): a window that keeps nothing.
 *
 * A ghost is a second Hermoso, started by the first, whose Hermes home and app data live in a temporary folder of
 * their own. Its chats, memories, logs, snapshots and browser storage go there and nowhere else, and the folder is
 * deleted when the ghost closes, on the panic key, or (if the computer went off first) at the next start.
 *
 * What it needs from the person's own setup is only what lets it talk to the model: the Hermes config, the keys and
 * the sign-in file, and the VPN requirement. Those are COPIED into the temporary folder for the session, and go with
 * it. Nothing is ever moved or changed in the real home.
 *
 * Said plainly, because a mode about privacy must not oversell: what is deleted is deleted, not shredded (a solid-state
 * disk may keep traces); the model's provider still sees whatever is sent to it; files the agent writes in a project
 * folder stay there. Ghost keeps nothing of the conversation ON THIS COMPUTER.
 *
 * Every deletion here is guarded: it only ever touches a folder that is a direct child of the temporary root, named
 * like a ghost's, and is not a link. A wrong path in an environment variable can never wipe anything else.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Set, in a ghost's own environment only, to the folder that is the ghost. */
export const GHOST_ENV = 'HERMOSO_GHOST'

/** For tests: a debugging port the ghost's window can be driven through. Never set by the app itself. */
export const GHOST_DEBUG_PORT_ENV = 'HERMOSO_GHOST_DEBUG_PORT'

export const GHOST_PREFIX = 'hermoso-ghost-'
export const PANIC_KEY = 'CommandOrControl+Alt+Shift+Backspace'

/** What a ghost needs to talk to the model: the setup, the keys, the sign-in file. */
const FROM_HOME = ['config.yaml', '.env', 'auth.json']

/** And from the app's data folder: whether the VPN is required. */
const FROM_USER_DATA = ['vpn.json']

const MAX_COPIED_BYTES = 1_000_000

/** Flags of the app that started it which a ghost keeps: how the window is drawn and whether it is sandboxed. */
const PASS_ALONG = new Set(['--disable-gpu', '--no-sandbox'])

/** A ghost folder that nobody owns for this long is forgotten, even if the computer went off in the middle of it. */
const STALE_AFTER_MS = 2 * 60_000

const ID = /^[0-9a-f]{12}$/

export interface GhostPaths {
  dir: string
  home: string
  id: string
  userData: string
}

const marker = (dir: string) => path.join(dir, 'ghost.json')

/** Whether `dir` is a ghost's folder under `tmpRoot`: a direct child, named like one, not a link. Guards every wipe. */
export function isGhostDir(dir: string, tmpRoot: string): boolean {
  try {
    const resolved = path.resolve(dir)

    if (path.dirname(resolved) !== path.resolve(tmpRoot)) {
      return false
    }

    const name = path.basename(resolved)

    if (!name.startsWith(GHOST_PREFIX) || !ID.test(name.slice(GHOST_PREFIX.length))) {
      return false
    }

    return fs.lstatSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function copyIfSound(from: string, to: string): boolean {
  try {
    const stat = fs.lstatSync(from)

    if (!stat.isFile() || stat.size > MAX_COPIED_BYTES) {
      return false
    }

    fs.copyFileSync(from, to)

    return true
  } catch {
    return false
  }
}

export interface CreateOptions {
  now?: () => number
  ownerPid?: number
  randomId?: () => string
  sourceHome: string
  sourceUserData: string
  tmpRoot?: string
}

/** The ghost's folders, with the few files it needs copied in. Never touches the sources. */
export function createGhost(options: CreateOptions): GhostPaths & { copied: string[] } {
  const tmpRoot = options.tmpRoot ?? os.tmpdir()
  const id = (options.randomId ?? (() => crypto.randomBytes(6).toString('hex')))()
  const dir = path.join(tmpRoot, GHOST_PREFIX + id)
  const home = path.join(dir, 'hermes-home')
  const userData = path.join(dir, 'user-data')

  fs.mkdirSync(home, { mode: 0o700, recursive: true })
  fs.mkdirSync(userData, { mode: 0o700, recursive: true })

  const copied: string[] = []

  for (const name of FROM_HOME) {
    if (copyIfSound(path.join(options.sourceHome, name), path.join(home, name))) {
      copied.push(name)
    }
  }

  for (const name of FROM_USER_DATA) {
    if (copyIfSound(path.join(options.sourceUserData, name), path.join(userData, name))) {
      copied.push(name)
    }
  }

  fs.writeFileSync(
    marker(dir),
    JSON.stringify({ createdAt: (options.now ?? Date.now)(), owner: options.ownerPid ?? process.pid }),
    'utf8'
  )

  return { copied, dir, home, id, userData }
}

/** The ghost app says that it is the owner now (the one that started it may be gone while it lives). */
export function claimGhost(dir: string, pid: number, now: () => number = Date.now): void {
  try {
    const current = JSON.parse(fs.readFileSync(marker(dir), 'utf8'))

    fs.writeFileSync(marker(dir), JSON.stringify({ ...current, claimedAt: now(), owner: pid }), 'utf8')
  } catch {
    // no marker: the sweep will treat the folder as unowned, which is the safe way to be wrong
  }
}

/** The environment of the ghost app: its own home and data folder, and the one variable that makes it a ghost. */
export function ghostEnv(base: NodeJS.ProcessEnv, ghost: GhostPaths, debugPort?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    HERMES_DESKTOP_USER_DATA_DIR: ghost.userData,
    HERMES_HOME: ghost.home,
    [GHOST_ENV]: ghost.dir
  }

  // A ghost never inherits a debugging port by accident, and never another ghost's marker.
  delete env[GHOST_DEBUG_PORT_ENV]

  if (debugPort === undefined) {
    return env
  }

  return { ...env, [GHOST_DEBUG_PORT_ENV]: String(debugPort) }
}

// ── deleting ────────────────────────────────────────────────────────────────────────────────────

export interface Cleaner {
  args: string[]
  file: string
  /** Windows needs the command line passed as it is, not re-quoted. */
  verbatim: boolean
}

/**
 * The detached helper that deletes the folder once the ghost's processes have let go of it (on Windows an open file
 * cannot be removed). It retries for about a minute and then gives up; the sweep at the next start is the backstop.
 * The folder name goes through an encoded command, so no quote in a user name can break it.
 */
export function cleanerFor(dir: string, platform: NodeJS.Platform = process.platform): Cleaner {
  if (platform === 'win32') {
    const quoted = `'${dir.replace(/'/g, "''")}'`

    const script =
      `for ($i = 0; $i -lt 30; $i++) { ` +
      `Remove-Item -LiteralPath ${quoted} -Recurse -Force -ErrorAction SilentlyContinue; ` +
      `if (-not (Test-Path -LiteralPath ${quoted})) { break }; Start-Sleep -Seconds 2 }`

    const encode = (text: string) => Buffer.from(text, 'utf16le').toString('base64')
    const innerEncoded = encode(script)

    // A child of the ghost inherits the ghost's open handles, files in the very folder it has to delete, and would hold
    // them open until it ended: it would wait for itself. So the first helper only starts the real one through
    // Start-Process (a fresh process that inherits nothing) and ends at once.
    const launcher =
      `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}'`

    return {
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(launcher)],
      file: 'powershell.exe',
      verbatim: false
    }
  }

  return {
    args: ['-c', 'for i in $(seq 1 30); do rm -rf "$1" 2>/dev/null; [ -e "$1" ] || exit 0; sleep 2; done', 'sh', dir],
    file: 'sh',
    verbatim: false
  }
}

export type SpawnFn = (
  file: string,
  args: string[],
  options: Record<string, unknown>
) => { on?: (event: string, listener: () => void) => unknown; unref?: () => void }

/**
 * How long a quitting app waits for the first helper to have started the real one. A helper that is still starting when
 * its parent exits is killed with it (Windows ties the children a program starts to its own life), so the caller waits.
 */
const CLEANER_START_MS = 5_000

/**
 * Delete the ghost's folder as soon as the ghost's processes have ended, whatever happens to this one. Resolves when the
 * helper is on its way (on Windows: when its first stage has handed the work to a process of its own), so that the
 * caller can quit at once without taking the helper with it. False when there was nothing safe to start.
 */
export function wipeLater(
  dir: string,
  tmpRoot: string,
  deps: { platform?: NodeJS.Platform; spawn?: SpawnFn; startMs?: number } = {}
): Promise<boolean> {
  if (!isGhostDir(dir, tmpRoot)) {
    return Promise.resolve(false)
  }

  const platform = deps.platform ?? process.platform
  const cleaner = cleanerFor(dir, platform)

  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (value: boolean) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
    }

    try {
      // On Windows a DETACHED_PROCESS has no console, and PowerShell silently does nothing without one; a hidden console
      // (windowsHide) is what it needs. Its first stage then starts the real helper, which outlives the ghost.
      const child = (deps.spawn ?? (nodeSpawn as unknown as SpawnFn))(cleaner.file, cleaner.args, {
        detached: platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true
      })

      child.unref?.()

      if (platform === 'win32' && typeof child.on === 'function') {
        child.on('exit', () => settle(true))
        child.on('error', () => settle(false))
        timer = setTimeout(() => settle(true), deps.startMs ?? CLEANER_START_MS)
        timer.unref?.()
      } else {
        settle(true)
      }
    } catch {
      settle(false)
    }
  })
}

/** Delete the ghost's folder now, as far as it can be (an open file stays; the sweep finishes the job later). */
export function wipeNow(dir: string, tmpRoot: string): boolean {
  if (!isGhostDir(dir, tmpRoot)) {
    return false
  }

  try {
    fs.rmSync(dir, { force: true, maxRetries: 3, recursive: true, retryDelay: 150 })
  } catch {
    // locked: the helper or the next sweep gets it
  }

  return !fs.existsSync(dir)
}

export interface SweepOptions {
  isAlive: (pid: number) => boolean
  now?: () => number
  tmpRoot?: string
  wipe?: (dir: string) => void
}

/** At start: ghost folders that nobody owns any more (the computer went off, the app was killed) are deleted. */
export function sweepStale(options: SweepOptions): string[] {
  const tmpRoot = options.tmpRoot ?? os.tmpdir()
  const now = (options.now ?? Date.now)()
  const wiped: string[] = []

  let names: string[] = []

  try {
    names = fs.readdirSync(tmpRoot)
  } catch {
    return wiped
  }

  for (const name of names) {
    const dir = path.join(tmpRoot, name)

    if (!name.startsWith(GHOST_PREFIX) || !isGhostDir(dir, tmpRoot)) {
      continue
    }

    let owner = 0
    let since = 0

    try {
      const info = JSON.parse(fs.readFileSync(marker(dir), 'utf8'))

      owner = Number.isInteger(info.owner) ? info.owner : 0
      since = Number(info.claimedAt ?? info.createdAt) || 0
    } catch {
      // no readable marker: owned by nobody, and as old as the folder (one being made right now is not stale)
      try {
        since = fs.statSync(dir).mtimeMs
      } catch {
        since = 0
      }
    }

    const young = since > 0 && now - since < STALE_AFTER_MS

    if (young || (owner > 0 && options.isAlive(owner))) {
      continue
    }

    if (options.wipe) {
      options.wipe(dir)
    } else {
      wipeNow(dir, tmpRoot)
    }

    wiped.push(dir)
  }

  return wiped
}

/** Whether a process with this id is running (signal 0 asks without sending anything). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── opening ─────────────────────────────────────────────────────────────────────────────────────

export interface LaunchDeps {
  /** The app's own path, for a run from source (`electron <appPath>`); unused by a packaged app. */
  appPath: string
  debugPort?: number
  env: NodeJS.ProcessEnv
  execPath: string
  /** The command line of the app that starts it: only the flags in PASS_ALONG are handed on. */
  flags?: readonly string[]
  now?: () => number
  packaged: boolean
  randomId?: () => string
  sourceHome: string
  sourceUserData: string
  spawn?: SpawnFn
  tmpRoot?: string
}

export type LaunchResult = { dir: string; ok: true; pid: null | number } | { code: string; message: string; ok: false }

/** Start a ghost: its folders, then a second Hermoso whose world is those folders. */
export function launchGhost(deps: LaunchDeps): LaunchResult {
  const tmpRoot = deps.tmpRoot ?? os.tmpdir()
  let ghost: ReturnType<typeof createGhost>

  try {
    ghost = createGhost({
      now: deps.now,
      randomId: deps.randomId,
      sourceHome: deps.sourceHome,
      sourceUserData: deps.sourceUserData,
      tmpRoot
    })
  } catch (error) {
    return { code: 'no-folder', message: `Could not make the ghost's folder: ${(error as Error).message}`, ok: false }
  }

  if (!ghost.copied.includes('config.yaml')) {
    wipeNow(ghost.dir, tmpRoot)

    return {
      code: 'no-setup',
      message: 'There is no Hermes setup to copy yet: set up a model first, then open a ghost.',
      ok: false
    }
  }

  // From source the app is `electron <path>`; packaged, the executable is the app.
  const args = [
    ...(deps.packaged ? [] : [deps.appPath]),
    '--hermoso-ghost',
    ...(deps.flags ?? []).filter(flag => PASS_ALONG.has(flag))
  ]

  if (deps.debugPort !== undefined) {
    args.push(`--remote-debugging-port=${deps.debugPort}`)
  }

  try {
    const child = (deps.spawn ?? (nodeSpawn as unknown as SpawnFn))(deps.execPath, args, {
      detached: true,
      env: ghostEnv(deps.env, ghost, deps.debugPort),
      stdio: 'ignore'
    }) as { pid?: number; unref?: () => void }

    child.unref?.()

    return { dir: ghost.dir, ok: true, pid: child.pid ?? null }
  } catch (error) {
    wipeNow(ghost.dir, tmpRoot)

    return { code: 'no-launch', message: `Could not start the ghost: ${(error as Error).message}`, ok: false }
  }
}
