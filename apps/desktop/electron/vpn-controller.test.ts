import { describe, expect, it, vi } from 'vitest'

import type { CliResult, MullvadStatus, MullvadStatusResult, MullvadTunnelState } from './mullvad'
import {
  createVpnController,
  DEFAULT_VPN_SETTINGS,
  isVpnGateError,
  sanitizeVpnSettings,
  type VpnSettings,
  type VpnState
} from './vpn-controller'

const OK: CliResult = { code: 0, stderr: '', stdout: '' }

function status(state: MullvadTunnelState, extra: Partial<MullvadStatus> = {}): MullvadStatus {
  return { detail: null, location: null, relay: null, state, ...extra }
}

type StatusResult = MullvadStatusResult

/**
 * A scripted Mullvad daemon: each status() call consumes the next scripted
 * answer (the last one repeats), and `connect` can flip the script.
 */
function harness(options: {
  account?: boolean | null
  /** When the account runs out (the harness clock starts at 0). */
  expiresAt?: Date | null
  connect?: CliResult
  initial?: Partial<VpnSettings>
  script: StatusResult[]
}) {
  let settings: VpnSettings = sanitizeVpnSettings({ ...DEFAULT_VPN_SETTINGS, ...options.initial })
  let cursor = 0
  let clock = 0
  const states: VpnState[] = []

  const client = {
    account: vi.fn(async () => ({
      expiresAt: options.expiresAt ?? null,
      loggedIn: options.account === undefined ? true : options.account
    })),
    connect: vi.fn(async () => options.connect ?? OK),
    disconnect: vi.fn(async () => OK),
    findApp: vi.fn(() => null),
    findCli: vi.fn(() => 'C:\\mullvad.exe'),
    listRelays: vi.fn(async () => []),
    setLocation: vi.fn(async () => OK),
    status: vi.fn(async () => options.script[Math.min(cursor++, options.script.length - 1)])
  }

  const controller = createVpnController({
    client,
    connectTimeoutMs: 5_000,
    now: () => clock,
    onState: state => states.push(state),
    pollIntervalMs: 500,
    readSettings: () => settings,
    sleep: async ms => {
      clock += ms
    },
    writeSettings: next => {
      settings = next
    }
  })

  return { client, controller, settings: () => settings, states }
}

describe('sanitizeVpnSettings', () => {
  it('defaults to a blocking, enabled gate with no forced location', () => {
    expect(sanitizeVpnSettings(undefined)).toEqual({ block: true, city: null, country: null, enabled: true })
    expect(sanitizeVpnSettings('nope')).toEqual(DEFAULT_VPN_SETTINGS)
  })

  it('normalises codes and drops a city that has no country', () => {
    expect(sanitizeVpnSettings({ city: ' GOT ', country: ' SE ' })).toMatchObject({ city: 'got', country: 'se' })
    expect(sanitizeVpnSettings({ city: 'got' })).toMatchObject({ city: null, country: null })
    expect(sanitizeVpnSettings({ city: '../etc', country: 'sweden' })).toMatchObject({ city: null, country: null })
  })

  it('keeps explicit booleans and ignores non-boolean values', () => {
    expect(sanitizeVpnSettings({ block: false, enabled: false })).toMatchObject({ block: false, enabled: false })
    expect(sanitizeVpnSettings({ block: 'no', enabled: 0 })).toMatchObject({ block: true, enabled: true })
  })
})

