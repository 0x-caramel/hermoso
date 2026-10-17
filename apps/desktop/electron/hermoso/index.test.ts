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
  // the table of words the guardian shares with the real plugin
  fs.copyFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'assets', 'hermoso-plugin', 'guardian-rules.json'),
    path.join(dir, 'guardian-rules.json')
  )

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
  extra: {
    dataDir?: string
    dialog?: any
    env?: NodeJS.ProcessEnv
    exec?: any
    ghost?: any
    interfaces?: any
    source?: string
    tunnel?: string
    windows?: HermosoWindow[]
  } = {}
) {
  const daemon = fakeDaemon(daemonOptions)
  const dataDir = extra.dataDir ?? temp()
  const home = temp()
  const { sent, win } = fakeWindow()

  // What the VPN controller says right now: tests change it to drop the tunnel.
  const vpnState = {
    gate: 'ready',
    settings: { block: true, city: null, country: null, enabled: true },
    tunnel: extra.tunnel ?? 'connected',
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
    env: extra.env ?? {},
    exec: extra.exec,
    ghost: extra.ghost,
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

  it('takes a fresh look at the tunnel for who is about to act, but not more than once in a couple of seconds', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    h.vpn.refresh.mockClear()

    await bridge(h.home, 'GET', '/v1/shield/state')
    await bridge(h.home, 'GET', '/v1/shield/state')
    await h.hermoso.call('shield.state')
    expect(h.vpn.refresh).toHaveBeenCalledTimes(1)
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

describe('the guardian', () => {
  const ask = (home: string, body: Record<string, unknown>) => bridge(home, 'POST', '/v1/guardian/ask', body)

  it('asks the person in Hermoso, with the shared words and the command as it is, and lets it through on a yes', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = ask(h.home, { detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })
    const prompt: any = await waitForPrompt(h)

    expect(prompt.title).toBe('Deleting many files?')
    expect(prompt.code).toBe('rm -rf data')
    expect(prompt.lines[0]).toBe('The agent wants to run this command.')
    expect(prompt.lines[1]).toMatch(/delete a whole folder/)
    expect(prompt.allowLabel).toBe('deleting many files')
    expect(h.win.show).toHaveBeenCalled()

    await h.hermoso.call('consent.answer', { answer: 'once', id: prompt.id })
    expect((await pending).body).toEqual({ allowed: true, answer: 'once', ok: true })
  })

  it('a no is final, and the agent is told which way it went', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = ask(h.home, { detail: 'git push --force', rule: 'git-destructive', tool: 'terminal' })
    const prompt = await waitForPrompt(h)

    await h.hermoso.call('consent.answer', { answer: 'deny', id: prompt.id })
    expect((await pending).body).toEqual({ allowed: false, answer: 'deny', ok: true })
  })

  it('what is never allowed is refused with no question at all', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const reply = await ask(h.home, { detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })

    expect(reply.body).toEqual({ allowed: false, answer: 'blocked', ok: true })
    expect(h.sent.filter(event => event.payload?.type === 'consent')).toHaveLength(0)
  })

  it('a request that names no rule is refused, and the person is not bothered', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const reply = await ask(h.home, { detail: 'rm -rf data', title: 'Harmless' })

    expect(reply.body).toMatchObject({ code: 'bad-request', ok: false })
    expect(h.sent.filter(event => event.payload?.type === 'consent')).toHaveLength(0)
  })

  it('"always" is remembered for that kind of thing only, listed in the allowed list, and can be taken back', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const first = ask(h.home, { detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })
    const prompt = await waitForPrompt(h)

    await h.hermoso.call('consent.answer', { answer: 'always', id: prompt.id })
    expect((await first).body.allowed).toBe(true)
    expect(await h.hermoso.call('consent.always')).toEqual([
      expect.objectContaining({ key: 'guardian:delete-many', label: 'deleting many files' })
    ])

    // the same kind again: nobody is asked
    const prompts = () => h.sent.filter(event => event.payload?.type === 'consent').length
    const before = prompts()

    expect((await ask(h.home, { detail: 'rm -rf other', rule: 'delete-many', tool: 'terminal' })).body).toEqual({
      allowed: true,
      answer: 'remembered',
      ok: true
    })
    expect(prompts()).toBe(before)

    // another kind: asks
    const other = ask(h.home, { detail: 'git reset --hard', rule: 'git-destructive', tool: 'terminal' })

    for (let i = 0; i < 200 && prompts() === before; i++) {
      await settle()
    }

    expect(prompts()).toBe(before + 1)
    await h.hermoso.call('consent.answer', {
      answer: 'deny',
      id: ((await h.hermoso.call('consent.pending')) as any[])[0].id
    })
    expect((await other).body.allowed).toBe(false)

    expect(await h.hermoso.call('consent.revoke', { key: 'guardian:delete-many' })).toBe(true)
  })

  it('switched off it asks nobody, but still refuses what is never allowed; the choice is kept in a file', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    expect(((await h.hermoso.call('guardian.state')) as any).enabled).toBe(true)

    const state: any = await h.hermoso.call('guardian.enable', { on: false })

    expect(state.enabled).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'hermoso', 'settings.json'), 'utf8'))).toEqual({
      guardian: false,
      timeMachine: true,
      version: 1
    })

    expect((await ask(h.home, { detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })).body).toEqual({
      allowed: true,
      answer: 'off',
      ok: true
    })
    expect((await ask(h.home, { detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })).body.allowed).toBe(false)
    expect(h.sent.filter(event => event.payload?.type === 'consent')).toHaveLength(0)

    // only an explicit true switches it on
    expect(((await h.hermoso.call('guardian.enable', { on: 'yes' })) as any).enabled).toBe(false)
    expect(((await h.hermoso.call('guardian.enable', { on: true })) as any).enabled).toBe(true)
  })

  it('keeps a journal of what it decided and tells the windows as it happens', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = ask(h.home, { detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })

    await h.hermoso.call('consent.answer', { answer: 'deny', id: (await waitForPrompt(h)).id })
    await pending
    await ask(h.home, { detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })

    const state: any = await h.hermoso.call('guardian.state')

    expect(state.events.map((event: any) => [event.rule, event.decision])).toEqual([
      ['catastrophic', 'blocked'],
      ['delete-many', 'denied']
    ])
    expect(state.totals).toEqual({ allowed: 0, asked: 1, blocked: 1, denied: 1 })

    const pushed = h.sent.filter(event => event.payload?.type === 'guardian')

    expect(pushed.map(event => event.payload.event.decision)).toEqual(['denied', 'blocked'])
    expect(pushed.every(event => event.channel === EVENT_CHANNEL)).toBe(true)
  })

  it('counts what it has done in a file of its own, written when the app goes', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)
    await ask(h.home, { detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })
    await h.hermoso.dispose()

    const file = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'hermoso', 'stats.json'), 'utf8'))

    expect(file.counters).toEqual({ guardianBlocked: 1 })
    expect(file.recent).toHaveLength(1)
  })
})

