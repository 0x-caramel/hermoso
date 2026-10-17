import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { bridgeFilePath } from './bridge-file'
import { fakeDaemon } from './fake-daemon'

import { createHermoso, EVENT_CHANNEL, type Hermoso, type HermosoWindow } from './index'

const dirs: string[] = []
const open: Hermoso[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-glue-'))

  dirs.push(dir)

  return dir
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(hermoso => hermoso.dispose()))

  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function pluginSource(): string {
  const dir = temp()

  fs.writeFileSync(path.join(dir, '__init__.py'), 'def register(ctx):\n    pass\n')
  fs.writeFileSync(path.join(dir, 'plugin.yaml'), 'name: hermoso\nversion: 0.1.0\n')

  return dir
}

function fakeWindow() {
  const sent: { channel: string; payload: any }[] = []

  const win: HermosoWindow = {
    focus: vi.fn(),
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) }
  }

  return { sent, win }
}

function make(daemonOptions = {}, extra: { dialog?: any; source?: string; windows?: HermosoWindow[] } = {}) {
  const daemon = fakeDaemon(daemonOptions)
  const dataDir = temp()
  const home = temp()
  const { sent, win } = fakeWindow()
  const vpn = { holdTransition: vi.fn(() => () => {}), refresh: vi.fn(async () => ({}) as any) }
  const log = vi.fn()
  const showMessageBox = vi.fn(async () => ({ response: 2 }))

  const hermoso = createHermoso({
    dataDir,
    dialog: extra.dialog ?? { showMessageBox },
    log,
    mullvad: daemon.client,
    pluginSource: extra.source ?? pluginSource(),
    runHermes: async () => ({ code: 0, output: '' }),
    sleep: async () => {},
    vpn,
    windows: () => extra.windows ?? [win]
  })

  open.push(hermoso)

  return { ...daemon, dataDir, hermoso, home, log, sent, showMessageBox, vpn, win }
}

/** The bridge the way the plugin finds it: through the file the app published next to it. */
function address(home: string): { token: string; url: string } {
  return JSON.parse(fs.readFileSync(bridgeFilePath(home), 'utf8'))
}

async function bridge(home: string, method: 'GET' | 'POST', route: string, body?: unknown) {
  const { token, url } = address(home)

  const response = await fetch(url + route, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    method
  })

  return { body: (await response.json()) as any, status: response.status }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5))

async function waitForPrompt(h: ReturnType<typeof make>) {
  for (let i = 0; i < 200; i++) {
    const found = h.sent.find(event => event.payload?.type === 'consent')

    if (found) {
      return found.payload.prompt as { id: string; lines: string[]; title: string }
    }

    await settle()
  }

  throw new Error('no consent prompt was shown')
}

describe('preparing a Hermes home', () => {
  it('starts the bridge, installs the plugin, and tells the plugin where the app is', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const { token, url } = address(h.home)

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(h.home, 'plugins', 'hermoso', '__init__.py'))).toBe(true)
    expect(fs.readFileSync(path.join(h.home, 'config.yaml'), 'utf8')).toContain('- hermoso')
  })

  it('takes the address back when the app goes, so the plugin does not keep a dead one', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    expect(fs.existsSync(bridgeFilePath(h.home))).toBe(true)

    await h.hermoso.dispose()
    expect(fs.existsSync(bridgeFilePath(h.home))).toBe(false)
  })

  it('never throws, and does not leave an address in a home that has no plugin', async () => {
    const h = make({}, { source: temp() })

    await expect(h.hermoso.prepare(h.home)).resolves.toBeUndefined()
    expect(fs.existsSync(bridgeFilePath(h.home))).toBe(false)
  })

  it('a second home gets the same app, the same secret', async () => {
    const h = make()
    const other = temp()

    await h.hermoso.prepare(h.home)
    await h.hermoso.prepare(other)
    expect({ ...address(other), startedAt: 0 }).toEqual({ ...address(h.home), startedAt: 0 })
  })
})

