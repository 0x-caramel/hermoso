import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALM_SHIELD, type LedgerSummary, type RadarConnection, type RadarView, type ShieldState } from './api'
import { ShieldChip } from './shield-chip'
import { ShieldPanel, ShieldStatus } from './shield-panel'
import { $hermosoReady, $lockdown, $radar, $shield, resetRadar, startHermoso } from './store'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

const up: ShieldState = {
  frozen: false,
  reason: null,
  required: true,
  since: null,
  tunnel: 'connected',
  updatedAt: NOW
}

const down: ShieldState = {
  frozen: true,
  reason: 'tunnel-down',
  required: true,
  since: NOW,
  tunnel: 'disconnected',
  updatedAt: NOW
}

const connection = (patch: Partial<RadarConnection> = {}): RadarConnection => ({
  localAddress: '10.64.12.5',
  localPort: 51234,
  pid: 300,
  process: 'python.exe',
  remoteAddress: '142.250.74.46',
  remotePort: 443,
  route: 'tunnel',
  state: 'ESTABLISHED',
  ...patch
})

const summary = (patch: Partial<LedgerSummary> = {}): LedgerSummary => ({
  byRoute: { lan: 0, loopback: 0, outside: 0, tunnel: 1 },
  frozenSeconds: 0,
  lastAt: NOW,
  missed: 0,
  outside: [],
  samples: 3,
  seen: 1,
  startedAt: NOW - 60_000,
  ...patch
})

const view = (
  connections: RadarConnection[],
  patch: Partial<LedgerSummary> = {},
  error: null | string = null
): RadarView => ({
  sample: { at: NOW, connections, error, tunnelAddresses: ['10.64.12.5'] },
  shield: up,
  summary: summary(patch)
})