describe('what the shield did, counted', () => {
  it('counts a freeze, and how long it lasted when it ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 0)))

      const h = make()

      h.vpnState.tunnel = 'disconnected'
      h.hermoso.shield.check()
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 41)))
      h.vpnState.tunnel = 'connected'
      h.hermoso.shield.check()

      expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({ freezes: 1, frozenSeconds: 41 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what a launch is not', () => {
  it('does not count the tunnel still coming up at launch as a freeze: nothing was running to hold', async () => {
    const h = make({}, { tunnel: 'unknown' })

    // still frozen, but the tunnel's state changes on the way up: that is not a new freeze either
    h.vpnState.tunnel = 'connecting'
    h.hermoso.shield.check()
    expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({})

    h.vpnState.tunnel = 'connected'
    h.hermoso.shield.check()
    expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({})
    expect(((await h.hermoso.call('aura.get')) as any).points).toBe(0)

    // a drop after that is one, counted when it ends
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 0)))
      h.vpnState.tunnel = 'disconnected'
      h.hermoso.shield.check()
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 8)))
      h.vpnState.tunnel = 'connected'
      h.hermoso.shield.check()
      expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({ freezes: 1, frozenSeconds: 8 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not count a status read that blinks: a freeze that is over in a moment is not a drop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 0)))

      const h = make()

      h.vpnState.tunnel = 'unknown'
      h.hermoso.shield.check()
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 1)))
      h.vpnState.tunnel = 'connected'
      h.hermoso.shield.check()

      expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({})
      expect(((await h.hermoso.call('aura.get')) as any).points).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a drop that is still on when the app goes, if it was long enough to be one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 0)))

      const h = make()

      h.vpnState.tunnel = 'disconnected'
      h.hermoso.shield.check()
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 20)))
      await h.hermoso.beforeQuit()

      expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({ freezes: 1, frozenSeconds: 20 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the time machine', () => {
  it('asks Hermes to snapshot before the agent first changes a file in a turn, by the one variable the backend reads', async () => {
    const env: NodeJS.ProcessEnv = {}
    const h = make({}, { env })

    expect(env.HERMES_TUI_CHECKPOINTS).toBe('1')
    expect(await h.hermoso.call('timemachine.state')).toEqual({ active: true, enabled: true })
  })

  it('leaves a value the person set themselves alone', async () => {
    const env: NodeJS.ProcessEnv = { HERMES_TUI_CHECKPOINTS: '0' }
    const h = make({}, { env })

    expect(env.HERMES_TUI_CHECKPOINTS).toBe('0')
    expect(await h.hermoso.call('timemachine.state')).toEqual({ active: false, enabled: true })
  })

  it('does nothing when the person switched it off', async () => {
    const env: NodeJS.ProcessEnv = {}
    const dataDir = temp()

    fs.mkdirSync(path.join(dataDir, 'hermoso'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'hermoso', 'settings.json'), JSON.stringify({ timeMachine: false, version: 1 }))

    const h = make({}, { dataDir, env })

    expect(env.HERMES_TUI_CHECKPOINTS).toBeUndefined()
    expect(await h.hermoso.call('timemachine.state')).toEqual({ active: false, enabled: false })
  })

  it('the switch is kept in a file, and says that it takes effect at the next start (what runs now does not change)', async () => {
    const env: NodeJS.ProcessEnv = {}
    const h = make({}, { env })

    expect(await h.hermoso.call('timemachine.enable', { on: false })).toEqual({ active: true, enabled: false })
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'hermoso', 'settings.json'), 'utf8'))).toMatchObject({
      timeMachine: false
    })
    expect(await h.hermoso.call('timemachine.enable', { on: 'yes' })).toEqual({ active: true, enabled: false })
    expect(await h.hermoso.call('timemachine.enable', { on: true })).toEqual({ active: true, enabled: true })
  })

  it('counts a rewind', async () => {
    const h = make()

    expect(await h.hermoso.call('timemachine.rewound')).toBe(true)
    expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({ rewinds: 1 })
  })
})

