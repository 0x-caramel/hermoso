import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  claimGhost,
  cleanerFor,
  createGhost,
  GHOST_DEBUG_PORT_ENV,
  GHOST_ENV,
  GHOST_PREFIX,
  ghostEnv,
  isGhostDir,
  launchGhost,
  pidAlive,
  sweepStale,
  wipeLater,
  wipeNow
} from './ghost'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-ghost-test-'))

  dirs.push(dir)

  return dir
}

/** A person's own folders: a Hermes home with a setup and keys, and an app data folder with the VPN choice. */
function sources() {
  const home = temp()
  const userData = temp()

  fs.writeFileSync(path.join(home, 'config.yaml'), 'model: x\n')
  fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=secret\n')
  fs.writeFileSync(path.join(home, 'auth.json'), '{"token":"t"}')
  fs.writeFileSync(path.join(home, 'state.db'), 'a whole history of chats')
  fs.mkdirSync(path.join(home, 'memories'))
  fs.writeFileSync(path.join(home, 'memories', 'm.md'), 'what the person told the agent')
  fs.writeFileSync(path.join(userData, 'vpn.json'), '{"enabled":true}')
  fs.writeFileSync(path.join(userData, 'window-state.json'), '{}')

  return { home, userData }
}

const sequence = (...ids: string[]) => {
  let i = 0

  return () => ids[Math.min(i++, ids.length - 1)]
}

describe('telling a ghost’s folder from anything else', () => {
  it('only a direct child of the temporary root, named like a ghost, and a real folder', () => {
    const root = temp()
    const good = path.join(root, `${GHOST_PREFIX}0123456789ab`)

    fs.mkdirSync(good)
    expect(isGhostDir(good, root)).toBe(true)

    // the root itself, its parent, a deeper folder, other names, other ids
    expect(isGhostDir(root, root)).toBe(false)
    expect(isGhostDir(path.dirname(root), root)).toBe(false)
    expect(isGhostDir(path.join(good, 'hermes-home'), root)).toBe(false)
    expect(isGhostDir(path.join(root, 'documents'), root)).toBe(false)
    expect(isGhostDir(path.join(root, `${GHOST_PREFIX}xyz`), root)).toBe(false)
    expect(isGhostDir(path.join(root, `${GHOST_PREFIX}0123456789ab`, '..', 'documents'), root)).toBe(false)
    expect(isGhostDir(path.join(root, `${GHOST_PREFIX}ffffffffffff`), root)).toBe(false)
  })

  it('never a file, never a path outside the root spelled with dots', () => {
    const root = temp()
    const file = path.join(root, `${GHOST_PREFIX}0123456789ab`)

    fs.writeFileSync(file, 'x')
    expect(isGhostDir(file, root)).toBe(false)
    expect(isGhostDir(path.join(root, '..', path.basename(root), `${GHOST_PREFIX}0123456789ab`), root)).toBe(false)
    expect(isGhostDir('', root)).toBe(false)
  })
})

describe('making a ghost', () => {
  it('has a home and an app data folder of its own, with only what it needs to talk to the model copied in', () => {
    const { home, userData } = sources()
    const root = temp()

    const ghost = createGhost({
      now: () => 1_000,
      ownerPid: 4242,
      randomId: sequence('0123456789ab'),
      sourceHome: home,
      sourceUserData: userData,
      tmpRoot: root
    })

    expect(ghost.dir).toBe(path.join(root, `${GHOST_PREFIX}0123456789ab`))
    expect(isGhostDir(ghost.dir, root)).toBe(true)
    expect(ghost.copied.sort()).toEqual(['.env', 'auth.json', 'config.yaml', 'vpn.json'])
    expect(fs.readdirSync(ghost.home).sort()).toEqual(['.env', 'auth.json', 'config.yaml'])
    expect(fs.readdirSync(ghost.userData)).toEqual(['vpn.json'])
    expect(JSON.parse(fs.readFileSync(path.join(ghost.dir, 'ghost.json'), 'utf8'))).toEqual({
      createdAt: 1_000,
      owner: 4242
    })
  })

  it('takes nothing of the history: no chats, no memories, no window state', () => {
    const { home, userData } = sources()
    const ghost = createGhost({ sourceHome: home, sourceUserData: userData, tmpRoot: temp() })
    const all = fs.readdirSync(ghost.dir, { recursive: true }).map(String)

    expect(all.some(name => /state\.db|memories|window-state/.test(name))).toBe(false)
  })

  it('never changes the person’s own folders', () => {
    const { home, userData } = sources()
    const before = [fs.readdirSync(home, { recursive: true }), fs.readdirSync(userData, { recursive: true })]

    createGhost({ sourceHome: home, sourceUserData: userData, tmpRoot: temp() })
    expect([fs.readdirSync(home, { recursive: true }), fs.readdirSync(userData, { recursive: true })]).toEqual(before)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('OPENAI_API_KEY=secret\n')
  })

  it('copes with a home that has less, and leaves out what is too big to be a setup file', () => {
    const home = temp()
    const userData = temp()

    fs.writeFileSync(path.join(home, 'config.yaml'), 'model: x\n')
    fs.writeFileSync(path.join(home, 'auth.json'), 'x'.repeat(2_000_000))

    const ghost = createGhost({ sourceHome: home, sourceUserData: userData, tmpRoot: temp() })

    expect(ghost.copied).toEqual(['config.yaml'])
  })

  it('a second owner can claim it (the ghost app, when it starts)', () => {
    const { home, userData } = sources()

    const ghost = createGhost({
      now: () => 1,
      ownerPid: 1,
      sourceHome: home,
      sourceUserData: userData,
      tmpRoot: temp()
    })

    claimGhost(ghost.dir, 777, () => 99)
    expect(JSON.parse(fs.readFileSync(path.join(ghost.dir, 'ghost.json'), 'utf8'))).toEqual({
      claimedAt: 99,
      createdAt: 1,
      owner: 777
    })
    expect(() => claimGhost(path.join(temp(), 'nothing'), 1)).not.toThrow()
  })
})