describe('the plugin saying hello', () => {
  it('is told who it is talking to, and the app notes that the agent is connected (once, not on every ping)', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const reply = await bridge(h.home, 'GET', '/v1/hello?plugin=0.2.0')

    expect(reply.body).toMatchObject({ app: 'hermoso', ok: true })
    await bridge(h.home, 'GET', '/v1/hello?plugin=0.2.0')
    await bridge(h.home, 'GET', '/v1/hello?plugin=0.2.0')

    expect(h.sent.filter(event => event.payload?.type === 'agent')).toHaveLength(1)

    const state: any = await h.hermoso.call('agent.state')

    expect(state.version).toBe('0.2.0')
    expect(state.seenAt).toBeGreaterThan(0)
  })

  it('a version change is news too', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    await bridge(h.home, 'GET', '/v1/hello?plugin=0.1.0')
    await bridge(h.home, 'GET', '/v1/hello?plugin=0.2.0')
    expect(h.sent.filter(event => event.payload?.type === 'agent')).toHaveLength(2)
  })

  it('nobody has been in touch yet', async () => {
    const h = make()

    expect(await h.hermoso.call('agent.state')).toEqual({ seenAt: null, version: null })
  })
})

describe('a jump the agent asks for: the person decides, in Hermoso', () => {
  it('shows the request in the window, brings the app forward, waits, and jumps only on a yes', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = bridge(h.home, 'POST', '/v1/teleport/jump', {
      by: 'user',
      country: 'Germany',
      minutes: 5,
      reason: 'compare prices'
    })
    const prompt = await waitForPrompt(h)

    expect(prompt.title).toBe('Teleport to Germany?')
    expect(prompt.lines.join(' ')).toContain('5 minutes')
    expect(prompt.lines.join(' ')).toContain('compare prices')
    expect(h.win.show).toHaveBeenCalled()
    expect(h.win.focus).toHaveBeenCalled()

    // nothing moved while the person has not answered
    expect(h.calls.filter(call => call.startsWith('set:'))).toEqual([])

    await h.hermoso.call('consent.answer', { answer: 'once', id: prompt.id })

    const reply = await pending

    expect(reply.body.ok).toBe(true)
    expect(reply.body.state.trip).toMatchObject({ by: 'agent', country: 'de', reason: 'compare prices' })
    expect(h.constraint()).toEqual({ country: 'de', kind: 'country' })
    expect(h.sent.some(event => event.payload?.type === 'consent-closed' && event.payload.id === prompt.id)).toBe(true)
  })

  it('a no is final: nothing moves, and the agent is told', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'de', reason: 'x' })
    const prompt = await waitForPrompt(h)

    await h.hermoso.call('consent.answer', { answer: 'deny', id: prompt.id })

    expect((await pending).body).toMatchObject({ code: 'denied', message: 'The user said no.', ok: false })
    expect(h.calls.filter(call => call.startsWith('set:'))).toEqual([])
    expect(h.hermoso.teleport.getState().phase).toBe('idle')
  })

  it('"always" is remembered for that country only, and listed, and can be taken back', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const first = bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'de', reason: 'x' })
    const prompt = await waitForPrompt(h)

    await h.hermoso.call('consent.answer', { answer: 'always', id: prompt.id })
    expect((await first).body.ok).toBe(true)
    expect(await h.hermoso.call('consent.always')).toEqual([
      expect.objectContaining({ key: 'teleport:de', label: 'Germany' })
    ])

    // Germany again: no new question
    const prompts = () => h.sent.filter(event => event.payload?.type === 'consent').length
    const before = prompts()

    expect((await bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'Germany', reason: 'y' })).body.ok).toBe(true)
    expect(prompts()).toBe(before)

    // another country: asks
    const other = bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'fr', reason: 'z' })

    for (let i = 0; i < 200 && prompts() === before; i++) {
      await settle()
    }

    expect(prompts()).toBe(before + 1)
    await h.hermoso.call('consent.answer', {
      answer: 'deny',
      id: ((await h.hermoso.call('consent.pending')) as any[])[0].id
    })
    expect((await other).body.code).toBe('denied')

    // take it back: Germany asks again
    expect(await h.hermoso.call('consent.revoke', { key: 'teleport:de' })).toBe(true)
    expect(await h.hermoso.call('consent.always')).toEqual([])
  })

  it('a place that does not exist is answered at once, without bothering the person', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const reply = await bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'Atlantis', reason: 'x' })

    expect(reply.body).toMatchObject({ code: 'unknown-destination', ok: false })
    expect(h.sent.filter(event => event.payload?.type === 'consent')).toHaveLength(0)
  })

  it('the agent cannot answer for the person', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'de', reason: 'x' })
    const prompt = await waitForPrompt(h)

    // the answering methods are the window's, not the bridge's: no such route for the agent
    for (const route of ['/v1/consent/answer', '/v1/consent/answer?id=' + prompt.id]) {
      expect((await bridge(h.home, 'POST', route, { answer: 'once', id: prompt.id })).status).toBe(404)
    }

    expect(h.hermoso.teleport.getState().phase).toBe('idle')
    await h.hermoso.call('consent.answer', { answer: 'deny', id: prompt.id })
    await pending
  })

  it('when no window shows the request, a native dialog asks instead', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }))
    const h = make({}, { dialog: { showMessageBox } })

    await h.hermoso.prepare(h.home)

    // the window never says it is showing it (no ack): after a moment the native dialog is used
    const reply = await bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'de', reason: 'x' })

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(reply.body.ok).toBe(true)
  }, 15_000)

  it("the person's own jump from the window asks nobody", async () => {
    const h = make()
    const jump: any = await h.hermoso.call('teleport.jump', { city: 'fra', country: 'de', minutes: 3 })

    expect(jump.ok).toBe(true)
    expect(jump.state.trip.by).toBe('user')
    expect(h.sent.filter(event => event.payload?.type === 'consent')).toHaveLength(0)
  })
})

