import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $notifications } from '@/store/notifications'

import {
  $vpn,
  $vpnLoaded,
  awaitVpnGate,
  DEFAULT_VPN_SETTINGS,
  disconnectVpn,
  ensureVpn,
  initVpnBridge,
  saveVpnSettings,
  vpnHoldsBoot,
  vpnPlace,
  type VpnState,
  vpnStatusKey,
  waiveVpnStartup
} from './vpn'

function state(patch: Partial<VpnState> = {}): VpnState {
  return {
    cliFound: true,
    gate: 'ready',
    location: null,
    message: null,
    reason: null,
    relay: null,
    settings: DEFAULT_VPN_SETTINGS,
    tunnel: 'connected',
    updatedAt: 1,
    waived: false,
    ...patch
  }
}

function installBridge(overrides: Partial<Window['hermesDesktop']['vpn']> = {}) {
  let push: (next: VpnState) => void = () => {}

  const vpn = {
    disconnect: vi.fn(async () => state({ tunnel: 'disconnected' })),
    ensure: vi.fn(async () => state()),
    getState: vi.fn(async () => state()),
    listRelays: vi.fn(async () => []),
    onState: vi.fn((callback: (next: VpnState) => void) => {
      push = callback

      return () => {}
    }),
    openApp: vi.fn(async () => ({ opened: 'app' as const })),
    refresh: vi.fn(async () => state()),
    setSettings: vi.fn(async (patch: Partial<VpnState['settings']>) =>
      state({ settings: { ...DEFAULT_VPN_SETTINGS, ...patch }, updatedAt: 5 })
    ),
    waive: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 6, waived: true })),
    ...overrides
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { vpn }

  return { push: (next: VpnState) => push(next), vpn }
}

// The bridge subscription is process-global by design; each test re-arms it against its own fake.
let disposeBridge: () => void = () => {}

const wire = () => {
  // Drop whatever an earlier test (or awaitVpnGate itself) subscribed, then arm this test's fake.
  initVpnBridge()()
  disposeBridge = initVpnBridge()
}

beforeEach(() => {
  $vpn.set(state({ gate: 'off', tunnel: 'unknown', updatedAt: 0 }))
  $vpnLoaded.set(false)
  $notifications.set([])
})

