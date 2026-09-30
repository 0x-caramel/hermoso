import type * as ChildProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { RUNTIME_PATHS } from './bundle-skew'

const spawned: { args: string[]; command: string; options: Record<string, unknown> }[] = []
let spawnError: Error | null = null

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof ChildProcess>()

  return {
    ...original,
    spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ args, command, options })

      const handlers: Record<string, (error: Error) => void> = {}

      if (spawnError) {
        const error = spawnError

        queueMicrotask(() => handlers.error?.(error))
      }

      return {
        on: (event: string, handler: (error: Error) => void) => {
          handlers[event] = handler
        },
        unref: () => undefined
      }
    })
  }
})

const {
  createForkUpdate,
  decideForkUpdate,
  findHelperNode,
  forkRepoFor,
  languageFor,
  parseForkUpdateState,
  RUNNING_FRESH_MS,
  updatingWindowHtml
} = await import('./fork-update')

const STAMP = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const REPO = path.resolve('C:/repo')
const EXE = path.join(REPO, 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe')
const HELPER = path.join(REPO, 'apps', 'desktop', 'fork', 'update.mjs')

type Git = (args: string[], cwd: string) => { code: null | number; stdout: string }

/** A runtime checkout that answers per git subcommand. */
function runtime({
  ancestor = true,
  count = 12,
  head = HEAD,
  headFails = false
}: { ancestor?: boolean; count?: number; head?: string; headFails?: boolean } = {}) {
  const calls: string[][] = []

  const git: Git = args => {
    calls.push(args)

    if (args[0] === 'rev-parse') {
      return headFails ? { code: 128, stdout: '' } : { code: 0, stdout: `${head}\n` }
    }

    if (args[0] === 'merge-base') {
      return { code: ancestor ? 0 : 1, stdout: '' }
    }

    if (args[0] === 'rev-list') {
      return { code: 0, stdout: `${count}\n` }
    }

    return { code: 1, stdout: '' }
  }

  return { calls, git }
}

function facts(overrides: Record<string, unknown> = {}, git: Git = runtime().git) {
  return {
    env: {} as NodeJS.ProcessEnv,
    execPath: EXE,
    exists: (file: string) => file === HELPER,
    git,
    isPackaged: true,
    now: 1_000_000,
    platform: 'win32' as NodeJS.Platform,
    readText: (file: string) => (file.endsWith('install-stamp.json') ? JSON.stringify({ commit: STAMP }) : null),
    resourcesPath: path.join(REPO, 'resources'),
    runtimeRoot: path.resolve('C:/runtime'),
    statePath: path.join(REPO, 'state', 'fork-update.json'),
    ...overrides
  }
}

describe('decideForkUpdate', () => {
  it('updates when the runtime holds desktop changes the bundle was built without', () => {
    expect(decideForkUpdate(facts())).toEqual({
      action: 'update',
      desktopCommitsBehind: 12,
      head: HEAD,
      repoRoot: REPO,
      stampCommit: STAMP
    })
  })

  it('asks git the same question the app’s own "bundle out of date" check asks', () => {
    const rt = runtime()

    decideForkUpdate(facts({}, rt.git))

    expect(rt.calls).toContainEqual(['merge-base', '--is-ancestor', STAMP, HEAD])
    expect(rt.calls).toContainEqual(['rev-list', '--count', `${STAMP}..${HEAD}`, '--', ...RUNTIME_PATHS])
  })

  it.each([
    ['an unpackaged build', { isPackaged: false }, /not a packaged Windows build/],
    ['another platform', { platform: 'linux' }, /not a packaged Windows build/],
    ['a build outside any fork checkout', { exists: () => false }, /not inside a fork checkout/],
    ['an explicit off switch', { env: { HERMES_FORK_UPDATE: 'off' } }, /switched off/]
  ])('does nothing for %s', (_name, patch, reason) => {
    const decision = decideForkUpdate(facts(patch))

    expect(decision.action).toBe('none')
    expect((decision as { reason: string }).reason).toMatch(reason)
  })

  it('finds the fork checkout through HERMES_FORK_REPO when the exe is not where it was built', () => {
    const elsewhere = path.resolve('D:/moved/Hermes.exe')
    const exists = (file: string) => file === HELPER

    expect(forkRepoFor(elsewhere, {}, exists)).toBeNull()
    expect(forkRepoFor(elsewhere, { HERMES_FORK_REPO: REPO }, exists)).toBe(REPO)
    expect(forkRepoFor(EXE, {}, exists)).toBe(REPO)
  })

  it.each([
    ['a bundle without a stamp', () => null],
    ['a stamp of zeros (a non-git build)', () => JSON.stringify({ commit: '0'.repeat(40) })],
    ['a stamp that is not a commit', () => JSON.stringify({ commit: 'main' })],
    ['an unreadable stamp', () => '{not json']
  ])('does nothing for %s', (_name, stamp) => {
    const decision = decideForkUpdate(
      facts({ readText: (file: string) => (file.endsWith('install-stamp.json') ? stamp() : null) })
    )

    expect(decision).toMatchObject({ action: 'none', reason: expect.stringMatching(/no usable build stamp/) })
  })

  it('reads a stamp that starts with a byte-order mark (what Windows PowerShell writes)', () => {
    const decision = decideForkUpdate(
      facts({
        readText: (file: string) =>
          file.endsWith('install-stamp.json') ? String.fromCharCode(0xfeff) + JSON.stringify({ commit: STAMP }) : null
      })
    )

    expect(decision).toMatchObject({ action: 'update' })
  })

  it('does nothing when the runtime checkout cannot be read', () => {
    expect(decideForkUpdate(facts({}, runtime({ headFails: true }).git))).toMatchObject({
      action: 'none',
      reason: expect.stringMatching(/unreadable/)
    })
  })

  it('does nothing, without asking git anything else, when the bundle is already on the runtime commit', () => {
    const rt = runtime({ head: STAMP })

    expect(decideForkUpdate(facts({}, rt.git))).toMatchObject({
      action: 'none',
      reason: expect.stringMatching(/on the runtime commit/)
    })
    expect(rt.calls).toEqual([['rev-parse', 'HEAD']])
  })

  it('treats an unrelated stamp as unknowable, never as a reason to rebuild', () => {
    expect(decideForkUpdate(facts({}, runtime({ ancestor: false }).git))).toMatchObject({
      action: 'none',
      reason: expect.stringMatching(/unknowable/)
    })
  })

  it('does not rebuild for runtime commits that changed nothing the desktop ships, and remembers that', () => {
    expect(decideForkUpdate(facts({}, runtime({ count: 0 }).git))).toMatchObject({
      action: 'none',
      reason: expect.stringMatching(/nothing the desktop ships changed/),
      remember: HEAD
    })
  })

  describe('after an earlier attempt (the state file)', () => {
    const state = (patch: Record<string, unknown>) => (file: string) =>
      file.endsWith('install-stamp.json')
        ? JSON.stringify({ commit: STAMP })
        : JSON.stringify({ at: 1_000_000 - 1000, head: HEAD, status: 'running', ...patch })

    it('does not try again on a commit it already failed on', () => {
      expect(decideForkUpdate(facts({ readText: state({ status: 'failed' }) }))).toMatchObject({
        action: 'none',
        reason: expect.stringMatching(/already looked at .*failed/)
      })
    })

    it('does not run an update again that already finished for this commit (no update loop)', () => {
      expect(decideForkUpdate(facts({ readText: state({ status: 'done' }) }))).toMatchObject({
        action: 'none',
        reason: expect.stringMatching(/already looked at .*done/)
      })
    })

    it('tries again when the runtime moved on since the failure', () => {
      expect(decideForkUpdate(facts({ readText: state({ head: 'c'.repeat(40), status: 'failed' }) }))).toMatchObject({
        action: 'update'
      })
    })

    it('does not boot the old build under an update that is running right now', () => {
      expect(decideForkUpdate(facts({ readText: state({}) }))).toEqual({ action: 'busy', head: HEAD, since: 999_000 })
    })

    it('retries when the helper that was running has stopped reporting', () => {
      expect(decideForkUpdate(facts({ readText: state({ at: 1_000_000 - RUNNING_FRESH_MS - 1 }) }))).toMatchObject({
        action: 'update'
      })
    })

    it('retries a postponed update on the next launch', () => {
      expect(decideForkUpdate(facts({ readText: state({ status: 'deferred' }) }))).toMatchObject({ action: 'update' })
    })
  })
})

describe('small pieces', () => {
  it('picks Hermes’ newest managed Node, and falls back to `node`', () => {
    const entries = [
      'node-24.11.1-win32-x64',
      'node-26.7.0-win32-x64',
      'npm-12.0.2-win32-x64',
      'python-3.14.7',
      'node-9.0.0-win32-x64'
    ]

    const exists = () => true

    expect(findHelperNode({ LOCALAPPDATA: 'C:\\L' }, () => entries, exists)).toBe(
      path.join('C:\\L', 'hermes', 'tools', 'node-26.7.0-win32-x64', 'node.exe')
    )
    expect(
      findHelperNode(
        { LOCALAPPDATA: 'C:\\L' },
        () => entries,
        () => false
      )
    ).toBe('node')
    expect(findHelperNode({}, () => entries, exists)).toBe('node')
  })

  it('reads a state file defensively', () => {
    expect(parseForkUpdateState(null)).toBeNull()
    expect(parseForkUpdateState('{oops')).toBeNull()
    expect(parseForkUpdateState('{"head":1}')).toBeNull()
    expect(parseForkUpdateState('{"at":1,"head":"x","status":"done"}')).toEqual({ at: 1, head: 'x', status: 'done' })
  })

  it('speaks Italian to an Italian system and English to the rest', () => {
    expect(languageFor('it')).toBe('it')
    expect(languageFor('it-IT')).toBe('it')
    expect(languageFor('en-US')).toBe('en')
    expect(updatingWindowHtml('it')).toContain('Aggiorno Hermes (Mullvad)')
    expect(updatingWindowHtml('en')).toContain('Updating Hermes (Mullvad)')
  })
})

describe('createForkUpdate (the shell)', () => {
  let userData: string
  let repoDir: string
  let exe: string
  let helper: string
  let exit: Mock<(code?: number) => void>
  let relaunch: Mock<() => void>
  let startVpn: Mock<() => void>
  let showMessageBox: Mock<(options: Electron.MessageBoxOptions) => Promise<unknown>>
  let windows: { loadURL: Mock<(url: string) => Promise<void>>; options: Record<string, unknown> }[]
  let liveUpdate: () => unknown
  let rt = runtime()

  const statePath = () => path.join(userData, 'fork-update.json')
  const logPath = () => path.join(userData, 'fork-update.log')
  const readState = () => JSON.parse(readFileSync(statePath(), 'utf8'))

  function shell(overrides: Record<string, unknown> = {}) {
    class FakeWindow {
      close = vi.fn()
      isDestroyed = () => false
      loadURL = vi.fn(async () => undefined)

      constructor(public options: Record<string, unknown>) {
        windows.push(this)
      }
    }

    return createForkUpdate({
      app: { exit, getLocale: () => 'it-IT', relaunch },
      BrowserWindow: FakeWindow as never,
      dialog: { showMessageBox },
      env: {
        HERMES_FORK_REPO: repoDir,
        LOCALAPPDATA: path.join(userData, 'no-such-localappdata')
      } as NodeJS.ProcessEnv,
      execPath: exe,
      git: (args, cwd) => rt.git(args, cwd),
      gitBinary: () => 'git',
      hermesHome: path.join(userData, 'home'),
      isPackaged: true,
      liveUpdate: () => liveUpdate(),
      log: () => undefined,
      resolveRuntimeRoot: () => path.join(userData, 'runtime'),
      resourcesPath: userData,
      startVpn,
      userDataDir: userData,
      vpnRequired: () => true,
      ...overrides
    })
  }

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'fork-update-'))
    repoDir = path.join(userData, 'repo')
    exe = path.join(repoDir, 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe')
    helper = path.join(repoDir, 'apps', 'desktop', 'fork', 'update.mjs')
    mkdirSync(path.dirname(helper), { recursive: true })
    writeFileSync(helper, '// the fork updater')
    writeFileSync(path.join(userData, 'install-stamp.json'), JSON.stringify({ commit: STAMP }))
    spawned.length = 0
    spawnError = null
    windows = []
    exit = vi.fn()
    relaunch = vi.fn()
    startVpn = vi.fn()
    showMessageBox = vi.fn(async () => ({ response: 0 }))
    liveUpdate = () => null
    rt = runtime()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(userData, { force: true, recursive: true })
  })

  it('takes over a stale launch: records it, opens its window, starts the tunnel, starts the helper, then quits', () => {
    expect(shell().takeOverIfStale()).toBe(true)

    expect(readState()).toMatchObject({ head: HEAD, status: 'running' })
    expect(startVpn).toHaveBeenCalledTimes(1)
    expect(windows).toHaveLength(1)
    expect(windows[0].options).toMatchObject({ resizable: false, show: true })
    expect(windows[0].loadURL.mock.calls[0][0]).toContain('data:text/html')
    expect(decodeURIComponent(windows[0].loadURL.mock.calls[0][0])).toContain('Aggiorno Hermes (Mullvad)')

    // the update itself runs HIDDEN: closing a console window must never be able to stop a rebuild half way
    expect(spawned).toHaveLength(2)

    const [worker, viewer] = spawned

    expect(worker.command).toBe('node')
    expect(worker.args[0]).toBe(helper)
    expect(worker.args).toEqual(
      expect.arrayContaining(['--target', HEAD, '--vpn', 'required', '--exe', exe, '--lang', 'it', '--log', logPath()])
    )
    // detached: Node kills a Windows child that is not when its parent exits, and the app quits seconds later
    expect(worker.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })

    // the progress window only shows the log; it has its own visible console
    expect(viewer.command).toBe('cmd.exe')
    expect(viewer.args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'start'])
    expect(viewer.args).toContain('Hermes (Mullvad) - aggiornamento')
    expect(viewer.args).toContain(path.join(repoDir, 'apps', 'desktop', 'fork', 'tail.mjs'))
    expect(viewer.args).toEqual(
      expect.arrayContaining(['--log', logPath(), '--state', statePath(), '--target', HEAD, '--lang', 'it'])
    )
    expect(viewer.args).not.toContain('--pid')

    // nothing is closed while the helper is still starting ...
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(exit).not.toHaveBeenCalled()

    // ... and the app quits once it has had the moment it needs
    vi.advanceTimersByTime(2_000)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('stays up while the official hand-off script still owns the update marker, so it reads as a successful relaunch', () => {
    let officialRunning = true

    liveUpdate = () => (officialRunning ? { pid: 1 } : null)

    expect(shell().takeOverIfStale()).toBe(true)

    vi.advanceTimersByTime(60_000)
    expect(exit).not.toHaveBeenCalled()

    officialRunning = false
    vi.advanceTimersByTime(1_000)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('gives the progress window a fresh log and keeps the last run next to it', () => {
    writeFileSync(logPath(), 'the previous run\n')

    expect(shell().takeOverIfStale()).toBe(true)

    expect(existsSync(logPath())).toBe(false)
    expect(readFileSync(path.join(userData, 'fork-update.previous.log'), 'utf8')).toBe('the previous run\n')
  })

  it('never strands the user: if the helper cannot start, the app relaunches itself and the failure is recorded', async () => {
    spawnError = new Error('spawn node ENOENT')

    expect(shell().takeOverIfStale()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(relaunch).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
    expect(readState()).toMatchObject({
      head: HEAD,
      reason: expect.stringContaining('could not start'),
      status: 'failed'
    })
  })

  it('does not take over when there is nothing to do', () => {
    rt = runtime({ head: STAMP })

    expect(shell().takeOverIfStale()).toBe(false)
    expect(windows).toHaveLength(0)
    expect(spawned).toHaveLength(0)
    expect(startVpn).not.toHaveBeenCalled()
  })

  it('falls back to a normal launch if its own window cannot be made', () => {
    class BrokenWindow {
      constructor() {
        throw new Error('no display')
      }
    }

    expect(shell({ BrowserWindow: BrokenWindow }).takeOverIfStale()).toBe(false)
    expect(spawned).toHaveLength(0)
    expect(readState()).toMatchObject({ reason: 'no display', status: 'failed' })
  })

  it('refuses to boot the old build under a running update, and says why', async () => {
    writeFileSync(statePath(), JSON.stringify({ at: Date.now() - 5_000, head: HEAD, status: 'running' }))

    expect(shell().takeOverIfStale()).toBe(true)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(showMessageBox.mock.calls[0][0]).toMatchObject({ message: 'Aggiornamento in corso' })
    expect(spawned).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('remembers a runtime move that changed no desktop code, so the next launch skips git', () => {
    rt = runtime({ count: 0 })

    expect(shell().takeOverIfStale()).toBe(false)
    expect(readState()).toMatchObject({ head: HEAD, status: 'current' })
  })

  it('tells the user once when an update failed, and not again', () => {
    writeFileSync(
      statePath(),
      JSON.stringify({
        at: 1,
        conflicts: ['apps/desktop/electron/main.ts'],
        head: HEAD,
        reason: 'the fork does NOT apply cleanly',
        status: 'failed'
      })
    )

    const fork = shell()

    fork.announceLastResult()
    fork.announceLastResult()

    expect(showMessageBox).toHaveBeenCalledTimes(1)

    const options = showMessageBox.mock.calls[0][0]

    expect(options.message).toBe('Aggiornamento del fork non riuscito')
    expect(options.detail).toContain('1 file in conflitto')
    expect(options.detail).not.toContain('does NOT apply')
    expect(options.detail).toContain('apps/desktop/electron/main.ts')
    expect(options.detail).toContain('allinea il fork')
    expect(readState().announced).toBe(true)
  })

  it('tells the user a postponed update is only postponed, and stays quiet about a good one', () => {
    writeFileSync(statePath(), JSON.stringify({ at: 1, head: HEAD, status: 'deferred' }))
    shell().announceLastResult()
    expect(showMessageBox.mock.calls[0][0]).toMatchObject({ message: 'Aggiornamento del fork rimandato', type: 'info' })

    showMessageBox.mockClear()
    writeFileSync(statePath(), JSON.stringify({ at: 1, head: HEAD, status: 'done' }))
    shell().announceLastResult()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  describe('who updates this build (updateMechanism)', () => {
    // an installer somebody was given: the exe is nowhere near a fork checkout
    const installed = () => ({
      env: { LOCALAPPDATA: path.join(userData, 'no-such-localappdata') } as NodeJS.ProcessEnv,
      execPath: path.join(userData, 'Programs', 'Hermes (Mullvad)', 'Hermes.exe')
    })

    it('leaves the stamp alone for a build that sits in the fork checkout, which updates itself', () => {
      expect(shell().updateMechanism()).toBeUndefined()
    })

    it('says "owner-managed" for a build that is not in a fork checkout, so there is no Update now to break it', () => {
      expect(shell(installed()).updateMechanism()).toBe('external')
    })

    it('still finds the checkout when HERMES_FORK_REPO points at it', () => {
      const { execPath } = installed()

      expect(
        shell({
          env: { HERMES_FORK_REPO: repoDir, LOCALAPPDATA: path.join(userData, 'no-such-localappdata') },
          execPath
        }).updateMechanism()
      ).toBeUndefined()
    })

    it('does not interfere with an unpackaged run, or when the self-update is switched off', () => {
      expect(shell({ ...installed(), isPackaged: false }).updateMechanism()).toBeUndefined()

      const off = installed()

      expect(
        shell({ env: { ...off.env, HERMES_FORK_UPDATE: 'off' }, execPath: off.execPath }).updateMechanism()
      ).toBeUndefined()
    })
  })
})