function installBridge(answers: Record<string, unknown> = {}) {
  const listeners = new Set<(payload: unknown) => void>()

  const call = vi.fn(async (method: string, _params?: unknown) => {
    const answer = answers[method]

    return typeof answer === 'function' ? (answer as (params?: unknown) => unknown)(_params) : (answer ?? null)
  })

  const hermoso = {
    call,
    onEvent: vi.fn((callback: (payload: unknown) => void) => {
      listeners.add(callback)

      return () => listeners.delete(callback)
    })
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { hermoso }

  return { call, emit: (payload: unknown) => act(() => listeners.forEach(listener => listener(payload))), listeners }
}

beforeEach(() => {
  $shield.set(CALM_SHIELD)
  $radar.set(null)
  $lockdown.set(null)
  $hermosoReady.set(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the shield in the store', () => {
  it("loads main's verdict and follows what main pushes", async () => {
    const bridge = installBridge({ 'shield.state': up })

    startHermoso()
    await waitFor(() => expect($shield.get().required).toBe(true))

    bridge.emit({ state: down, type: 'shield' })
    expect($shield.get().frozen).toBe(true)

    bridge.emit({ state: up, type: 'shield' })
    expect($shield.get().frozen).toBe(false)
  })

  it('ignores a push that is not a verdict', async () => {
    const bridge = installBridge({ 'shield.state': up })

    startHermoso()
    await waitFor(() => expect($shield.get().required).toBe(true))
    bridge.emit({ state: { nonsense: true }, type: 'shield' })
    bridge.emit({ type: 'shield' })
    expect($shield.get()).toEqual(up)
  })
})

describe('the verdict in words', () => {
  it('protected while the tunnel is up and required', () => {
    $shield.set(up)
    render(<ShieldStatus />)

    expect(screen.getByTestId('shield-headline').textContent).toBe('Protected')
    expect(screen.getByText(/If it drops, the agent stops by itself/)).toBeTruthy()
  })

  it('frozen says since when, in red, and that it goes on by itself', () => {
    $shield.set(down)
    render(<ShieldStatus />)

    expect(screen.getByTestId('shield-headline').textContent).toBe('The agent is frozen')
    expect(screen.getByText(/The VPN tunnel is down since/).textContent).toContain('goes on by itself')
  })

  it('says how to turn it on when the VPN is not required', () => {
    $shield.set({ ...CALM_SHIELD, tunnel: 'connected' })
    render(<ShieldStatus />)

    expect(screen.getByTestId('shield-headline').textContent).toBe('The VPN is not required')
    expect(screen.getByText(/Use Mullvad VPN/)).toBeTruthy()
  })
})

describe('the radar', () => {
  it('says plainly when nothing went outside the tunnel, and lists what it sees with the way each goes', async () => {
    installBridge({
      'shield.lockdown.get': false,
      'shield.radar': view(
        [connection(), connection({ process: 'Hermoso.exe', remoteAddress: '127.0.0.1', route: 'loopback' })],
        {
          byRoute: { lan: 0, loopback: 1, outside: 0, tunnel: 1 },
          seen: 2
        }
      )
    })

    render(<ShieldPanel />)

    expect((await screen.findByTestId('radar-summary')).textContent).toBe(
      '2 connections seen. None went outside the tunnel.'
    )

    const list = screen.getByTestId('radar-list')

    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list.querySelector('[data-route="tunnel"]')?.textContent).toBe('Tunnel')
    expect(list.querySelector('[data-route="loopback"]')?.textContent).toBe('This computer')
    expect(list.textContent).toContain('python.exe')
    expect(list.textContent).toContain('142.250.74.46:443')
  })

  it('a connection that left outside the tunnel is said loudly, never as clean', async () => {
    installBridge({
      'shield.lockdown.get': false,
      'shield.radar': view(
        [
          connection({
            localAddress: '192.168.1.20',
            process: 'curl.exe',
            remoteAddress: '93.184.216.34',
            route: 'outside'
          })
        ],
        {
          byRoute: { lan: 0, loopback: 0, outside: 1, tunnel: 0 },
          outside: [{ at: NOW, pid: 300, port: 443, process: 'curl.exe', remote: '93.184.216.34' }],
          seen: 1
        }
      )
    })

    render(<ShieldPanel />)

    const text = (await screen.findByTestId('radar-summary')).textContent

    expect(text).toBe('1 connection seen. 1 went OUTSIDE the tunnel.')
    expect(text).not.toContain('None')
    expect(screen.getByTestId('radar-list').querySelector('[data-route="outside"]')?.textContent).toBe('Outside')
  })

  it('a look that failed says so instead of looking clean', async () => {
    installBridge({ 'shield.lockdown.get': false, 'shield.radar': view([], { seen: 0 }, 'netstat failed') })
    render(<ShieldPanel />)

    expect((await screen.findByTestId('radar-error')).textContent).toBe(
      'Could not look at the connections (netstat failed).'
    )
    expect(screen.queryByTestId('radar-summary')).toBeNull()
  })

  it('says it has seen nothing yet, not that all is well', async () => {
    installBridge({
      'shield.lockdown.get': false,
      'shield.radar': view([], { byRoute: { lan: 0, loopback: 0, outside: 0, tunnel: 0 }, seen: 0 })
    })
    render(<ShieldPanel />)

    expect((await screen.findByTestId('radar-summary')).textContent).toBe('No connections seen yet.')
  })

  it('lists the first few and counts the rest', async () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      connection({ localPort: 50_000 + index, remotePort: 443 + index })
    )

    installBridge({ 'shield.lockdown.get': false, 'shield.radar': view(many, { seen: 11 }) })
    render(<ShieldPanel />)

    expect(await screen.findByText('…and 3 more')).toBeTruthy()
    expect(within(screen.getByTestId('radar-list')).getAllByRole('listitem')).toHaveLength(9)
  })

  it('looks again on request and by itself while it is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    const bridge = installBridge({ 'shield.lockdown.get': false, 'shield.radar': view([connection()]) })
    const looks = () => bridge.call.mock.calls.filter(call => call[0] === 'shield.radar').length

    const { unmount } = render(<ShieldPanel />)

    await vi.advanceTimersByTimeAsync(0)
    expect(looks()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: /Look now/ }))
    await vi.advanceTimersByTimeAsync(0)
    expect(looks()).toBe(2)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(looks()).toBe(3)

    unmount()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(looks()).toBe(3)
  })

  it('starting over empties the ledger and looks again', async () => {
    const bridge = installBridge({ 'shield.reset': true, 'shield.radar': view([connection()]) })

    await resetRadar()
    expect(bridge.call.mock.calls.map(call => call[0])).toEqual(['shield.reset', 'shield.radar'])
  })
})