describe('the ghost’s environment', () => {
  const ghost = { dir: 'D', home: 'D/h', id: 'x', userData: 'D/u' }

  it('is the app’s own, with the ghost’s home and data folder and the one variable that makes it a ghost', () => {
    const env = ghostEnv({ KEEP: '1', HERMES_HOME: 'real', HERMES_DESKTOP_USER_DATA_DIR: 'real' }, ghost)

    expect(env).toMatchObject({ HERMES_DESKTOP_USER_DATA_DIR: 'D/u', HERMES_HOME: 'D/h', KEEP: '1', [GHOST_ENV]: 'D' })
  })

  it('carries a debugging port only when one is asked for, and never an inherited one', () => {
    expect(ghostEnv({ [GHOST_DEBUG_PORT_ENV]: '9999' }, ghost)[GHOST_DEBUG_PORT_ENV]).toBeUndefined()
    expect(ghostEnv({}, ghost, 5555)[GHOST_DEBUG_PORT_ENV]).toBe('5555')
  })

  it('does not touch the environment it was given', () => {
    const base = { A: '1' }

    ghostEnv(base, ghost)
    expect(base).toEqual({ A: '1' })
  })
})

describe('deleting it', () => {
  it('the helper that waits for the ghost to let go works through an encoded command, whatever the user is called', () => {
    const dir = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\hermoso-ghost-0123456789ab"
    const win = cleanerFor(dir, 'win32')

    expect(win.file).toBe('powershell.exe')
    expect(win.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive'])

    // the first helper only starts the real one through Start-Process, which inherits none of the ghost's handles
    const launcher = Buffer.from(win.args.at(-1)!, 'base64').toString('utf16le')

    expect(launcher).toContain("Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden")

    const inner = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(launcher)![1]
    const script = Buffer.from(inner, 'base64').toString('utf16le')

    expect(script).toContain("C:\\Users\\O''Brien\\AppData\\Local\\Temp\\hermoso-ghost-0123456789ab")
    expect(script).toContain('Remove-Item -LiteralPath')
    expect(script).toContain('-Recurse -Force')
    expect(script).toContain('$i -lt 30')

    const unix = cleanerFor('/tmp/hermoso-ghost-0123456789ab', 'linux')

    expect(unix.file).toBe('sh')
    expect(unix.args.at(-1)).toBe('/tmp/hermoso-ghost-0123456789ab')
    expect(unix.args[1]).not.toContain('/tmp/')
  })

  it('is started hidden and outliving its parent (a console of its own on Windows, detached elsewhere), for a ghost’s folder only', async () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)
    const unref = vi.fn()
    const spawn = vi.fn(() => ({ unref }))

    fs.mkdirSync(dir)
    expect(await wipeLater(dir, root, { platform: 'win32', spawn })).toBe(true)
    // PowerShell does nothing in a DETACHED_PROCESS (no console): on Windows it is hidden, not detached
    expect(spawn).toHaveBeenCalledWith('powershell.exe', expect.any(Array), {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(unref).toHaveBeenCalled()

    spawn.mockClear()
    expect(await wipeLater(dir, root, { platform: 'linux', spawn })).toBe(true)
    expect(spawn).toHaveBeenCalledWith('sh', expect.any(Array), { detached: true, stdio: 'ignore', windowsHide: true })

    spawn.mockClear()
    expect(await wipeLater(path.join(root, 'documents'), root, { spawn })).toBe(false)
    expect(await wipeLater(root, root, { spawn })).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('on Windows it waits until its first stage has ended (it only hands the work to a process of its own), because the caller is about to quit', async () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)
    const listeners: Record<string, () => void> = {}

    const spawn = vi.fn(() => ({
      on: (event: string, listener: () => void) => void (listeners[event] = listener),
      unref: vi.fn()
    }))

    fs.mkdirSync(dir)

    let done = false

    const waiting = wipeLater(dir, root, { platform: 'win32', spawn }).then(value => {
      done = value

      return value
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(done).toBe(false)
    listeners.exit()
    expect(await waiting).toBe(true)
  })

  it('but never for long: a first stage that does not end is given a few seconds and then let go', async () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)
    const spawn = vi.fn(() => ({ on: () => {}, unref: vi.fn() }))

    fs.mkdirSync(dir)
    expect(await wipeLater(dir, root, { platform: 'win32', spawn, startMs: 30 })).toBe(true)
  })

  it('a first stage that cannot start is not a helper on its way', async () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)
    const listeners: Record<string, () => void> = {}

    const spawn = vi.fn(() => ({
      on: (event: string, listener: () => void) => void (listeners[event] = listener),
      unref: vi.fn()
    }))

    fs.mkdirSync(dir)

    const waiting = wipeLater(dir, root, { platform: 'win32', spawn })

    listeners.error()
    expect(await waiting).toBe(false)
  })

  it('a helper that cannot start is said, not thrown', async () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)

    fs.mkdirSync(dir)
    expect(
      await wipeLater(dir, root, {
        spawn: () => {
          throw new Error('no powershell')
        }
      })
    ).toBe(false)
  })

  it('now: a ghost’s folder goes with everything in it, anything else stays', () => {
    const root = temp()
    const dir = path.join(root, `${GHOST_PREFIX}0123456789ab`)
    const other = path.join(root, 'documents')

    fs.mkdirSync(path.join(dir, 'hermes-home'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'hermes-home', 'chat.db'), 'x')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'keep.txt'), 'x')

    expect(wipeNow(dir, root)).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
    expect(wipeNow(other, root)).toBe(false)
    expect(fs.existsSync(path.join(other, 'keep.txt'))).toBe(true)
    expect(wipeNow(root, root)).toBe(false)
    expect(fs.existsSync(root)).toBe(true)
  })
})

