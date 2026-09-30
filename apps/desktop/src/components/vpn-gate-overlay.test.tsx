import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $desktopBoot } from '@/store/boot'
import { $vpn, $vpnLoaded, DEFAULT_VPN_SETTINGS, type VpnState } from '@/store/vpn'

import { VpnGateOverlay } from './vpn-gate-overlay'

function state(patch: Partial<VpnState> = {}): VpnState {
  return {
    cliFound: true,
    gate: 'checking',
    location: null,
    message: null,
    reason: null,
    relay: null,
    settings: DEFAULT_VPN_SETTINGS,
    tunnel: 'unknown',
    updatedAt: 1,
    waived: false,
    ...patch
  }
}

function installBridge() {
  const vpn = {
    disconnect: vi.fn(async () => state()),
    ensure: vi.fn(async () => state({ gate: 'checking' })),
    getState: vi.fn(async () => $vpn.get()),
    listRelays: vi.fn(async () => []),
    onState: vi.fn(() => () => {}),
    openApp: vi.fn(async () => ({ opened: 'app' as const })),
    refresh: vi.fn(async () => state()),
    setSettings: vi.fn(async (patch: Partial<VpnState['settings']>) =>
      state({ gate: 'blocked', settings: { ...DEFAULT_VPN_SETTINGS, ...patch }, updatedAt: 9 })
    ),
    waive: vi.fn(async () => state({ gate: 'blocked', reason: 'timeout', updatedAt: 9, waived: true }))
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { vpn }

  return vpn
}

const coldBoot = () =>
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: 'starting',
    phase: 'renderer.boot',
    progress: 6,
    running: true,
    timestamp: Date.now(),
    visible: true
  })

function publish(next: VpnState) {
  act(() => {
    $vpn.set(next)
    $vpnLoaded.set(true)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  coldBoot()
  $vpnLoaded.set(false)
  $vpn.set(state())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('VpnGateOverlay', () => {
  it('paints nothing when the tunnel is up or the integration is off', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'ready', tunnel: 'connected' }))
    expect(screen.queryByRole('status')).toBeNull()

    publish(state({ gate: 'off', settings: { ...DEFAULT_VPN_SETTINGS, enabled: false } }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not flash for a check that finishes quickly', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'checking' }))
    act(() => void vi.advanceTimersByTime(150))
    expect(screen.queryByText('Checking your VPN')).toBeNull()

    publish(state({ gate: 'ready', tunnel: 'connected' }))
    act(() => void vi.advanceTimersByTime(600))
    expect(screen.queryByText('Checking your VPN')).toBeNull()
  })

  it('shows progress once the tunnel is genuinely slow', () => {
    installBridge()
    const { container } = render(<VpnGateOverlay />)

    publish(state({ gate: 'connecting', tunnel: 'disconnected' }))
    act(() => void vi.advanceTimersByTime(350))

    expect(screen.getByText('Connecting to Mullvad')).toBeTruthy()
    expect(container.querySelector('[data-glass-opaque]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('explains a block at once, with the reason and the way forward', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'not-logged-in' }))

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Mullvad is not signed in to an account.')).toBeTruthy()
    expect(screen.getByText(/sign in with your account number/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /open mullvad/i })).toBeTruthy()
  })

  it('offers the installer, not the app, when Mullvad is missing', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ cliFound: false, gate: 'blocked', reason: 'not-installed' }))

    expect(screen.getByRole('button', { name: /get mullvad/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /open mullvad/i })).toBeNull()
  })

  it('says so plainly when the Mullvad account has run out of time', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'account-expired' }))

    expect(screen.getByText('Your Mullvad account has no time left.')).toBeTruthy()
    expect(screen.getByText(/add time to your account/i)).toBeTruthy()
    // The fix lives in the Mullvad app, so that is the button offered (not the installer).
    expect(screen.getByRole('button', { name: /open mullvad/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /get mullvad/i })).toBeNull()
  })

  it('retries through main and opens Mullvad on request', () => {
    const vpn = installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'timeout' }))

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(vpn.ensure).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /open mullvad/i }))
    expect(vpn.openApp).toHaveBeenCalledTimes(1)
  })

  it('has an explicit way out that lasts this launch only', () => {
    const vpn = installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'timeout' }))
    fireEvent.click(screen.getByRole('button', { name: /continue without vpn/i }))

    expect(vpn.waive).toHaveBeenCalledTimes(1)
    // One click must never switch the saved requirement off: that is a toggle in Settings.
    expect(vpn.setSettings).not.toHaveBeenCalled()
    expect(screen.getByText(/this time only/i)).toBeTruthy()
  })

  it('lets go once the launch is waived', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'timeout' }))
    expect(screen.getByRole('alert')).toBeTruthy()

    publish(state({ gate: 'blocked', reason: 'timeout', updatedAt: 4, waived: true }))
    act(() => void vi.advanceTimersByTime(400))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets go once the requirement is switched off', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'timeout' }))
    expect(screen.getByRole('alert')).toBeTruthy()

    publish(state({ gate: 'blocked', reason: 'timeout', settings: { ...DEFAULT_VPN_SETTINGS, block: false } }))
    act(() => void vi.advanceTimersByTime(400))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not blink between a block and the retry that follows it', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', reason: 'timeout' }))
    publish(state({ gate: 'checking', updatedAt: 2 }))

    // Still on screen, now showing progress — never an empty frame in between.
    expect(screen.getByText('Checking your VPN')).toBeTruthy()

    publish(state({ gate: 'blocked', reason: 'timeout', updatedAt: 3 }))
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('never re-covers the app after it has booted', () => {
    installBridge()
    render(<VpnGateOverlay />)

    act(() => {
      $desktopBoot.set({ ...$desktopBoot.get(), progress: 100, running: false, visible: false })
    })

    // A reconnect from Settings walks the gate through checking/blocked again.
    publish(state({ gate: 'checking', updatedAt: 2 }))
    publish(state({ gate: 'blocked', reason: 'timeout', updatedAt: 3 }))
    act(() => void vi.advanceTimersByTime(600))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('hides the CLI detail behind a Details toggle', () => {
    installBridge()
    render(<VpnGateOverlay />)

    publish(state({ gate: 'blocked', message: 'Authentication failed', reason: 'error-state' }))

    expect(screen.queryByText('Authentication failed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByText('Authentication failed')).toBeTruthy()
  })
})
