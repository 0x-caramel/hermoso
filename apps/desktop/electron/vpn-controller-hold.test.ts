import { describe, expect, it, vi } from 'vitest'

import type { CliResult, MullvadStatus, MullvadStatusResult, MullvadTunnelState } from './mullvad'
import { createVpnController, DEFAULT_VPN_SETTINGS, type VpnState } from './vpn-controller'

const OK: CliResult = { code: 0, stderr: '', stdout: '' }

const status = (state: MullvadTunnelState): MullvadStatusResult => ({
  failure: null,
  status: { detail: null, location: null, relay: null, state } satisfies MullvadStatus
})

function make(script: MullvadStatusResult[], extra: { beforeGate?: () => Promise<void> } = {}) {
  let cursor = 0
  const order: string[] = []
  const states: VpnState[] = []

  const client = {
    account: vi.fn(async () => ({ expiresAt: null, loggedIn: true })),
    connect: vi.fn(async () => OK),
    disconnect: vi.fn(async () => OK),
    findApp: vi.fn(() => null),
    findCli: vi.fn(() => 'C:\\mullvad.exe'),
    listRelays: vi.fn(async () => []),
    setLocation: vi.fn(async () => OK),
    status: vi.fn(async () => {
      order.push('status')

      return script[Math.min(cursor++, script.length - 1)]
    })
  }

  const controller = createVpnController({
    ...extra,
    client,
    connectTimeoutMs: 5_000,
    onState: state => states.push(state),
    pollIntervalMs: 1,
    readSettings: () => DEFAULT_VPN_SETTINGS,
    sleep: async () => {},
    writeSettings: () => {}
  })

  return { client, controller, order, states }
}

describe('beforeGate', () => {
  it('runs before the gate reads or changes anything', async () => {
    const h = make([status('connected')], {
      beforeGate: async () => {
        h.order.push('before-gate')
      }
    })

    await h.controller.ensure()

    expect(h.order).toEqual(['before-gate', 'status'])
  })

  it('a step that fails never keeps the tunnel down', async () => {
    const h = make([status('connected')], {
      beforeGate: async () => {
        throw new Error('boom')
      }
    })

    expect((await h.controller.ensure()).gate).toBe('ready')
  })
})

describe('holdTransition', () => {
  it('does not publish a planned reconnect as a dropped tunnel, and shows the new place once it is up', async () => {
    const h = make([status('connected'), status('connecting'), status('connecting'), status('connected')])

    await h.controller.ensure()
    expect(h.controller.getState().tunnel).toBe('connected')

    const release = h.controller.holdTransition()

    await h.controller.refresh()
    await h.controller.refresh()
    expect(h.controller.getState().tunnel).toBe('connected')
    expect(h.states.map(state => state.tunnel)).not.toContain('connecting')

    await h.controller.refresh()
    release()
    expect(h.controller.getState().tunnel).toBe('connected')
  })

  it('an unreadable status during the hold is not a drop either', async () => {
    const h = make([
      status('connected'),
      { failure: 'timeout', status: null },
      { failure: 'daemon-unreachable', status: null }
    ])

    await h.controller.ensure()

    const release = h.controller.holdTransition()

    await h.controller.refresh()
    await h.controller.refresh()
    release()

    expect(h.controller.getState().tunnel).toBe('connected')
  })

  it('after the hold ends, a real drop is published again', async () => {
    const h = make([status('connected'), status('disconnected')])

    await h.controller.ensure()
    h.controller.holdTransition()()
    await h.controller.refresh()

    expect(h.controller.getState().tunnel).toBe('disconnected')
  })

  it('holds nest, and releasing one twice releases it once', async () => {
    const h = make([status('connected'), status('disconnected'), status('disconnected')])

    await h.controller.ensure()

    const first = h.controller.holdTransition()
    const second = h.controller.holdTransition()

    first()
    first()
    await h.controller.refresh()
    expect(h.controller.getState().tunnel).toBe('connected')

    second()
    await h.controller.refresh()
    expect(h.controller.getState().tunnel).toBe('disconnected')
  })
})