describe('after the computer went off, or the app was killed', () => {
  const make = (
    root: string,
    id: string,
    marker: null | { claimedAt?: number; createdAt?: number; owner?: number }
  ) => {
    const dir = path.join(root, `${GHOST_PREFIX}${id}`)

    fs.mkdirSync(dir)

    if (marker) {
      fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify(marker))
    }

    return dir
  }

  const NOW = 10_000_000

  it('forgets folders nobody owns and nobody has touched for a couple of minutes', () => {
    const root = temp()
    const stale = make(root, '0000000000a1', { createdAt: NOW - 600_000, owner: 4001 })

    const claimedLongAgo = make(root, '0000000000a2', {
      claimedAt: NOW - 600_000,
      createdAt: NOW - 900_000,
      owner: 4002
    })

    const wiped = sweepStale({ isAlive: () => false, now: () => NOW, tmpRoot: root })

    expect(wiped.sort()).toEqual([stale, claimedLongAgo].sort())
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(claimedLongAgo)).toBe(false)
  })

  it('keeps a ghost whose owner is still running, however old', () => {
    const root = temp()
    const alive = make(root, '0000000000b1', { createdAt: NOW - 9_000_000, owner: 4003 })

    expect(sweepStale({ isAlive: pid => pid === 4003, now: () => NOW, tmpRoot: root })).toEqual([])
    expect(fs.existsSync(alive)).toBe(true)
  })

  it('keeps one that is being made right now', () => {
    const root = temp()
    const young = make(root, '0000000000c1', { createdAt: NOW - 10_000, owner: 4004 })
    const noMarker = make(root, '0000000000c2', null)

    expect(sweepStale({ isAlive: () => false, now: () => NOW, tmpRoot: root })).toEqual([])
    expect(fs.existsSync(young)).toBe(true)
    expect(fs.existsSync(noMarker)).toBe(true)
  })

  it('forgets a folder that has no readable marker once it is old', () => {
    const root = temp()
    const old = make(root, '0000000000d1', null)

    fs.writeFileSync(path.join(old, 'ghost.json'), '{ not json')
    expect(sweepStale({ isAlive: () => false, now: () => Date.now() + 10 * 60_000, tmpRoot: root })).toEqual([old])
    expect(fs.existsSync(old)).toBe(false)
  })

  it('looks at nothing but ghost folders', () => {
    const root = temp()
    const documents = path.join(root, 'documents')
    const nearMiss = path.join(root, `${GHOST_PREFIX}notanid`)

    fs.mkdirSync(documents)
    fs.mkdirSync(nearMiss)
    fs.writeFileSync(path.join(root, `${GHOST_PREFIX}0123456789ab`), 'a file, not a folder')

    expect(sweepStale({ isAlive: () => false, now: () => Date.now() + 10 * 60_000, tmpRoot: root })).toEqual([])
    expect(fs.existsSync(documents) && fs.existsSync(nearMiss)).toBe(true)
  })

  it('a root that cannot be read is no sweep and no crash', () => {
    expect(sweepStale({ isAlive: () => false, tmpRoot: path.join(temp(), 'nothing') })).toEqual([])
  })

  it('knows whether a process lives', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2_147_483_646)).toBe(false)
  })
})

