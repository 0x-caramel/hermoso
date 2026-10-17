import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fakeDaemon } from './fake-daemon'

import { createHermoso, EVENT_CHANNEL, type Hermoso } from './index'

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

function make(daemonOptions = {}, extra: { source?: string } = {}) {
  const daemon = fakeDaemon(daemonOptions)
  const dataDir = temp()
  const events: { payload: any; channel: string }[] = []
  const vpn = { holdTransition: vi.fn(() => () => {}), refresh: vi.fn(async () => ({}) as any) }
  const log = vi.fn()

  const hermoso = createHermoso({
    broadcast: (channel, payload) => events.push({ channel, payload }),
    dataDir,
    log,
    mullvad: daemon.client,
    pluginSource: extra.source ?? pluginSource(),
    runHermes: async () => ({ code: 0, output: '' }),
    sleep: async () => {},
    vpn
  })

  open.push(hermoso)

  return { ...daemon, dataDir, events, hermoso, log, vpn }
}

/** Call the bridge the way the plugin does. */
async function bridge(
  hermoso: Hermoso,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown
): Promise<{ body: any; status: number }> {
  const env = hermoso.backendEnv()

  const response = await fetch(env.HERMOSO_BRIDGE_URL + route, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.HERMOSO_BRIDGE_TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    method
  })

  return { body: await response.json(), status: response.status }
}

describe('preparing a Hermes home', () => {
  it('starts the bridge and installs the plugin; the backend then finds the bridge in its environment', async () => {
    const h = make()
    const home = temp()

    expect(h.hermoso.backendEnv()).toEqual({})

    await h.hermoso.prepare(home)

    const env = h.hermoso.backendEnv()

    expect(env.HERMOSO_BRIDGE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.HERMOSO_BRIDGE_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.existsSync(path.join(home, 'plugins', 'hermoso', '__init__.py'))).toBe(true)
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('- hermoso')
  })

  it("never throws: a plugin that is missing from the app only costs the backend Hermoso's tools", async () => {
    const h = make({}, { source: temp() })

    await expect(h.hermoso.prepare(temp())).resolves.toBeUndefined()
    expect(h.hermoso.backendEnv().HERMOSO_BRIDGE_URL).toBeDefined()
  })
})

describe('what the agent can ask through the bridge', () => {
  it('a jump: the agent is always the agent, whatever the request says', async () => {
    const h = make()

    await h.hermoso.prepare(temp())

    const reply = await bridge(h.hermoso, 'POST', '/v1/teleport/jump', {
      by: 'user',
      country: 'Germany',
      minutes: 5,
      reason: 'compare prices'
    })

    expect(reply.status).toBe(200)
    expect(reply.body.ok).toBe(true)
    expect(reply.body.state.trip).toMatchObject({
      by: 'agent',
      country: 'de',
      countryName: 'Germany',
      reason: 'compare prices'
    })
    expect(h.constraint()).toEqual({ country: 'de', kind: 'country' })
  })

  it('a refusal travels back as data, not as an HTTP error', async () => {
    const h = make()

    await h.hermoso.prepare(temp())

    const reply = await bridge(h.hermoso, 'POST', '/v1/teleport/jump', { country: 'Atlantis' })

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ code: 'unknown-destination', ok: false })
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
  })

  it('a jump with a body that is not what it should be', async () => {
    const h = make()

    await h.hermoso.prepare(temp())

    for (const body of [{}, { country: 5 }, { country: null, minutes: 'x' }, { country: ['de'] }]) {
      const reply = await bridge(h.hermoso, 'POST', '/v1/teleport/jump', body)

      expect(reply.body.ok).toBe(false)
    }

    expect(h.calls.filter(call => call.startsWith('set:'))).toEqual([])
  })

  it('the way back, the state, the exits and the name of a place', async () => {
    const h = make()

    await h.hermoso.prepare(temp())
    await bridge(h.hermoso, 'POST', '/v1/teleport/jump', { country: 'de' })

    expect((await bridge(h.hermoso, 'GET', '/v1/teleport/state')).body.state.phase).toBe('away')

    const home = await bridge(h.hermoso, 'POST', '/v1/teleport/home', {})

    expect(home.body.ok).toBe(true)
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })

    const exits = await bridge(h.hermoso, 'GET', '/v1/teleport/destinations')

    expect(exits.body.countries.map((country: { code: string }) => country.code)).toContain('de')

    expect((await bridge(h.hermoso, 'GET', '/v1/teleport/resolve?country=germany&city=Frankfurt')).body).toEqual({
      city: { code: 'fra', name: 'Frankfurt' },
      country: { code: 'de', name: 'Germany' },
      ok: true
    })

    expect((await bridge(h.hermoso, 'GET', '/v1/teleport/resolve?country=nowhere')).body).toMatchObject({
      code: 'unknown-destination',
      ok: false
    })
  })
})

describe("what the app's own windows can ask", () => {
  it('a jump and a return, pushed to every window as they happen', async () => {
    const h = make()
    const jump: any = await h.hermoso.call('teleport.jump', { city: 'fra', country: 'de', minutes: 3 })

    expect(jump.ok).toBe(true)
    expect(jump.state.trip.by).toBe('user')

    expect(h.events.every(event => event.channel === EVENT_CHANNEL)).toBe(true)
    expect(h.events.map(event => event.payload.state.phase)).toEqual(['jumping', 'away'])

    const state: any = await h.hermoso.call('teleport.state')

    expect(state.phase).toBe('away')

    await h.hermoso.call('teleport.home')
    expect(h.events.at(-1)?.payload.state.phase).toBe('idle')
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })

    expect(((await h.hermoso.call('teleport.destinations')) as unknown[]).length).toBeGreaterThan(0)
  })

  it('an unknown method is an answer, not a crash', async () => {
    const h = make()

    expect(await h.hermoso.call('nothing.here')).toMatchObject({ code: 'unknown-method', ok: false })
  })

  it('tells the VPN controller about the planned reconnect and asks it to look again', async () => {
    const h = make()

    await h.hermoso.call('teleport.jump', { country: 'de' })

    expect(h.vpn.holdTransition).toHaveBeenCalledTimes(1)
    expect(h.vpn.refresh).toHaveBeenCalled()
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