describe('aura', () => {
  const auras = (h: ReturnType<typeof make>) =>
    h.sent.filter(event => event.payload?.type === 'aura').map(event => event.payload.aura)

  it('starts at nothing, quiet, and says since when Hermoso has been counting', async () => {
    const h = make()
    const aura: any = await h.hermoso.call('aura.get')

    expect(aura).toMatchObject({ level: 'quiet', points: 0 })
    expect(aura.since).toBeGreaterThan(0)
    expect(aura.breakdown).toHaveLength(7)
  })

  it('is worked out from the counters when asked, so it can never differ from what was counted', async () => {
    const h = make()

    await h.hermoso.call('timemachine.rewound')
    await h.hermoso.call('timemachine.rewound')
    expect(await h.hermoso.call('aura.get')).toMatchObject({ level: 'glow', points: 30 })
    expect(((await h.hermoso.call('stats.get')) as any).counters).toEqual({ rewinds: 2 })
  })

  it('counts a trip that really happened, and not one that did not', async () => {
    const h = make()

    expect(await h.hermoso.call('teleport.jump', { country: 'zz' })).toMatchObject({
      code: 'unknown-destination',
      ok: false
    })
    expect(((await h.hermoso.call('stats.get')) as any).counters.teleports).toBeUndefined()

    expect(await h.hermoso.call('teleport.jump', { city: 'fra', country: 'de', minutes: 3 })).toMatchObject({
      ok: true
    })
    expect(((await h.hermoso.call('stats.get')) as any).counters.teleports).toBe(1)
    expect(await h.hermoso.call('aura.get')).toMatchObject({ points: 10 })
  })

  it('counts the agent’s trip too, once the person said yes', async () => {
    const h = make()

    await h.hermoso.prepare(h.home)

    const pending = bridge(h.home, 'POST', '/v1/teleport/jump', { country: 'de', minutes: 3, reason: 'a test' })

    await h.hermoso.call('consent.answer', { answer: 'once', id: (await waitForPrompt(h)).id })
    expect((await pending).body.ok).toBe(true)
    expect(((await h.hermoso.call('stats.get')) as any).counters.teleports).toBe(1)
  })

  it('tells every window when the result changes, with the whole picture, and stays quiet when it does not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 0)))

      const h = make()

      h.vpnState.tunnel = 'disconnected'
      h.hermoso.shield.check()

      // a freeze is counted when it ends
      expect(auras(h)).toHaveLength(0)

      // five seconds later it does: worth 25, the five seconds are worth nothing yet and push nothing of their own
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 17, 12, 0, 5)))
      h.vpnState.tunnel = 'connected'
      h.hermoso.shield.check()
      expect(auras(h)).toHaveLength(1)
      expect(auras(h)[0]).toMatchObject({ level: 'quiet', points: 25 })
      expect(auras(h)[0].breakdown.find((line: any) => line.key === 'freezes')).toMatchObject({ count: 1, points: 25 })

      // a rewind is, and the level changes with it
      await h.hermoso.call('timemachine.rewound')
      expect(auras(h)).toHaveLength(2)
      expect(auras(h)[1]).toMatchObject({ level: 'glow', points: 40 })
      expect(
        h.sent.filter(event => event.payload?.type === 'aura').every(event => event.channel === EVENT_CHANNEL)
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a risky thing refused outright is worth something, and is pushed as it happens', async () => {
    const h = make()
    const ask = (home: string, body: Record<string, unknown>) => bridge(home, 'POST', '/v1/guardian/ask', body)

    await h.hermoso.prepare(h.home)
    // worth 10, pushed once
    await ask(h.home, { detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })
    expect(auras(h)).toHaveLength(1)
    expect(auras(h)[0]).toMatchObject({ points: 10 })
  })
})

