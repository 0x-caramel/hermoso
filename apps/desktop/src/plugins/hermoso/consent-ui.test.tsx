import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConsentPrompt } from './api'
import { ConsentHost } from './consent-host'
import { HermosoPage } from './page'
import { $agent, $allowed, $consent, $hermosoReady, $teleport, startHermoso } from './store'

const PROMPT: ConsentPrompt = {
  allowKey: 'teleport:de',
  allowLabel: 'Germany',
  askedAt: 1,
  id: 'c1',
  kind: 'teleport',
  lines: ['The agent wants to move your whole computer exit to Germany for 10 minutes.', 'Why: compare prices'],
  title: 'Teleport to Germany?'
}

function installBridge(options: { allowed?: unknown[]; pending?: ConsentPrompt[] } = {}) {
  const listeners = new Set<(payload: unknown) => void>()
  let allowed = options.allowed ?? []

  const call = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case 'teleport.state':
        return { error: null, home: null, phase: 'idle', trip: null, updatedAt: 0 }

      case 'consent.pending':
        return options.pending ?? []

      case 'consent.always':
        return allowed

      case 'consent.revoke':
        allowed = allowed.filter(item => (item as { key: string }).key !== (params as { key: string }).key)

        return true

      case 'agent.state':
        return { seenAt: null, version: null }

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

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { hermoso }

  return { call, emit: (payload: unknown) => act(() => listeners.forEach(listener => listener(payload))), listeners }
}

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false

  Element.prototype.releasePointerCapture ??= () => {}
})

beforeEach(() => {
  $consent.set([])
  $allowed.set([])
  $agent.set({ seenAt: null, version: null })
  $hermosoReady.set(false)
  $teleport.set({ error: null, home: null, phase: 'idle', trip: null, updatedAt: 0 })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the consent store', () => {
  it('queues a request main pushes, drops it when main says it is over, and a request is never queued twice', async () => {
    const bridge = installBridge()
    const stop = startHermoso()

    await waitFor(() => expect($hermosoReady.get()).toBe(true))

    bridge.emit({ prompt: PROMPT, type: 'consent' })
    bridge.emit({ prompt: PROMPT, type: 'consent' })
    expect($consent.get()).toHaveLength(1)

    bridge.emit({ id: 'c1', type: 'consent-closed' })
    expect($consent.get()).toHaveLength(0)

    // junk is ignored
    bridge.emit({ prompt: { nonsense: true }, type: 'consent' })
    bridge.emit({ type: 'consent-closed' })
    expect($consent.get()).toHaveLength(0)

    stop()
  })

  it('a window that opens while a request is waiting still sees it', async () => {
    installBridge({ pending: [PROMPT] })
    startHermoso()

    await waitFor(() => expect($consent.get()).toHaveLength(1))
  })

  it('follows the agent link and the list of what is always allowed', async () => {
    const bridge = installBridge({ allowed: [{ at: 5, key: 'teleport:de', label: 'Germany' }] })

    startHermoso()
    await waitFor(() => expect($allowed.get()).toHaveLength(1))

    bridge.emit({ agent: { seenAt: 1000, version: '0.2.0' }, type: 'agent' })
    expect($agent.get()).toEqual({ seenAt: 1000, version: '0.2.0' })
  })
})

describe('the consent dialog', () => {
  it('shows nothing when nothing is asked', () => {
    installBridge()
    const { container } = render(<ConsentHost />)

    expect(container.textContent).toBe('')
  })

  it('shows the request in plain words, says it is showing it, and defaults to no', async () => {
    const bridge = installBridge()

    $consent.set([PROMPT])
    render(<ConsentHost />)

    expect(await screen.findByText('Teleport to Germany?')).toBeTruthy()
    expect(screen.getByText(/compare prices/)).toBeTruthy()
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('consent.ack', { id: 'c1' }))
    const deny = screen.getByRole('button', { name: 'Deny' })

    expect(deny.ownerDocument.activeElement).toBe(deny)
  })

  it('sends back exactly what the person chose', async () => {
    for (const [label, answer] of [
      ['Deny', 'deny'],
      ['Allow once', 'once'],
      ['Always allow Germany', 'always']
    ] as const) {
      const bridge = installBridge()

      $consent.set([PROMPT])

      const { unmount } = render(<ConsentHost />)

      fireEvent.click(await screen.findByRole('button', { name: label }))
      await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('consent.answer', { answer, id: 'c1' }))
      unmount()
    }
  })

  it('has no "always" button for a request that cannot be remembered, and Escape is a no', async () => {
    const bridge = installBridge()

    $consent.set([{ ...PROMPT, allowKey: null, allowLabel: null }])
    render(<ConsentHost />)

    await screen.findByText('Teleport to Germany?')
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()

    const focused = screen.getByRole('button', { name: 'Deny' })

    fireEvent.keyDown(focused.ownerDocument.activeElement ?? focused, { key: 'Escape' })
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('consent.answer', { answer: 'deny', id: 'c1' }))
  })

  it('asks the oldest first, one at a time', async () => {
    installBridge()
    $consent.set([PROMPT, { ...PROMPT, id: 'c2', title: 'Teleport to France?' }])
    render(<ConsentHost />)

    expect(await screen.findByText('Teleport to Germany?')).toBeTruthy()
    expect(screen.queryByText('Teleport to France?')).toBeNull()

    act(() => $consent.set([{ ...PROMPT, id: 'c2', title: 'Teleport to France?' }]))
    expect(await screen.findByText('Teleport to France?')).toBeTruthy()
  })
})

describe('the Hermoso page', () => {
  it('lists what is always allowed and takes it back', async () => {
    const bridge = installBridge({ allowed: [{ at: 5, key: 'teleport:de', label: 'Germany' }] })

    $allowed.set([{ at: 5, key: 'teleport:de', label: 'Germany' }])
    render(<HermosoPage />)

    expect(screen.getByText('Germany')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }))
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('consent.revoke', { key: 'teleport:de' }))
    await waitFor(() => expect($allowed.get()).toHaveLength(0))
  })

  it('says when nothing is allowed, and whether the agent has been in touch', () => {
    installBridge()
    render(<HermosoPage />)

    expect(screen.getByText(/Nothing yet/)).toBeTruthy()
    expect(screen.getByTestId('agent-status').textContent).toContain('Not seen yet')

    act(() => $agent.set({ seenAt: Date.now(), version: '0.2.0' }))
    expect(screen.getByTestId('agent-status').textContent).toContain('Connected')
    expect(screen.getByTestId('agent-status').textContent).toContain('0.2.0')
  })
})