describe('Always require VPN', () => {
  it('shows what Mullvad says and asks for the change with exactly what was clicked', async () => {
    let on = false

    const bridge = installBridge({
      'shield.lockdown.get': () => on,
      'shield.lockdown.set': (params: unknown) => {
        on = (params as { on: boolean }).on

        return { ok: true, on }
      },
      'shield.radar': view([])
    })

    render(<ShieldPanel />)

    const toggle = (await screen.findByRole('switch', { name: 'Always require VPN' })) as HTMLButtonElement

    await waitFor(() => expect($lockdown.get()).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('shield.lockdown.set', { on: true }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Always require VPN' }).getAttribute('aria-checked')).toBe('true')
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Always require VPN' }))
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('shield.lockdown.set', { on: false }))
  })

  it('when Mullvad does not take the change, says so and shows the truth, not the wish', async () => {
    installBridge({
      'shield.lockdown.get': false,
      'shield.lockdown.set': { ok: false, on: false },
      'shield.radar': view([])
    })

    render(<ShieldPanel />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Always require VPN' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Mullvad did not take the change. Is it installed, logged in and running?'
    )
    expect(screen.getByRole('switch', { name: 'Always require VPN' }).getAttribute('aria-checked')).toBe('false')
  })

  it('cannot be switched while Mullvad does not answer', async () => {
    installBridge({ 'shield.lockdown.get': null, 'shield.radar': view([]) })
    render(<ShieldPanel />)

    expect(await screen.findByText(/Mullvad is not answering/)).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Always require VPN' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the proof report', () => {
  const REPORT = '# Hermoso shield report\n\n**1 connection observed. None left outside the VPN tunnel.**\n'

  it('is copied to the clipboard as main wrote it', async () => {
    const writeText = vi.fn(async (_text: string) => {})

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    installBridge({ 'shield.lockdown.get': false, 'shield.radar': view([connection()]), 'shield.report': REPORT })
    render(<ShieldPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Copy report/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REPORT))
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeTruthy()
  })

  it('is saved as a Markdown file with the day in its name', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:report')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    Object.assign(URL, { createObjectURL, revokeObjectURL })
    installBridge({ 'shield.lockdown.get': false, 'shield.radar': view([connection()]), 'shield.report': REPORT })
    render(<ShieldPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Save report/ }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))

    const link = click.mock.instances[0] as unknown as HTMLAnchorElement

    expect(link.download).toMatch(/^hermoso-shield-report-\d{4}-\d{2}-\d{2}\.md$/)
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(REPORT)
  })

  it('says its limits where the person reads it', async () => {
    installBridge({ 'shield.lockdown.get': false, 'shield.radar': view([]) })
    render(<ShieldPanel />)

    expect((await screen.findByText(/This is evidence, not a guarantee/)).textContent).toContain(
      'only “Always require VPN” stops a leak'
    )
  })
})

describe('the shield chip in the status bar', () => {
  it('is not there until main has answered, nor when the VPN is not required', () => {
    installBridge()
    $shield.set(up)

    const { container, rerender } = render(<ShieldChip />)

    expect(container.querySelector('button')).toBeNull()

    $hermosoReady.set(true)
    $shield.set(CALM_SHIELD)
    rerender(<ShieldChip />)
    expect(container.querySelector('button')).toBeNull()
  })

  it('is a quiet shield while the tunnel is up', () => {
    installBridge()
    $hermosoReady.set(true)
    $shield.set(up)
    render(<ShieldChip />)

    const chip = screen.getByRole('button', { name: 'Shield: the VPN tunnel is up and the agent is free to work' })

    expect(chip.textContent).toBe('')
    expect(chip.getAttribute('data-frozen')).toBe('false')
  })

  it('says it loudly the moment the agent is frozen, and the verdict is behind a click', () => {
    installBridge()
    $hermosoReady.set(true)
    $shield.set(down)
    render(<ShieldChip />)

    const chip = screen.getByRole('button', { name: 'The agent is frozen: the VPN tunnel is down' })

    expect(chip.textContent).toBe('Frozen · VPN down')
    expect(chip.getAttribute('data-frozen')).toBe('true')

    fireEvent.click(chip)
    expect(screen.getByTestId('shield-headline').textContent).toBe('The agent is frozen')
    expect(screen.getByRole('button', { name: 'Open Shield' })).toBeTruthy()
  })

  it('changes by itself when main pushes a new verdict', async () => {
    const bridge = installBridge({ 'shield.state': up })

    startHermoso()
    await waitFor(() => expect($hermosoReady.get()).toBe(true))
    render(<ShieldChip />)
    expect(screen.queryByText('Frozen · VPN down')).toBeNull()

    bridge.emit({ state: down, type: 'shield' })
    expect(await screen.findByText('Frozen · VPN down')).toBeTruthy()

    bridge.emit({ state: up, type: 'shield' })
    await waitFor(() => expect(screen.queryByText('Frozen · VPN down')).toBeNull())
  })
})