afterEach(() => {
  initVpnBridge()()

  disposeBridge = () => {}
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('vpnHoldsBoot', () => {
  it('holds only for an enabled, blocking gate that has not passed', () => {
    for (const gate of ['checking', 'connecting', 'blocked'] as const) {
      expect(vpnHoldsBoot(state({ gate }))).toBe(true)
    }

    expect(vpnHoldsBoot(state({ gate: 'ready' }))).toBe(false)
    expect(vpnHoldsBoot(state({ gate: 'off' }))).toBe(false)
  })

  it('never holds a launch the user waived, whatever the gate says', () => {
    for (const gate of ['checking', 'connecting', 'blocked'] as const) {
      expect(vpnHoldsBoot(state({ gate, waived: true }))).toBe(false)
    }
  })

  it('never holds a boot the user opted out of', () => {
    expect(vpnHoldsBoot(state({ gate: 'blocked', settings: { ...DEFAULT_VPN_SETTINGS, block: false } }))).toBe(false)
    expect(vpnHoldsBoot(state({ gate: 'blocked', settings: { ...DEFAULT_VPN_SETTINGS, enabled: false } }))).toBe(false)
  })
})

describe('vpnStatusKey / vpnPlace', () => {
  it('reads as off when the integration is off, whatever the tunnel does', () => {
    expect(vpnStatusKey(state({ settings: { ...DEFAULT_VPN_SETTINGS, enabled: false } }))).toBe('off')
  })

  it('calls a fresh connect "connecting" even while the daemon still says disconnected', () => {
    expect(vpnStatusKey(state({ gate: 'connecting', tunnel: 'disconnected' }))).toBe('connecting')
    expect(vpnStatusKey(state({ gate: 'connecting', tunnel: 'connected' }))).toBe('connected')
  })

  it('reports a missing CLI before anything else', () => {
    expect(vpnStatusKey(state({ cliFound: false, gate: 'blocked', tunnel: 'unknown' }))).toBe('notInstalled')
  })

  it('formats the visible location', () => {
    expect(vpnPlace(state({ location: { city: 'Stockholm', country: 'Sweden' } }))).toBe('Sweden, Stockholm')
    expect(vpnPlace(state({ location: { city: null, country: 'Germany' } }))).toBe('Germany')
    expect(vpnPlace(state({ location: null }))).toBeNull()
  })
})

describe('adopting main state', () => {
  it('ignores a reply that arrives after a newer push', async () => {
    let releaseEnsure: (next: VpnState) => void = () => {}

    const { push } = installBridge({
      ensure: vi.fn(() => new Promise<VpnState>(resolve => (releaseEnsure = resolve)))
    })

    wire()
    push(state({ gate: 'ready', updatedAt: 10 }))

    const pending = ensureVpn()
    releaseEnsure(state({ gate: 'checking', updatedAt: 3 }))
    await pending

    expect($vpn.get().gate).toBe('ready')
    expect($vpn.get().updatedAt).toBe(10)
  })

  it('shows one calm warning when a live tunnel drops, and clears it on reconnect', () => {
    const { push } = installBridge()

    wire()
    push(state({ tunnel: 'connected', updatedAt: 1 }))
    push(state({ tunnel: 'disconnected', updatedAt: 2 }))

    expect($notifications.get().map(item => item.id)).toEqual(['vpn-dropped'])
    expect($notifications.get()[0].kind).toBe('warning')

    push(state({ tunnel: 'connected', updatedAt: 3 }))

    expect($notifications.get()).toEqual([])
  })

  it('stays quiet about a disconnect the user just asked for', async () => {
    const { push } = installBridge()

    wire()
    push(state({ tunnel: 'connected', updatedAt: 1 }))

    const pending = disconnectVpn()

    // Main pushes the new tunnel state before the IPC reply lands.
    push(state({ tunnel: 'disconnected', updatedAt: 2 }))
    await pending

    expect($notifications.get()).toEqual([])
  })

  it('does not warn about a drop that happens while the startup gate is running', () => {
    const { push } = installBridge()

    wire()
    push(state({ tunnel: 'connected', updatedAt: 1 }))
    // A drop while the startup gate is (re)running is the gate's business, not a notice.
    push(state({ gate: 'connecting', tunnel: 'disconnected', updatedAt: 2 }))

    expect($notifications.get()).toEqual([])
  })
})

describe('saveVpnSettings', () => {
  it('paints the intent at once and adopts the authoritative reply', async () => {
    installBridge()
    $vpnLoaded.set(true)
    $vpn.set(state({ updatedAt: 1 }))

    const pending = saveVpnSettings({ block: false })

    expect($vpn.get().settings.block).toBe(false)
    await pending
    expect($vpn.get().settings.block).toBe(false)
    expect($vpn.get().updatedAt).toBe(5)
  })

  it('rolls back when main rejects the write', async () => {
    installBridge({ setSettings: vi.fn(async () => Promise.reject(new Error('nope'))) })
    $vpnLoaded.set(true)
    $vpn.set(state({ updatedAt: 1 }))

    await saveVpnSettings({ block: false })

    expect($vpn.get().settings.block).toBe(true)
  })
})

describe('awaitVpnGate', () => {
  it('resolves at once with no bridge (browser preview, older shell)', async () => {
    await expect(awaitVpnGate()).resolves.toBeUndefined()
  })

  it('resolves at once when the tunnel is already up', async () => {
    const { vpn } = installBridge()

    await awaitVpnGate()

    expect(vpn.getState).toHaveBeenCalled()
  })

  it('never blocks a boot on a bridge that cannot answer', async () => {
    installBridge({ getState: vi.fn(async () => Promise.reject(new Error('gone'))) })

    await expect(awaitVpnGate()).resolves.toBeUndefined()
  })

  it('holds until the gate releases, then lets the boot through', async () => {
    const { push } = installBridge({
      ensure: vi.fn(async () => state({ gate: 'blocked', reason: 'not-installed', updatedAt: 2 })),
      getState: vi.fn(async () => state({ gate: 'checking', updatedAt: 1 }))
    })

    wire()

    let released = false
    const gate = awaitVpnGate().then(() => (released = true))

    await vi.waitFor(() => expect($vpn.get().gate).toBe('blocked'))
    expect(released).toBe(false)

    push(state({ gate: 'ready', updatedAt: 3 }))
    await gate

    expect(released).toBe(true)
  })

  it('is released by waiving this launch, and the waiver is never a saved setting', async () => {
    const { vpn } = installBridge({
      ensure: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 2 })),
      getState: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 1 }))
    })

    wire()

    const gate = awaitVpnGate()

    await vi.waitFor(() => expect($vpn.get().gate).toBe('blocked'))
    await waiveVpnStartup()
    await expect(gate).resolves.toBeUndefined()

    expect(vpn.waive).toHaveBeenCalledTimes(1)
    expect(vpn.setSettings).not.toHaveBeenCalled()
    expect($vpn.get().waived).toBe(true)
    expect($vpn.get().settings.block).toBe(true)
  })

  it('is released by opting out of the requirement', async () => {
    const { push } = installBridge({
      ensure: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 2 })),
      getState: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 1 }))
    })

    wire()

    const gate = awaitVpnGate()

    await vi.waitFor(() => expect($vpn.get().gate).toBe('blocked'))
    push(
      state({ gate: 'blocked', reason: 'timeout', settings: { ...DEFAULT_VPN_SETTINGS, block: false }, updatedAt: 4 })
    )

    await expect(gate).resolves.toBeUndefined()
  })

  it('stops waiting when its boot is cancelled', async () => {
    const { push } = installBridge({
      ensure: vi.fn(async () => state({ gate: 'blocked', updatedAt: 2 })),
      getState: vi.fn(async () => state({ gate: 'blocked', updatedAt: 1 }))
    })

    wire()

    let cancelled = false
    const gate = awaitVpnGate(() => cancelled)

    await vi.waitFor(() => expect($vpn.get().gate).toBe('blocked'))
    cancelled = true
    push(state({ gate: 'blocked', message: 'poke', updatedAt: 5 }))

    await expect(gate).resolves.toBeUndefined()
  })
})