describe('opening a ghost', () => {
  const make = (patch: Partial<Parameters<typeof launchGhost>[0]> = {}) => {
    const { home, userData } = sources()
    const root = temp()
    const calls: Array<{ args: string[]; file: string; options: any }> = []

    const spawn = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ args, file, options })

      return { pid: 5150, unref: vi.fn() }
    })

    const result = launchGhost({
      appPath: 'C:\\app',
      env: { KEEP: '1' },
      execPath: 'C:\\Hermoso.exe',
      packaged: true,
      randomId: sequence('0123456789ab'),
      sourceHome: home,
      sourceUserData: userData,
      spawn,
      tmpRoot: root,
      ...patch
    })

    return { calls, home, result, root, spawn, userData }
  }

  it('starts a second Hermoso, detached, in the ghost’s world', () => {
    const { calls, result, root } = make()

    expect(result).toEqual({ dir: path.join(root, `${GHOST_PREFIX}0123456789ab`), ok: true, pid: 5150 })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:\\Hermoso.exe')
    expect(calls[0].args).toEqual(['--hermoso-ghost'])
    expect(calls[0].options.detached).toBe(true)
    expect(calls[0].options.env).toMatchObject({
      HERMES_HOME: path.join(root, `${GHOST_PREFIX}0123456789ab`, 'hermes-home'),
      KEEP: '1',
      [GHOST_ENV]: path.join(root, `${GHOST_PREFIX}0123456789ab`)
    })
  })

  it('from source the app’s own path comes first, and a debugging port is only passed when asked for', () => {
    const { calls } = make({ debugPort: 5555, packaged: false })

    expect(calls[0].args).toEqual(['C:\\app', '--hermoso-ghost', '--remote-debugging-port=5555'])
    expect(calls[0].options.env[GHOST_DEBUG_PORT_ENV]).toBe('5555')
  })

  it('hands on the flags that decide how a window is drawn, and nothing else of the command line', () => {
    const { calls } = make({
      flags: ['--disable-gpu', '--no-sandbox', '--remote-debugging-port=1', '--profile', 'x', 'C:\\app'],
      packaged: false
    })

    expect(calls[0].args).toEqual(['C:\\app', '--hermoso-ghost', '--disable-gpu', '--no-sandbox'])
  })

  it('with no Hermes setup to copy it says so, and leaves no folder behind', () => {
    const home = temp()
    const root = temp()
    const spawn = vi.fn()

    const result = launchGhost({
      appPath: 'a',
      env: {},
      execPath: 'e',
      packaged: true,
      sourceHome: home,
      sourceUserData: temp(),
      spawn,
      tmpRoot: root
    })

    expect(result).toMatchObject({ code: 'no-setup', ok: false })
    expect(spawn).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('a ghost that cannot start leaves no folder behind either', () => {
    const { home, userData } = sources()
    const root = temp()

    const result = launchGhost({
      appPath: 'a',
      env: {},
      execPath: 'e',
      packaged: true,
      sourceHome: home,
      sourceUserData: userData,
      spawn: () => {
        throw new Error('no such file')
      },
      tmpRoot: root
    })

    expect(result).toMatchObject({ code: 'no-launch', ok: false })
    expect(fs.readdirSync(root)).toEqual([])
  })
})
