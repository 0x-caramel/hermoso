import { host } from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AuraKey, type AuraLine, type AuraView, CALM_AURA, CALM_GHOST, isAuraView, readEvent } from './api'
import { AuraChip } from './aura-chip'
import { AuraPanel } from './aura-panel'
import { HermosoPage } from './page'
import { $aura, $ghost, $hermosoReady, loadAura, startHermoso } from './store'

const line = (key: AuraKey, count: number, each: number): AuraLine => ({ count, each, key, points: count * each })

/** What main works out for two freezes, three refusals, four questions, a ghost and an hour and a half... of guard. */
const SPARKS: AuraView = {
  breakdown: [
    line('freezes', 2, 25),
    line('guardianRefused', 3, 10),
    line('guardianAsked', 4, 5),
    line('rewinds', 0, 15),
    line('ghosts', 1, 20),
    line('teleports', 0, 10),
    line('frozenHalfMinutes', 3, 1)
  ],
  into: 23,
  level: 'radiant',
  next: { at: 250, id: 'strong' },
  points: 123,
  since: Date.UTC(2026, 9, 1),
  span: 150
}

const TOP: AuraView = {
  ...SPARKS,
  into: 1100,
  level: 'beyond',
  next: null,
  points: 2600,
  span: 0
}

function installBridge(answers: Record<string, unknown> = {}) {
  let listener: ((payload: unknown) => void) | null = null

  const call = vi.fn(async (method: string, params?: unknown) => {
    const answer = answers[method]

    return typeof answer === 'function' ? (answer as (params?: unknown) => unknown)(params) : (answer ?? null)
  })

  const hermoso = {
    call,
    onEvent: vi.fn((callback: (payload: unknown) => void) => {
      listener = callback

      return () => {
        listener = null
      }
    })
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { hermoso }

  return { call, emit: (payload: unknown) => act(() => listener?.(payload)) }
}

beforeEach(() => {
  $aura.set(CALM_AURA)
  $ghost.set(CALM_GHOST)
  $hermosoReady.set(false)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('what counts as an aura the window can paint', () => {
  it('takes what main sends', () => {
    expect(isAuraView(CALM_AURA)).toBe(true)
    expect(isAuraView(SPARKS)).toBe(true)
    expect(isAuraView(TOP)).toBe(true)
  })

  it('refuses nonsense, an unknown level, numbers that are not numbers, a missing list', () => {
    const bad = [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { ...SPARKS, level: 'godlike' },
      { ...SPARKS, level: 7 },
      { ...SPARKS, points: Number.NaN },
      { ...SPARKS, points: '123' },
      { ...SPARKS, into: undefined },
      { ...SPARKS, span: Number.POSITIVE_INFINITY },
      { ...SPARKS, breakdown: undefined },
      { ...SPARKS, next: undefined },
      { ...SPARKS, next: { at: 'soon', id: 'strong' } }
    ]

    for (const value of bad) {
      expect(isAuraView(value)).toBe(false)
    }
  })

  it('reads an aura event, and nothing else that claims to be one', () => {
    expect(readEvent({ aura: SPARKS, type: 'aura' })).toEqual({ aura: SPARKS, type: 'aura' })
    expect(readEvent({ aura: { level: 'quiet' }, type: 'aura' })).toBeNull()
    expect(readEvent({ type: 'aura' })).toBeNull()
  })
})

describe('aura in the store', () => {
  it('loads what main says, and ignores an answer that is not an aura', async () => {
    installBridge({ 'aura.get': SPARKS })
    await loadAura()
    expect($aura.get()).toEqual(SPARKS)

    installBridge({ 'aura.get': { level: 'nope', points: 1 } })
    await loadAura()
    expect($aura.get()).toEqual(SPARKS)

    installBridge()
    await loadAura()
    expect($aura.get()).toEqual(SPARKS)
  })

  it('is loaded when the window starts, and follows main as it changes', async () => {
    const bridge = installBridge({ 'aura.get': SPARKS })
    const stop = startHermoso()

    await waitFor(() => expect($aura.get().points).toBe(123))

    bridge.emit({ aura: TOP, type: 'aura' })
    expect($aura.get().points).toBe(2600)

    // a damaged push changes nothing
    bridge.emit({ aura: { level: 'quiet' }, type: 'aura' })
    expect($aura.get().points).toBe(2600)
    stop()
  })
})

describe('the aura section', () => {
  it('begins quiet, with nothing earned and the first level to reach', () => {
    render(<AuraPanel />)

    expect(screen.getByTestId('aura-level').textContent).toBe('Quiet')
    expect(screen.getByTestId('aura-points').textContent).toBe('0 aura')
    expect(screen.getByText(/No aura yet\. It grows when Hermoso steps in for you\./)).toBeTruthy()
    expect(screen.queryByTestId('aura-lines')).toBeNull()
    expect(screen.getByTestId('aura-next').textContent).toBe('30 more for Glowing')

    const bar = screen.getByRole('progressbar', { name: 'Progress towards Glowing' })

    expect(bar.getAttribute('aria-valuenow')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('30')
  })

  it('shows the level, the points, and only what actually earned them, each at its worth', () => {
    $aura.set(SPARKS)
    render(<AuraPanel />)

    expect(screen.getByTestId('aura-level').textContent).toBe('Radiant')
    expect(screen.getByTestId('aura-points').textContent).toBe('123 aura')

    const rows = within(screen.getByTestId('aura-lines'))
      .getAllByRole('listitem')
      .map(row => row.textContent)

    expect(rows).toEqual([
      'Agent held still when the VPN dropped2 × 25 = +50',
      'Risky actions refused3 × 10 = +30',
      'Questions asked before risky actions4 × 5 = +20',
      'Ghost windows opened1 × 20 = +20',
      'Half minutes of standing guard3 × 1 = +3'
    ])
  })

  it('shows how far into the level the points are, and how far the next one is', () => {
    $aura.set(SPARKS)
    render(<AuraPanel />)

    const bar = screen.getByRole('progressbar', { name: 'Progress towards Strong' })

    expect(bar.getAttribute('aria-valuenow')).toBe('23')
    expect(bar.getAttribute('aria-valuemax')).toBe('150')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('15%')
    expect(screen.getByTestId('aura-next').textContent).toBe('127 more for Strong')
  })

  it('at the top there is no bar and nothing more to reach', () => {
    $aura.set(TOP)
    render(<AuraPanel />)

    expect(screen.getByTestId('aura-level').textContent).toBe('Beyond jacked')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByTestId('aura-next').textContent).toBe('The top. Nothing above this.')
  })

  it('calls the sixth level what the person calls it', () => {
    $aura.set({ ...SPARKS, level: 'jacked' })
    render(<AuraPanel />)
    expect(screen.getByTestId('aura-level').textContent).toBe('AURA JACKED')
    expect(screen.getByText('The big brother is in the room.')).toBeTruthy()
  })

  it('says it is for fun, and since when it has been counting', () => {
    $aura.set(SPARKS)
    render(<AuraPanel />)

    expect(screen.getByText(/It is just for fun: nothing depends on it\./)).toBeTruthy()
    expect(screen.getByText(/Counting since /).textContent).toContain(new Date(SPARKS.since).toLocaleDateString())
  })

  it('an emblem glows more the higher the level, and not at all when quiet', () => {
    const glow = (level: AuraView['level']) => {
      $aura.set({ ...SPARKS, level })

      const { container, unmount } = render(<AuraPanel />)
      const emblem = container.querySelector('[data-level]') as HTMLElement
      const classes = emblem.className

      unmount()

      return classes
    }

    expect(glow('quiet')).not.toContain('shadow')
    expect(glow('glow')).toContain('shadow-sm')
    expect(glow('jacked')).toContain('shadow-xl')
    expect(glow('beyond')).toContain('shadow-2xl')
  })
})

describe('the status-bar chip', () => {
  it('is not there before main has answered, nor when there is nothing to count', () => {
    installBridge()
    $aura.set(SPARKS)

    const { container } = render(<AuraChip />)

    expect(container.querySelector('button')).toBeNull()

    act(() => $hermosoReady.set(true))
    expect(container.querySelector('button')).not.toBeNull()

    act(() => $aura.set(CALM_AURA))
    expect(container.querySelector('button')).toBeNull()
  })

  it('is there once there is aura: a spark, the number, the level in the tooltip, and a click opens the page', () => {
    const navigate = vi.spyOn(host, 'navigate').mockImplementation(() => {})

    installBridge()
    $hermosoReady.set(true)
    $aura.set(SPARKS)
    render(<AuraChip />)

    const chip = screen.getByRole('button', { name: 'Aura: Radiant · 123' })

    expect(chip.textContent).toBe('123')
    expect(chip.getAttribute('title')).toBe('Aura: Radiant · 123')
    fireEvent.click(chip)
    expect(navigate).toHaveBeenCalledWith('/hermoso')
  })

  it('is not in a ghost, which keeps nothing', () => {
    installBridge()
    $hermosoReady.set(true)
    $aura.set(SPARKS)
    $ghost.set({ canOpen: false, ghost: true, key: 'k' })

    const { container } = render(<AuraChip />)

    expect(container.querySelector('button')).toBeNull()
  })
})

describe('the page', () => {
  it('has the aura first, before the shield', () => {
    installBridge()
    render(<HermosoPage />)

    const [aura, shield] = ['Aura', 'Shield'].map(title => screen.getAllByText(title)[0])

    expect(aura.compareDocumentPosition(shield) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has none in a ghost', () => {
    installBridge()
    $ghost.set({ canOpen: false, ghost: true, key: 'k' })
    render(<HermosoPage />)

    expect(screen.queryByTestId('aura-level')).toBeNull()
    expect(screen.getAllByText('Ghost').length).toBeGreaterThan(0)
  })
})
