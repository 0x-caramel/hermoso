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

function make(
  daemonOptions = {},
  extra: { dialog?: any; exec?: any; interfaces?: any; source?: string; windows?: HermosoWindow[] } = {}
) {
  const daemon = fakeDaemon(daemonOptions)
  const dataDir = temp()
  const home = temp()
  const { sent, win } = fakeWindow()

  // What the VPN controller says right now: tests change it to drop the tunnel.
  const vpnState = {
    gate: 'ready',
    settings: { block: true, city: null, country: null, enabled: true },
    tunnel: 'connected',
    waived: false
  }

  const vpn = {
    getState: vi.fn(() => vpnState as any),
    holdTransition: vi.fn(() => () => {}),
    refresh: vi.fn(async () => ({}) as any)
  }

  const log = vi.fn()
  const showMessageBox = vi.fn(async () => ({ response: 2 }))

  const hermoso = createHermoso({
    dataDir,
    dialog: extra.dialog ?? { showMessageBox },
    exec: extra.exec,
    interfaces: extra.interfaces,
    log,
    mullvad: daemon.client,
    pluginSource: extra.source ?? pluginSource(),
    runHermes: async () => ({ code: 0, output: '' }),
    sleep: async () => {},
    vpn,
    windows: () => extra.windows ?? [win]
  })

  open.push(hermoso)

  return { ...daemon, dataDir, hermoso, home, log, sent, showMessageBox, vpn, vpnState, win }
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

describe('the shield', () => {
  // `netstat -ano -p tcp` and the process list, as the radar reads them: the app is `process.pid`, the backend its child
  const BACKEND = process.pid + 1
  const TUNNELLED = `  TCP    10.64.12.5:51234       142.250.74.46:443      ESTABLISHED     ${BACKEND}`
  const LEAKING = `  TCP    192.168.1.20:51300     93.184.216.34:443      ESTABLISHED     ${BACKEND}`

  function machine(rows: string[]) {
    const processes = [`${process.pid},1,Hermoso.exe`, `${BACKEND},${process.pid},python.exe`].join('\r\n')

    return {
      exec: vi.fn(async (file: string) => ({
        code: 0,
        stdout: file === 'netstat.exe' ? ['  Proto  Local  Foreign  State  PID', ...rows].join('\r\n') : processes
      })),
      interfaces: () => ({ Ethernet: [{ address: '192.168.1.20' }], Mullvad: [{ address: '10.64.12.5' }] })
    }
  }

  it('answers the agent, through the bridge, whether it may act: yes while the tunnel is up, no when it drops', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    expect((await bridge(h.home, 'GET', '/v1/shield/state')).body).toMatchObject({
      frozen: false,
      ok: true,
      reason: null,
      required: true,
      tunnel: 'connected'
    })

    h.vpnState.tunnel = 'disconnected'

    const frozen = (await bridge(h.home, 'GET', '/v1/shield/state')).body

    expect(frozen).toMatchObject({ frozen: true, ok: true, reason: 'tunnel-down', tunnel: 'disconnected' })
    expect(frozen.since).toBeGreaterThan(0)
  })

  it('never freezes the agent for a person who did not ask for the VPN', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    h.vpnState.tunnel = 'disconnected'
    h.vpnState.waived = true

    expect((await bridge(h.home, 'GET', '/v1/shield/state')).body).toMatchObject({ frozen: false, required: false })
  })

  it('tells every window when the verdict changes, once, not on every look', async () => {
    const h = make()
    const shieldEvents = () => h.sent.filter(event => event.payload?.type === 'shield')

    h.hermoso.shield.check()
    h.hermoso.shield.check()
    expect(shieldEvents()).toHaveLength(0)

    h.vpnState.tunnel = 'disconnected'
    h.hermoso.shield.check()
    h.hermoso.shield.check()
    expect(shieldEvents()).toHaveLength(1)
    expect(shieldEvents()[0].channel).toBe(EVENT_CHANNEL)
    expect(shieldEvents()[0].payload.state).toMatchObject({ frozen: true, reason: 'tunnel-down' })

    h.vpnState.tunnel = 'connected'
    h.hermoso.shield.check()
    expect(shieldEvents()).toHaveLength(2)
    expect(shieldEvents()[1].payload.state.frozen).toBe(false)
  })

  it('the window asks for the same verdict the agent gets', async () => {
    const h = make()

    expect(await h.hermoso.call('shield.state')).toMatchObject({ frozen: false, required: true })
    h.vpnState.tunnel = 'connecting'
    expect(await h.hermoso.call('shield.state')).toMatchObject({ frozen: true, tunnel: 'connecting' })
  })

  it('"Always require VPN" is read and set with the person’s own click, and a failure is not a pretend success', async () => {
    const h = make()

    expect(await h.hermoso.call('shield.lockdown.get')).toBe(false)
    expect(await h.hermoso.call('shield.lockdown.set', { on: true })).toEqual({ ok: true, on: true })
    expect(h.lockdown()).toBe(true)
    expect(await h.hermoso.call('shield.lockdown.set', { on: false })).toEqual({ ok: true, on: false })
    expect(h.lockdown()).toBe(false)

    // anything that is not exactly `true` turns it off: no truthy accident turns a firewall on
    await h.hermoso.call('shield.lockdown.set', { on: true })
    expect(await h.hermoso.call('shield.lockdown.set', { on: 'yes' })).toEqual({ ok: true, on: false })

    h.fail.lockdown = true
    expect(await h.hermoso.call('shield.lockdown.set', { on: true })).toEqual({ ok: false, on: null })
  })

  it('the radar looks at the app’s connections and says which way each one goes', async () => {
    const m = machine([TUNNELLED, LEAKING])
    const h = make({}, { exec: m.exec, interfaces: m.interfaces })
    const result: any = await h.hermoso.call('shield.radar')

    expect(result.sample.error).toBeNull()
    expect(result.sample.connections.map((c: any) => [c.remoteAddress, c.route]).sort()).toEqual([
      ['142.250.74.46', 'tunnel'],
      ['93.184.216.34', 'outside']
    ])
    expect(result.summary).toMatchObject({ byRoute: { outside: 1, tunnel: 1 }, seen: 2 })
    expect(result.shield).toMatchObject({ frozen: false })
  })

  it('the report names a leak, and says plainly when there is none', async () => {
    const leaking = machine([TUNNELLED, LEAKING])
    const bad = make({}, { exec: leaking.exec, interfaces: leaking.interfaces })

    await bad.hermoso.call('shield.radar')

    const dirty = (await bad.hermoso.call('shield.report')) as string

    expect(dirty).toContain('# Hermoso shield report')
    expect(dirty).toContain('1 left OUTSIDE the VPN tunnel')
    expect(dirty).toContain('python.exe')
    expect(dirty).toContain('93.184.216.34')

    const clean = machine([TUNNELLED])
    const good = make({}, { exec: clean.exec, interfaces: clean.interfaces })

    await good.hermoso.call('shield.radar')

    const text = (await good.hermoso.call('shield.report')) as string

    expect(text).toContain('None left outside the VPN tunnel')
    expect(text).toContain('Tunnel exit: Norway')
    expect(text).toContain('VPN required by the settings: yes')
    expect(text).toContain('"Always require VPN" (blocks everything if the tunnel drops): off')
  })

  it('the report starts again on request', async () => {
    const m = machine([TUNNELLED, LEAKING])
    const h = make({}, { exec: m.exec, interfaces: m.interfaces })

    await h.hermoso.call('shield.radar')
    expect(await h.hermoso.call('shield.reset')).toBe(true)
    expect((await h.hermoso.call('shield.report')) as string).toContain('No connections were observed yet.')
  })

  it('a radar that cannot read the machine says so instead of reporting a clean machine', async () => {
    const h = make({}, { exec: async () => ({ code: 1, stdout: '' }), interfaces: () => ({}) })
    const result: any = await h.hermoso.call('shield.radar')

    expect(result.sample.error).toBeTruthy()
    expect(result.summary).toMatchObject({ missed: 1, samples: 0 })
  })

  it('looks by itself while the app lives, and stops with it', async () => {
    vi.useFakeTimers({ toFake: ['clearInterval', 'setInterval'] })

    try {
      const m = machine([TUNNELLED])
      const h = make({}, { exec: m.exec, interfaces: m.interfaces })

      await h.hermoso.prepare(h.home)

      const looks = () => m.exec.mock.calls.filter(call => call[0] === 'netstat.exe').length
      const checks = h.vpn.getState.mock.calls.length

      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.vpn.getState.mock.calls.length).toBeGreaterThanOrEqual(checks + 3)
      expect(looks()).toBe(0)

      await vi.advanceTimersByTimeAsync(8_000)
      expect(looks()).toBe(1)

      await h.hermoso.dispose()

      const after = h.vpn.getState.mock.calls.length

      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.vpn.getState.mock.calls.length).toBe(after)
      expect(looks()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
