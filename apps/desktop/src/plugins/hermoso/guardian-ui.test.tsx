import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALM_GUARDIAN, type ConsentPrompt, type GuardianEvent, type GuardianView } from './api'
import { ConsentHost } from './consent-host'
import { GuardianPanel } from './guardian-panel'
import { HermosoPage } from './page'
import { $consent, $guardian, loadGuardian, startHermoso } from './store'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

const event = (patch: Partial<GuardianEvent> = {}): GuardianEvent => ({
  at: NOW,
  decision: 'denied',
  detail: 'rm -rf data',
  rule: 'delete-many',
  title: 'Deleting many files',
  tool: 'terminal',
  ...patch
})

const view = (patch: Partial<GuardianView> = {}): GuardianView => ({
  enabled: true,
  events: [],
  totals: { allowed: 0, asked: 0, blocked: 0, denied: 0 },
  ...patch
})

function installBridge(answers: Record<string, unknown> = {}) {
  const listeners = new Set<(payload: unknown) => void>()

  const call = vi.fn(async (method: string, params?: unknown) => {
    const answer = answers[method]

    return typeof answer === 'function' ? (answer as (params?: unknown) => unknown)(params) : (answer ?? null)
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
  $guardian.set(CALM_GUARDIAN)
  $consent.set([])
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the guardian in the store', () => {
  it('loads what main says at the start, and again whenever main says it decided something', async () => {
    let current = view({ events: [event()], totals: { allowed: 0, asked: 1, blocked: 0, denied: 1 } })
    const bridge = installBridge({ 'guardian.state': () => current })

    startHermoso()
    await waitFor(() => expect($guardian.get().events).toHaveLength(1))

    current = view({
      events: [event({ at: NOW + 1, decision: 'blocked' }), event()],
      totals: { allowed: 0, asked: 1, blocked: 1, denied: 1 }
    })
    bridge.emit({ event: event({ at: NOW + 1, decision: 'blocked' }), type: 'guardian' })
    await waitFor(() => expect($guardian.get().events).toHaveLength(2))
  })

  it('ignores a push that is not a decision, and an answer that is not a view', async () => {
    const bridge = installBridge({ 'guardian.state': { nonsense: true } })

    startHermoso()
    await loadGuardian()
    expect($guardian.get()).toEqual(CALM_GUARDIAN)

    const before = bridge.call.mock.calls.length

    bridge.emit({ event: { nonsense: true }, type: 'guardian' })
    bridge.emit({ type: 'guardian' })
    expect(bridge.call.mock.calls.length).toBe(before)
  })
})

describe('the guardian section', () => {
  it('says that nothing risky has been tried yet', () => {
    installBridge({ 'guardian.state': view() })
    render(<GuardianPanel />)

    expect(screen.getByTestId('guardian-totals').textContent).toBe('Nothing risky has been tried yet.')
    expect(screen.queryByTestId('guardian-journal')).toBeNull()
  })

  it('counts what it asked and refused, and lists the last decisions with what the agent wanted to do', async () => {
    installBridge({
      'guardian.state': view({
        events: [
          event({ at: NOW + 2, decision: 'blocked', detail: 'rm -rf /', rule: 'catastrophic', title: 'Wiping a disk' }),
          event({
            at: NOW + 1,
            decision: 'always',
            detail: 'git push --force',
            rule: 'git-destructive',
            title: 'Rewriting git history'
          }),
          event()
        ],
        totals: { allowed: 1, asked: 2, blocked: 1, denied: 1 }
      })
    })
    render(<GuardianPanel />)

    await waitFor(() => expect($guardian.get().events).toHaveLength(3))
    expect(screen.getByTestId('guardian-totals').textContent).toBe(
      '2 asked · 1 allowed · 1 denied · 1 refused outright'
    )

    const journal = screen.getByTestId('guardian-journal')

    expect(within(journal).getAllByRole('listitem')).toHaveLength(3)
    expect(journal.querySelector('[data-decision="blocked"]')?.textContent).toBe('Refused')
    expect(journal.querySelector('[data-decision="always"]')?.textContent).toBe('Always allowed')
    expect(journal.querySelector('[data-decision="denied"]')?.textContent).toBe('Denied')
    expect(journal.textContent).toContain('rm -rf /')
    expect(journal.textContent).toContain('git push --force')
  })

  it('lists the first few and no more than the file keeps', async () => {
    const many = Array.from({ length: 12 }, (_, index) => event({ at: NOW + index, detail: `rm -rf d${index}` }))

    installBridge({
      'guardian.state': view({ events: many, totals: { allowed: 0, asked: 12, blocked: 0, denied: 12 } })
    })
    render(<GuardianPanel />)

    await waitFor(() => expect($guardian.get().events).toHaveLength(12))
    expect(within(screen.getByTestId('guardian-journal')).getAllByRole('listitem')).toHaveLength(8)
  })

  it('is switched with the person’s own click, and shows what main says afterwards', async () => {
    let enabled = true

    const bridge = installBridge({
      'guardian.enable': (params: unknown) => {
        enabled = (params as { on: boolean }).on === true

        return view({ enabled })
      },
      'guardian.state': () => view({ enabled })
    })

    render(<GuardianPanel />)

    const toggle = await screen.findByRole('switch', { name: 'Review risky commands' })

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByTestId('guardian-off-note')).toBeNull()

    fireEvent.click(toggle)
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('guardian.enable', { on: false }))
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Review risky commands' }).getAttribute('aria-checked')).toBe('false')
    )
    expect(screen.getByTestId('guardian-off-note').textContent).toContain('never lets the agent wipe a disk')
  })

  it('states what it is: a net with holes, not a sandbox', () => {
    installBridge({ 'guardian.state': view() })
    render(<GuardianPanel />)

    expect(screen.getByText(/a net with holes, not a sandbox/)).toBeTruthy()
  })

  it('is on the Hermoso page, after the shield', async () => {
    installBridge({ 'guardian.state': view() })
    render(<HermosoPage />)

    const [shield, guardian, teleport] = ['Shield', 'Guardian', 'Teleport'].map(title => screen.getAllByText(title)[0])

    expect(shield.compareDocumentPosition(guardian) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(guardian.compareDocumentPosition(teleport) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the consent dialog for a risky command', () => {
  const PROMPT: ConsentPrompt = {
    allowKey: 'guardian:delete-many',
    allowLabel: 'deleting many files',
    askedAt: 1,
    code: 'rm -rf data',
    id: 'c1',
    kind: 'guardian',
    lines: ['The agent wants to run this command.', 'This can delete a whole folder.'],
    title: 'Deleting many files?'
  }

  it('shows the command exactly as it is, in a block of its own, with the choices that fit', async () => {
    const bridge = installBridge({ 'consent.pending': [PROMPT] })

    startHermoso()
    await waitFor(() => expect($consent.get()).toHaveLength(1))
    render(<ConsentHost />)

    expect(screen.getByText('Deleting many files?')).toBeTruthy()
    expect(screen.getByTestId('consent-code').textContent).toBe('rm -rf data')
    expect(screen.getByRole('button', { name: 'Always allow deleting many files' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('consent.answer', { answer: 'deny', id: 'c1' }))
  })

  it('shows no block when there is no command, like a teleport', () => {
    installBridge()
    $consent.set([{ ...PROMPT, allowKey: 'teleport:de', code: null, kind: 'teleport', title: 'Teleport to Germany?' }])
    render(<ConsentHost />)

    expect(screen.queryByTestId('consent-code')).toBeNull()
  })
})
