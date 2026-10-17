import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Destination, IDLE_TELEPORT, type TeleportState } from './api'
import {
  $destinations,
  $exit,
  $hermosoReady,
  $teleport,
  loadDestinations,
  startHermoso,
  teleportHome,
  teleportTo
} from './store'
import { TeleportChip } from './teleport-chip'
import { clock, placeName, TeleportPanel } from './teleport-panel'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

const DESTINATIONS: Destination[] = [
  { cities: [{ code: 'fra', name: 'Frankfurt' }, { code: 'ber', name: 'Berlin' }], code: 'de', name: 'Germany' },
  { cities: [{ code: 'par', name: 'Paris' }], code: 'fr', name: 'France' }
]

function away(patch: Partial<TeleportState['trip'] & object> = {}): TeleportState {
  return {
    error: null,
    home: { label: 'country no', wasConnected: true },
    phase: 'away',
    trip: {
      by: 'user',
      city: null,
      country: 'de',
      countryName: 'Germany',
      reason: null,
      since: NOW,
      until: NOW + 10 * 60_000,
      ...patch
    },
    updatedAt: NOW
  }
}

function installBridge(initial: TeleportState = IDLE_TELEPORT) {
  const listeners = new Set<(payload: unknown) => void>()
  let state = initial

  const call = vi.fn(async (method: string, _params?: unknown) => {
    switch (method) {
      case 'teleport.state':
        return state

      case 'teleport.destinations':
        return DESTINATIONS

      case 'teleport.jump':
        state = away()

        return { ok: true, state }

      case 'teleport.home':
        state = IDLE_TELEPORT

        return { ok: true, state }

      default:
        return null
    }
  })

  const hermoso = {
    call,
    onEvent: vi.fn((callback: (payload: unknown) => void) => {
      listeners.add(callback)

      return () => listeners.delete(callback)
    })
  }

  const vpn = {
    getState: vi.fn(async () => ({ location: { city: 'Oslo', country: 'Norway' }, tunnel: 'connected' })),
    onState: vi.fn(() => () => {})
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { hermoso, vpn }

  return {
    call,
    emit: (payload: unknown) => act(() => listeners.forEach(listener => listener(payload))),
    hermoso,
    listeners
  }
}

// jsdom has no layout: Radix Select scrolls the chosen option into view and asks about pointer capture.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false

  Element.prototype.releasePointerCapture ??= () => {}
})