describe("what the app's own windows can ask", () => {
  it('a jump and a return, pushed to every window as they happen', async () => {
    const h = make()

    await h.hermoso.call('teleport.jump', { city: 'fra', country: 'de', minutes: 3 })
    expect(h.sent.every(event => event.channel === EVENT_CHANNEL)).toBe(true)
    expect(h.sent.filter(event => event.payload.type === 'teleport').map(event => event.payload.state.phase)).toEqual([
      'jumping',
      'away'
    ])

    await h.hermoso.call('teleport.home')
    expect(h.sent.at(-1)?.payload.state.phase).toBe('idle')
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(((await h.hermoso.call('teleport.destinations')) as unknown[]).length).toBeGreaterThan(0)
  })

  it('an unknown method is an answer, not a crash', async () => {
    const h = make()

    expect(await h.hermoso.call('nothing.here')).toMatchObject({ code: 'unknown-method', ok: false })
  })

  it('answers about a request that is not open, or with nonsense, are refused', async () => {
    const h = make()

    expect(await h.hermoso.call('consent.answer', { answer: 'once', id: 'nope' })).toBe(false)
    expect(await h.hermoso.call('consent.answer', null)).toBe(false)
    expect(await h.hermoso.call('consent.revoke', {})).toBe(false)
  })

  it('tells the VPN controller about the planned reconnect and asks it to look again', async () => {
    const h = make()

    await h.hermoso.call('teleport.jump', { country: 'de' })
    expect(h.vpn.holdTransition).toHaveBeenCalledTimes(1)
    expect(h.vpn.refresh).toHaveBeenCalled()
  })

  it('survives windows that are gone', async () => {
    const gone: HermosoWindow = { ...fakeWindow().win, isDestroyed: () => true }
    const h = make({}, { windows: [gone] })

    await expect(h.hermoso.call('teleport.jump', { country: 'de' })).resolves.toMatchObject({ ok: true })
  })
})

describe('leaving and arriving', () => {
  it('quitting while away brings the machine home first; quitting at home waits for nothing', async () => {
    const h = make()

    await h.hermoso.beforeQuit()
    expect(h.calls).toEqual([])

    await h.hermoso.call('teleport.jump', { country: 'de' })
    expect(h.hermoso.needsQuitWait()).toBe(true)
    await h.hermoso.beforeQuit()
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.hermoso.needsQuitWait()).toBe(false)
  })

  it('a trip left open by a crash is brought home at the next launch, only the location', async () => {
    const h = make({ constraint: { country: 'de', kind: 'country' } })

    fs.mkdirSync(path.join(h.dataDir, 'hermoso'), { recursive: true })

    fs.writeFileSync(
      path.join(h.dataDir, 'hermoso', 'teleport.json'),
      JSON.stringify({
        home: { label: 'country no', location: { country: 'no', kind: 'country' }, wasConnected: true },
        trip: { by: 'agent', city: null, country: 'de', countryName: 'Germany', reason: null, since: 1, until: 2 },
        version: 1
      })
    )

    await h.hermoso.recover()
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.calls).not.toContain('connect')
    expect(fs.existsSync(path.join(h.dataDir, 'hermoso', 'teleport.json'))).toBe(false)
  })
})