describe('ensure()', () => {
  it('starts checking so the shell never flashes before the tunnel is known', () => {
    const { controller } = harness({ script: [{ failure: null, status: status('connected') }] })

    expect(controller.getState().gate).toBe('checking')
    expect(controller.getState().tunnel).toBe('unknown')
  })

  it('is a no-op when the integration is off', async () => {
    const { client, controller } = harness({ initial: { enabled: false }, script: [] })

    expect((await controller.ensure()).gate).toBe('off')
    expect(client.status).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('does not reconnect a tunnel that is already up', async () => {
    const { client, controller } = harness({
      script: [{ failure: null, status: status('connected', { location: { city: 'Stockholm', country: 'Sweden' } }) }]
    })

    const state = await controller.ensure()

    expect(state).toMatchObject({ gate: 'ready', location: { country: 'Sweden' }, tunnel: 'connected' })
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('connects a disconnected tunnel and waits for it', async () => {
    const { client, controller, states } = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connecting') },
        { failure: null, status: status('connecting') },
        { failure: null, status: status('connected', { relay: 'se-got-wg-001' }) }
      ]
    })

    const state = await controller.ensure()

    expect(client.connect).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({ gate: 'ready', relay: 'se-got-wg-001', tunnel: 'connected' })
    expect(states.map(next => next.gate)).toContain('connecting')
  })

  it('applies the configured location before connecting, and only then', async () => {
    const { client, controller } = harness({
      initial: { city: 'got', country: 'se' },
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    await controller.ensure()

    expect(client.setLocation).toHaveBeenCalledWith('se', 'got')
    expect(client.setLocation.mock.invocationCallOrder[0]).toBeLessThan(client.connect.mock.invocationCallOrder[0])
  })

  it('still connects when the saved location cannot be applied', async () => {
    const { client, controller } = harness({
      initial: { country: 'zz' },
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    client.setLocation.mockResolvedValueOnce({ code: 1, stderr: 'no such country', stdout: '' })

    expect((await controller.ensure()).gate).toBe('ready')
  })

  it('does not touch the location of a tunnel that is already up', async () => {
    const { client, controller } = harness({
      initial: { country: 'se' },
      script: [{ failure: null, status: status('connected') }]
    })

    await controller.ensure()

    expect(client.setLocation).not.toHaveBeenCalled()
  })

  it('shares one attempt between concurrent callers', async () => {
    const { client, controller } = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    const [first, second, third] = await Promise.all([controller.ensure(), controller.ensure(), controller.ensure()])

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('blocks with not-installed when there is no CLI', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    expect(await controller.ensure()).toMatchObject({ cliFound: false, gate: 'blocked', reason: 'not-installed' })
  })

  it('blocks with daemon-unreachable when the Mullvad service is not answering', async () => {
    const { controller } = harness({ script: [{ failure: 'daemon-unreachable', status: null }] })

    expect(await controller.ensure()).toMatchObject({ gate: 'blocked', reason: 'daemon-unreachable' })
  })

  it('blocks with not-logged-in without ever asking to connect', async () => {
    const { client, controller } = harness({
      account: false,
      script: [{ failure: null, status: status('disconnected') }]
    })

    expect(await controller.ensure()).toMatchObject({ gate: 'blocked', reason: 'not-logged-in' })
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('blocks with account-expired when the account has no time left, without asking to connect', async () => {
    const { client, controller } = harness({
      expiresAt: new Date(0),
      script: [{ failure: null, status: status('disconnected') }]
    })

    expect(await controller.ensure()).toMatchObject({ gate: 'blocked', reason: 'account-expired' })
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('connects an account that still has time, and one whose expiry the CLI did not give', async () => {
    const paid = harness({
      expiresAt: new Date(10_000_000),
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    const unknown = harness({
      expiresAt: null,
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await paid.controller.ensure()).gate).toBe('ready')
    expect((await unknown.controller.ensure()).gate).toBe('ready')
  })

  it('never reads the account of a tunnel that is already up', async () => {
    const { client, controller } = harness({
      expiresAt: new Date(0),
      script: [{ failure: null, status: status('connected') }]
    })

    expect((await controller.ensure()).gate).toBe('ready')
    expect(client.account).not.toHaveBeenCalled()
  })

  it('carries on when the account state is undecidable', async () => {
    const { controller } = harness({
      account: null,
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await controller.ensure()).gate).toBe('ready')
  })

  it('surfaces a connect that the CLI refused', async () => {
    const { controller } = harness({
      connect: { code: 1, stderr: 'Error: Failed to connect to daemon\nmore', stdout: '' },
      script: [{ failure: null, status: status('disconnected') }]
    })

    expect(await controller.ensure()).toMatchObject({
      gate: 'blocked',
      message: 'Error: Failed to connect to daemon',
      reason: 'daemon-unreachable'
    })
  })

  it('keeps waiting when a blocking CLI outlives its own timeout', async () => {
    const { controller } = harness({
      connect: { code: null, error: 'timeout', stderr: '', stdout: '' },
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connecting') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await controller.ensure()).gate).toBe('ready')
  })

  it('tolerates a brief Blocked blip but reports a persistent one', async () => {
    const blip = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('blocked', { detail: 'blip' }) },
        { failure: null, status: status('connecting') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await blip.controller.ensure()).gate).toBe('ready')

    const stuck = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('blocked', { detail: 'Authentication failed' }) }
      ]
    })

    expect(await stuck.controller.ensure()).toMatchObject({
      gate: 'blocked',
      message: 'Authentication failed',
      reason: 'error-state'
    })
  })

  it('asks again when the daemon stays disconnected, then times out', async () => {
    const { client, controller } = harness({
      script: [{ failure: null, status: status('disconnected') }]
    })

    const state = await controller.ensure()

    expect(state).toMatchObject({ gate: 'blocked', reason: 'timeout' })
    expect(client.connect.mock.calls.length).toBeGreaterThan(1)
    expect(client.connect.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('waits out a tunnel that is already connecting without issuing connect', async () => {
    const { client, controller } = harness({
      script: [
        { failure: null, status: status('connecting') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await controller.ensure()).gate).toBe('ready')
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('can be retried after a block', async () => {
    const { controller } = harness({
      script: [
        { failure: 'timeout', status: null },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await controller.ensure()).gate).toBe('blocked')
    expect((await controller.ensure()).gate).toBe('ready')
  })
})

describe('assertReady()', () => {
  it('passes when the tunnel is up', async () => {
    const { controller } = harness({ script: [{ failure: null, status: status('connected') }] })

    await expect(controller.assertReady()).resolves.toBeUndefined()
  })

  it('throws a VpnGateError carrying the reason when the tunnel cannot come up', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    const error = await controller.assertReady().catch(caught => caught)

    expect(isVpnGateError(error)).toBe(true)
    expect(error.reason).toBe('not-installed')
    expect(error.message).toMatch(/not connected/)
  })

  it('never blocks a boot the user has opted out of', async () => {
    const off = harness({ initial: { enabled: false }, script: [{ failure: 'not-installed', status: null }] })
    const soft = harness({ initial: { block: false }, script: [{ failure: 'not-installed', status: null }] })

    await expect(off.controller.assertReady()).resolves.toBeUndefined()
    await expect(soft.controller.assertReady()).resolves.toBeUndefined()
    expect(off.client.status).not.toHaveBeenCalled()
    expect(soft.client.status).not.toHaveBeenCalled()
  })
})

describe('setSettings()', () => {
  it('persists a sanitised patch and publishes it', async () => {
    const { controller, settings, states } = harness({ script: [{ failure: null, status: status('connected') }] })

    await controller.ensure()
    await controller.setSettings({ block: false, country: ' DE ' })

    expect(settings()).toMatchObject({ block: false, country: 'de' })
    expect(states.at(-1)?.settings).toMatchObject({ block: false, country: 'de' })
  })

  it('turns the gate off when the integration is disabled, and connects when it is re-enabled', async () => {
    const { client, controller } = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    expect((await controller.setSettings({ enabled: false })).gate).toBe('off')

    await controller.setSettings({ enabled: true })
    await controller.ensure()

    expect(client.connect).toHaveBeenCalled()
    expect(controller.getState().gate).toBe('ready')
  })

  it('moves a live tunnel when the location changes', async () => {
    const { client, controller } = harness({ script: [{ failure: null, status: status('connected') }] })

    await controller.ensure()
    await controller.setSettings({ city: 'got', country: 'se' })

    expect(client.setLocation).toHaveBeenCalledWith('se', 'got')
  })

  it('only remembers a location change while the tunnel is down', async () => {
    const { client, controller } = harness({ script: [{ failure: null, status: status('disconnected') }] })

    await controller.refresh()
    await controller.setSettings({ country: 'se' })

    expect(client.setLocation).not.toHaveBeenCalled()
  })

  it('still moves the tunnel when the last status read was unreadable', async () => {
    // Observed on a real daemon: right after a relay change `status` is momentarily unreadable.
    // The second change must not be dropped just because the first one left the tunnel "unknown".
    const { client, controller } = harness({
      script: [
        { failure: null, status: status('connected') },
        { failure: 'timeout', status: null }
      ]
    })

    await controller.ensure()
    await controller.setSettings({ country: 'se' })
    expect(controller.getState().tunnel).toBe('unknown')

    await controller.setSettings({ city: 'sto' })

    expect(client.setLocation.mock.calls).toEqual([
      ['se', null],
      ['se', 'sto']
    ])
  })
})

describe('mid-session state', () => {
  it('publishes a drop without re-arming the startup gate', async () => {
    const { controller, states } = harness({
      script: [
        { failure: null, status: status('connected') },
        { failure: null, status: status('disconnected') }
      ]
    })

    await controller.ensure()
    await controller.refresh()

    expect(controller.getState()).toMatchObject({ gate: 'ready', tunnel: 'disconnected' })
    expect(states.at(-1)?.tunnel).toBe('disconnected')
  })

  it('lets a blocked gate through when the user connects from the Mullvad app itself', async () => {
    const { controller } = harness({
      account: false,
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected', { location: { city: 'Berlin', country: 'Germany' } }) }
      ]
    })

    expect((await controller.ensure()).reason).toBe('not-logged-in')

    // The monitor's next read finds the tunnel up.
    expect(await controller.refresh()).toMatchObject({
      gate: 'ready',
      location: { country: 'Germany' },
      reason: null,
      tunnel: 'connected'
    })
  })

  it('does not republish an unchanged state', async () => {
    const { controller, states } = harness({ script: [{ failure: null, status: status('connected') }] })

    await controller.ensure()
    const count = states.length

    await controller.refresh()
    await controller.refresh()

    expect(states.length).toBe(count)
  })

  it('disconnects and reports the resulting tunnel', async () => {
    const { client, controller } = harness({
      script: [
        { failure: null, status: status('connected') },
        { failure: null, status: status('disconnected') }
      ]
    })

    await controller.ensure()
    const state = await controller.disconnect()

    expect(client.disconnect).toHaveBeenCalledTimes(1)
    expect(state.tunnel).toBe('disconnected')
  })

  it('caches a good relay list but retries an empty one', async () => {
    const { client, controller } = harness({ script: [{ failure: null, status: status('connected') }] })
    const list = [{ cities: [{ code: 'got', name: 'Gothenburg' }], code: 'se', name: 'Sweden' }]

    client.listRelays.mockResolvedValueOnce([]).mockResolvedValueOnce(list)

    expect(await controller.listRelays()).toEqual([])
    expect(await controller.listRelays()).toEqual(list)
    expect(await controller.listRelays()).toEqual(list)
    expect(client.listRelays).toHaveBeenCalledTimes(2)
  })
})

describe('startup release latch', () => {
  it('starts closed while the VPN is required, and open when it is not', () => {
    expect(harness({ script: [] }).controller.isStartupReleased()).toBe(false)
    expect(harness({ initial: { enabled: false }, script: [] }).controller.isStartupReleased()).toBe(true)
    expect(harness({ initial: { block: false }, script: [] }).controller.isStartupReleased()).toBe(true)
  })

  it('opens the first time the tunnel is up, and wakes everyone waiting on it', async () => {
    const { controller } = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    const woke = vi.fn()
    void controller.whenStartupReleased().then(woke)
    void controller.whenStartupReleased().then(woke)

    await Promise.resolve()
    expect(woke).not.toHaveBeenCalled()

    await controller.ensure()
    await controller.whenStartupReleased()

    expect(controller.isStartupReleased()).toBe(true)
    expect(woke).toHaveBeenCalledTimes(2)
  })

  it('stays closed through a block', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    await controller.ensure()

    expect(controller.getState().gate).toBe('blocked')
    expect(controller.isStartupReleased()).toBe(false)
  })

  it('opens the moment the user stops requiring the VPN', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    await controller.ensure()
    const released = controller.whenStartupReleased()

    await controller.setSettings({ block: false })
    await released

    expect(controller.isStartupReleased()).toBe(true)
  })

  it('opens when the integration is switched off', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    await controller.ensure()
    await controller.setSettings({ enabled: false })

    expect(controller.isStartupReleased()).toBe(true)
  })

  it('never closes again once open: a later drop is not a startup matter', async () => {
    const { controller } = harness({
      script: [
        { failure: null, status: status('connected') },
        { failure: null, status: status('disconnected') }
      ]
    })

    await controller.ensure()
    await controller.refresh()

    expect(controller.getState().tunnel).toBe('disconnected')
    expect(controller.isStartupReleased()).toBe(true)
    await expect(controller.whenStartupReleased()).resolves.toBeUndefined()
  })

  it('opens when a blocked gate is cleared by the user connecting from the Mullvad app', async () => {
    const { controller } = harness({
      account: false,
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    await controller.ensure()
    expect(controller.isStartupReleased()).toBe(false)

    await controller.refresh()
    expect(controller.isStartupReleased()).toBe(true)
  })
})

describe('waiving the startup gate for this launch', () => {
  it('opens the gate and lets a backend spawn through, without saving anything', async () => {
    const { client, controller, settings } = harness({ script: [{ failure: 'not-installed', status: null }] })

    await controller.ensure()
    await expect(controller.assertReady()).rejects.toMatchObject({ reason: 'not-installed' })
    expect(controller.isStartupReleased()).toBe(false)

    const state = controller.waiveStartup()

    expect(state.waived).toBe(true)
    expect(controller.isStartupReleased()).toBe(true)
    await expect(controller.whenStartupReleased()).resolves.toBeUndefined()

    // A backend spawn no longer asks the tunnel for permission (and so no longer probes it).
    client.status.mockClear()
    await expect(controller.assertReady()).resolves.toBeUndefined()
    expect(client.status).not.toHaveBeenCalled()

    // The preference on disk is exactly what it was: the requirement is still on.
    expect(settings()).toMatchObject({ block: true, enabled: true })
  })

  it('wakes everything already waiting on the gate', async () => {
    const { controller } = harness({ script: [{ failure: 'not-installed', status: null }] })

    await controller.ensure()

    const released = vi.fn()
    void controller.whenStartupReleased().then(released)

    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()

    controller.waiveStartup()
    await controller.whenStartupReleased()

    expect(released).toHaveBeenCalledTimes(1)
  })

  it('never writes the saved settings, and publishes the waiver once', () => {
    const { controller, settings, states } = harness({ script: [] })
    const before = settings()

    controller.waiveStartup()
    controller.waiveStartup()

    expect(settings()).toBe(before)
    expect(states.filter(next => next.waived)).toHaveLength(1)
  })

  it('does not stop a background connect from still bringing the tunnel up', async () => {
    const { controller } = harness({
      script: [
        { failure: null, status: status('disconnected') },
        { failure: null, status: status('connected') }
      ]
    })

    controller.waiveStartup()

    expect((await controller.ensure()).gate).toBe('ready')
    expect(controller.getState().waived).toBe(true)
  })
})

describe('a Mullvad service that is still starting', () => {
  it('waits for the daemon to come up instead of blocking at once', async () => {
    const { client, controller } = harness({
      script: [
        { failure: 'daemon-unreachable', status: null },
        { failure: 'daemon-unreachable', status: null },
        { failure: null, status: status('connected') }
      ]
    })

    const state = await controller.ensure()

    expect(state.gate).toBe('ready')
    expect(client.status).toHaveBeenCalledTimes(3)
    expect(client.connect).not.toHaveBeenCalled()
  })

  it('gives up with a clear reason when it never does', async () => {
    const { client, controller } = harness({ script: [{ failure: 'daemon-unreachable', status: null }] })

    expect(await controller.ensure()).toMatchObject({ gate: 'blocked', reason: 'daemon-unreachable' })
    // One read plus the bounded retries — never an unbounded loop.
    expect(client.status.mock.calls.length).toBeGreaterThan(1)
    expect(client.status.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('does not retry a CLI that is missing or a service that timed out', async () => {
    const missing = harness({ script: [{ failure: 'not-installed', status: null }] })
    const slow = harness({ script: [{ failure: 'timeout', status: null }] })

    await missing.controller.ensure()
    await slow.controller.ensure()

    expect(missing.client.status).toHaveBeenCalledTimes(1)
    expect(slow.client.status).toHaveBeenCalledTimes(1)
  })
})