beforeEach(() => {
  $teleport.set(IDLE_TELEPORT)
  $destinations.set([])
  $hermosoReady.set(false)
  $exit.set({ city: null, country: null, up: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('helpers', () => {
  it('writes the time left as minutes and seconds, never negative', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(1)).toBe('0:01')
    expect(clock(61_000)).toBe('1:01')
    expect(clock(600_000)).toBe('10:00')
    expect(clock(-5000)).toBe('0:00')
  })

  it('names a place with its city when there is one', () => {
    expect(placeName({ city: null, country: 'de', countryName: 'Germany' })).toBe('Germany')
    expect(placeName({ city: 'fra', country: 'de', countryName: 'Germany' })).toBe('Germany (FRA)')
    expect(placeName({ city: null, country: 'de', countryName: null })).toBe('DE')
  })
})

describe('the store', () => {
  it('loads main\'s state, becomes ready, and follows what main pushes', async () => {
    const bridge = installBridge(away())
    const stop = startHermoso()

    await waitFor(() => expect($hermosoReady.get()).toBe(true))
    expect($teleport.get().phase).toBe('away')

    bridge.emit({ state: IDLE_TELEPORT, type: 'teleport' })
    expect($teleport.get().phase).toBe('idle')

    // an event that is not a teleport state is ignored
    bridge.emit({ state: { nonsense: true }, type: 'teleport' })
    bridge.emit({ type: 'other' })
    bridge.emit(null)
    expect($teleport.get().phase).toBe('idle')

    stop()
    expect(bridge.listeners.size).toBe(0)
  })

  it('paints where the tunnel exits from the VPN state', async () => {
    installBridge()
    startHermoso()

    await waitFor(() => expect($exit.get()).toEqual({ city: 'Oslo', country: 'Norway', up: true }))
  })

  it('does nothing in a window that has no Hermoso (a plain browser tab)', () => {
    const stop = startHermoso()

    expect($hermosoReady.get()).toBe(false)
    expect(() => stop()).not.toThrow()
  })

  it('asks for the destinations once, and keeps them', async () => {
    const bridge = installBridge()

    expect(await loadDestinations()).toEqual(DESTINATIONS)
    expect(await loadDestinations()).toEqual(DESTINATIONS)
    expect(bridge.call.mock.calls.filter(call => call[0] === 'teleport.destinations')).toHaveLength(1)
  })

  it('a jump and a return paint main\'s answer, and a silent main is an answer too', async () => {
    installBridge()

    const jump = await teleportTo({ country: 'de', minutes: 10 })

    expect(jump.ok).toBe(true)
    expect($teleport.get().phase).toBe('away')

    await teleportHome()
    expect($teleport.get().phase).toBe('idle')

    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop

    expect(await teleportTo({ country: 'de' })).toMatchObject({ code: 'unavailable', ok: false })
    expect(await teleportHome()).toMatchObject({ code: 'unavailable', ok: false })
  })
})

describe('the panel at home', () => {
  it('says where the connection exits now, and cannot teleport until a country is chosen', async () => {
    installBridge()
    $exit.set({ city: 'Oslo', country: 'Norway', up: true })
    render(<TeleportPanel />)

    expect(screen.getByText('Now exiting from Norway, Oslo')).toBeTruthy()

    const button = screen.getByRole('button', { name: /teleport/i }) as HTMLButtonElement

    expect(button.disabled).toBe(true)
    await waitFor(() => expect($destinations.get()).toHaveLength(2))
  })

  it('says so when Mullvad is not connected', () => {
    installBridge()
    render(<TeleportPanel />)

    expect(screen.getByText('Mullvad is not connected')).toBeTruthy()
  })

  it('chooses a country and a length, and asks main to jump', async () => {
    const bridge = installBridge()

    render(<TeleportPanel />)
    await waitFor(() => expect($destinations.get()).toHaveLength(2))

    const trigger = screen.getAllByRole('combobox')[0]

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Germany' }), { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: '30 min' }))

    const go = await screen.findByRole('button', { name: 'Teleport to Germany' })

    expect((go as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(go)

    await waitFor(() =>
      expect(bridge.call).toHaveBeenCalledWith('teleport.jump', { city: null, country: 'de', minutes: 30 })
    )
  })

  it('shows what main said when the jump did not work', async () => {
    const bridge = installBridge()

    bridge.call.mockImplementation(async (method: string) => {
      if (method === 'teleport.destinations') {
        return DESTINATIONS
      }

      if (method === 'teleport.jump') {
        return { code: 'timeout', message: 'raw', ok: false, state: IDLE_TELEPORT }
      }

      return IDLE_TELEPORT
    })

    render(<TeleportPanel />)
    await waitFor(() => expect($destinations.get()).toHaveLength(2))
    fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'France' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('button', { name: 'Teleport to France' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The tunnel did not come up there in time. You are back home.')
  })

  it('keeps a problem that main reports in its state in view', () => {
    installBridge()
    $teleport.set({ ...IDLE_TELEPORT, error: { at: 1, code: 'return-incomplete', message: 'x' } })
    render(<TeleportPanel />)

    expect(screen.getByRole('alert').textContent).toBe('You are home, but the tunnel has not finished coming up.')
  })
})

describe('the panel while away', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
  })

  it('shows the place, the countdown that ticks, and the way home', async () => {
    const bridge = installBridge(away({ by: 'agent', reason: 'compare prices' }))

    $teleport.set(away({ by: 'agent', reason: 'compare prices' }))
    render(<TeleportPanel />)

    expect(screen.getByText('Exiting from Germany')).toBeTruthy()
    expect(screen.getByText('back home in 10:00')).toBeTruthy()
    expect(screen.getByText(/The agent asked for this\./).textContent).toContain('compare prices')

    act(() => {
      vi.advanceTimersByTime(65_000)
    })

    expect(screen.getByText('back home in 8:55')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Return home' }))
    expect(bridge.call).toHaveBeenCalledWith('teleport.home', undefined)
  })

  it('adds ten minutes to what is left, never past an hour', () => {
    const bridge = installBridge()

    $teleport.set(away({ city: 'fra', until: NOW + 55 * 60_000 }))
    render(<TeleportPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Add 10 min' }))

    expect(bridge.call).toHaveBeenCalledWith('teleport.jump', { city: 'fra', country: 'de', minutes: 60 })
  })

  it('shows what it is doing while it moves', () => {
    installBridge()
    $teleport.set({ ...away(), phase: 'returning' })
    render(<TeleportPanel />)

    expect(screen.getByText('Coming home…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Return home' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the status-bar chip', () => {
  it('is not there until main has answered', () => {
    installBridge()
    const { container } = render(<TeleportChip />)

    expect(container.querySelector('button')).toBeNull()
  })

  it('is a quiet globe at home, with the way to teleport behind it', () => {
    installBridge()
    $hermosoReady.set(true)
    render(<TeleportChip />)

    const chip = screen.getByRole('button', { name: 'Teleport: exit from another country for a while' })

    expect(chip.textContent).toBe('')
    fireEvent.click(chip)
    expect(screen.getByText('Mullvad is not connected')).toBeTruthy()
  })

  it('shows the place and the time left while away', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    installBridge()
    $hermosoReady.set(true)
    $teleport.set(away({ until: NOW + 125_000 }))
    render(<TeleportChip />)

    const chip = screen.getByRole('button', { name: 'Teleported to Germany, back home in 2:05' })

    expect(within(chip).getByText(/Germany/).textContent).toBe('Germany · 2:05')
  })
})