describe('the ghost', () => {
  const ghostOptions = (patch: Record<string, unknown> = {}) => {
    const root = temp()
    const spawn = vi.fn(() => ({ pid: 6001, unref: vi.fn() }))
    const exit = vi.fn()
    const registerPanicKey = vi.fn(() => true)

    return {
      exit,
      ghost: {
        appPath: 'C:\\app',
        exit,
        execPath: 'C:\\Hermoso.exe',
        isAlive: () => false,
        packaged: true,
        registerPanicKey,
        spawn,
        tmpRoot: root,
        ...patch
      },
      registerPanicKey,
      root,
      spawn
    }
  }

  /** A ghost's own folder, as the main window would have made it. */
  const ghostFolder = (root: string, id = '0123456789ab') => {
    const dir = path.join(root, `hermoso-ghost-${id}`)

    fs.mkdirSync(path.join(dir, 'hermes-home'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify({ createdAt: 1, owner: 1 }))

    return dir
  }

  it('is opened from the main window: a second Hermoso in a folder of its own, with the setup copied and nothing else', async () => {
    const { ghost, spawn, root } = ghostOptions()
    const env: NodeJS.ProcessEnv = { KEEP: '1' }
    const h = make({}, { env, ghost })

    await h.hermoso.prepare(h.home)
    fs.writeFileSync(path.join(h.home, 'config.yaml'), 'model: x\n')
    fs.writeFileSync(path.join(h.home, 'state.db'), 'all the chats')

    expect(await h.hermoso.call('ghost.state')).toMatchObject({ canOpen: true, ghost: false })

    const result: any = await h.hermoso.call('ghost.open')

    expect(result.ok).toBe(true)
    expect(path.dirname(result.dir)).toBe(root)
    expect(spawn).toHaveBeenCalledTimes(1)

    const [file, args, options] = spawn.mock.calls[0] as unknown as [string, string[], any]

    expect(file).toBe('C:\\Hermoso.exe')
    expect(args).toEqual(['--hermoso-ghost'])
    expect(options.env.KEEP).toBe('1')
    expect(options.env.HERMES_HOME).toBe(path.join(result.dir, 'hermes-home'))
    expect(options.env.HERMES_DESKTOP_USER_DATA_DIR).toBe(path.join(result.dir, 'user-data'))
    expect(options.env.HERMOSO_GHOST).toBe(result.dir)
    expect(fs.existsSync(path.join(result.dir, 'hermes-home', 'config.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(result.dir, 'hermes-home', 'state.db'))).toBe(false)
    expect(((await h.hermoso.call('stats.get')) as any).counters.ghosts).toBe(1)
  })

  it('cannot be opened before the agent has started (there is no setup to copy yet), or without the app’s help', async () => {
    const { ghost } = ghostOptions()
    const early = make({}, { ghost })

    expect(await early.hermoso.call('ghost.open')).toMatchObject({ code: 'no-setup', ok: false })

    const bare = make()

    expect(await bare.hermoso.call('ghost.state')).toMatchObject({ canOpen: false, ghost: false })
    expect(await bare.hermoso.call('ghost.open')).toMatchObject({ code: 'unavailable', ok: false })
  })

  it('passes a debugging port to the ghost only when the person’s own environment asks for it (a test does)', async () => {
    const { ghost, spawn } = ghostOptions()
    const h = make({}, { env: { HERMOSO_GHOST_DEBUG_PORT: '9777' }, ghost })

    await h.hermoso.prepare(h.home)
    fs.writeFileSync(path.join(h.home, 'config.yaml'), 'model: x\n')
    await h.hermoso.call('ghost.open')
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[1]).toEqual([
      '--hermoso-ghost',
      '--remote-debugging-port=9777'
    ])
  })

  it('a ghost knows it is one, claims its folder, binds the panic key, and cannot open another', async () => {
    const { ghost, registerPanicKey, root } = ghostOptions()
    const dir = ghostFolder(root)
    const h = make({}, { env: { HERMOSO_GHOST: dir }, ghost })

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'ghost.json'), 'utf8')).owner).toBe(process.pid)
    expect(await h.hermoso.call('ghost.state')).toEqual({
      canOpen: false,
      ghost: true,
      key: 'CommandOrControl+Alt+Shift+Backspace'
    })
    expect(await h.hermoso.call('ghost.open')).toMatchObject({ code: 'unavailable', ok: false })

    await h.hermoso.prepare(h.home)
    await h.hermoso.prepare(h.home)
    expect(registerPanicKey).toHaveBeenCalledTimes(1)
    expect(registerPanicKey).toHaveBeenCalledWith('CommandOrControl+Alt+Shift+Backspace', expect.any(Function))
  })

  it('the panic key (and the button) delete the folder as the ghost goes, and quit at once', async () => {
    const { exit, ghost, registerPanicKey, root, spawn } = ghostOptions()
    const dir = ghostFolder(root)
    const h = make({}, { env: { HERMOSO_GHOST: dir }, ghost })

    await h.hermoso.prepare(h.home)

    const pressed = (registerPanicKey.mock.calls[0] as unknown as [string, () => void])[1]

    pressed()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect((spawn.mock.calls[0] as unknown as [string, string[]])[0]).toMatch(/powershell|sh/)

    expect(await h.hermoso.call('ghost.panic')).toEqual({ ok: true })
    expect(exit).toHaveBeenCalledTimes(2)
  })

  it('closing a ghost the usual way deletes its folder too, without holding the quit', async () => {
    const { ghost, root, spawn } = ghostOptions()
    const dir = ghostFolder(root)
    const h = make({}, { env: { HERMOSO_GHOST: dir }, ghost })

    // main.ts runs beforeQuit() only when this says so: a ghost always has something to do on the way out
    expect(h.hermoso.needsQuitWait()).toBe(true)
    expect(make().hermoso.needsQuitWait()).toBe(false)
    await h.hermoso.beforeQuit()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a path in the environment that is not a ghost’s folder makes nothing a ghost, and the panic key wipes nothing', async () => {
    const { exit, ghost, root, spawn } = ghostOptions()
    const precious = path.join(root, 'documents')

    fs.mkdirSync(precious)

    for (const value of [precious, root, path.join(root, 'hermoso-ghost-nothex'), os.homedir()]) {
      const h = make({}, { env: { HERMOSO_GHOST: value }, ghost })

      expect(await h.hermoso.call('ghost.state'), value).toMatchObject({ ghost: false })
      expect(await h.hermoso.call('ghost.panic')).toEqual({ ok: false })
      await h.hermoso.beforeQuit()
    }

    expect(spawn).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(fs.existsSync(precious)).toBe(true)
  })

  it('the main window forgets ghost folders nobody owns, at its first start of an agent, and leaves live and other folders', async () => {
    const { ghost, root } = ghostOptions({ isAlive: (pid: number) => pid === 4444 })
    const stale = ghostFolder(root, '000000000001')
    const alive = ghostFolder(root, '000000000002')
    const other = path.join(root, 'documents')

    fs.mkdirSync(other)
    fs.writeFileSync(path.join(stale, 'ghost.json'), JSON.stringify({ createdAt: 1, owner: 4000 }))
    fs.writeFileSync(path.join(alive, 'ghost.json'), JSON.stringify({ createdAt: 1, owner: 4444 }))

    const h = make({}, { ghost })

    await h.hermoso.prepare(h.home)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(alive)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
  })
})
