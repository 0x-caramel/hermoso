import { host } from '@hermes/plugin-sdk'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALM_TIME_MACHINE, type RestoreResult, type Snapshot, type SnapshotDiff, type SnapshotList } from './api'
import { HermosoPage } from './page'
import { $timeMachine, loadTimeMachine, parseRewindOutput, startHermoso } from './store'
import { summaryOf, TimeMachinePanel, whenText } from './timemachine-panel'

const SNAPSHOTS: Snapshot[] = [
  { hash: 'bbbb2222', message: 'auto: before write_file', timestamp: '2026-10-17T12:30:00+02:00' },
  { hash: 'aaaa1111', message: 'auto: before patch', timestamp: '2026-10-17T11:00:00+02:00' }
]

const RESTORED: RestoreResult = {
  reason: 'before patch',
  restored_files: ['a.txt', 'b.txt'],
  restored_to: 'aaaa1111',
  skipped_user_edits: ['mine.txt'],
  success: true
}

type Atom = { set: (value: unknown) => void }

const setAtom = (atom: unknown, value: unknown) => (atom as Atom).set(value)

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

  return { call, emit: (payload: unknown) => act(() => listeners.forEach(listener => listener(payload))) }
}

/** The gateway as the panel sees it: the snapshots and the diff are Hermes' own RPCs, the rewind is the plugin's command. */
function gateway(
  options: {
    diff?: Error | SnapshotDiff
    list?: Error | SnapshotList
    /** What `/hermoso-rewind` prints (a result as JSON, or any text), or an error from the gateway. */
    rewind?: Error | RestoreResult | string
  } = {}
) {
  const request = vi.spyOn(host, 'request').mockImplementation((async (method: string) => {
    if (method === 'slash.exec') {
      const said = options.rewind ?? RESTORED

      if (said instanceof Error) {
        throw said
      }

      return { output: typeof said === 'string' ? said : JSON.stringify(said) }
    }

    const answer =
      method === 'rollback.list'
        ? (options.list ?? { checkpoints: SNAPSHOTS, enabled: true })
        : (options.diff ?? { diff: '+hello\n', stat: ' a.txt | 1 +' })

    if (answer instanceof Error) {
      throw answer
    }

    return answer
  }) as typeof host.request)

  const openSession = vi.spyOn(host, 'openSession').mockResolvedValue(undefined)

  return { openSession, request }
}

beforeEach(() => {
  $timeMachine.set({ active: true, enabled: true })
  setAtom(host.state.activeSessionId, 'rt1')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setAtom(host.state.activeSessionId, null)
  $timeMachine.set(CALM_TIME_MACHINE)
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the time machine in the store', () => {
  it('loads what main says, and ignores an answer that is not a view', async () => {
    installBridge({ 'timemachine.state': { active: true, enabled: false } })
    await loadTimeMachine()
    expect($timeMachine.get()).toEqual({ active: true, enabled: false })

    installBridge({ 'timemachine.state': { nonsense: 1 } })
    await loadTimeMachine()
    expect($timeMachine.get()).toEqual({ active: true, enabled: false })
  })

  it('is loaded when the window starts', async () => {
    installBridge({ 'timemachine.state': { active: true, enabled: true } })
    $timeMachine.set(CALM_TIME_MACHINE)
    startHermoso()
    await waitFor(() => expect($timeMachine.get().active).toBe(true))
  })

  it('reads what the rewind command printed: the last line as JSON, or whatever Hermes said as a failure', () => {
    expect(parseRewindOutput(JSON.stringify(RESTORED))).toEqual(RESTORED)
    expect(parseRewindOutput(`noise\n${JSON.stringify({ error: 'x', success: false })}\n`)).toEqual({
      error: 'x',
      success: false
    })
    expect(parseRewindOutput('Unknown command: /hermoso-rewind')).toEqual({
      error: 'Unknown command: /hermoso-rewind',
      success: false
    })
    expect(parseRewindOutput('{"nonsense":1}')).toEqual({ error: '{"nonsense":1}', success: false })
    expect(parseRewindOutput('')).toEqual({ error: 'Hermes did not answer.', success: false })
    expect(parseRewindOutput(undefined)).toEqual({ error: 'Hermes did not answer.', success: false })
    expect(parseRewindOutput('x'.repeat(500)).error).toHaveLength(200)
  })
})

describe('the time machine section', () => {
  it('says that a change of the switch takes effect at the next start, when what runs now is different', () => {
    installBridge()
    gateway()
    $timeMachine.set({ active: true, enabled: false })
    render(<TimeMachinePanel />)

    expect(screen.getByTestId('timemachine-restart').textContent).toBe(
      'This takes effect the next time Hermoso starts.'
    )
    expect(
      screen.getByRole('switch', { name: 'Snapshot before the agent changes files' }).getAttribute('aria-checked')
    ).toBe('false')
  })

  it('does not look at snapshots when this run of Hermes has none', () => {
    installBridge()

    const { request } = gateway()

    $timeMachine.set({ active: false, enabled: true })
    render(<TimeMachinePanel />)

    expect(request).not.toHaveBeenCalled()
    expect(screen.queryByTestId('timemachine-list')).toBeNull()
  })

  it('asks to open a chat when there is none', () => {
    installBridge()
    gateway()
    setAtom(host.state.activeSessionId, null)
    render(<TimeMachinePanel />)

    expect(screen.getByText('Open a chat in a project folder to see its snapshots.')).toBeTruthy()
  })

  it('says there is nothing yet, and when snapshots were not on for the chat', async () => {
    installBridge()
    gateway({ list: { checkpoints: [], enabled: true } })

    const { unmount } = render(<TimeMachinePanel />)

    expect((await screen.findByTestId('timemachine-empty')).textContent).toMatch(/No snapshots yet/)
    unmount()

    gateway({ list: { checkpoints: [], enabled: false } })
    render(<TimeMachinePanel />)
    expect(await screen.findByText(/Snapshots were not on when this chat started/)).toBeTruthy()
  })

  it('lists the chat’s snapshots, newest first, for the chat that is open', async () => {
    installBridge()

    const { request } = gateway()

    render(<TimeMachinePanel />)

    const list = await screen.findByTestId('timemachine-list')

    expect(request).toHaveBeenCalledWith('rollback.list', { session_id: 'rt1' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list.textContent).toContain(whenText(SNAPSHOTS[0].timestamp))
    expect(list.textContent).toContain('auto: before write_file')
    expect(list.querySelector('[data-hash]')?.getAttribute('data-hash')).toBe('bbbb2222')
  })

  it('shows what changed since a snapshot, asked of Hermes for exactly that one, and cut when it is long', async () => {
    installBridge()

    const { request } = gateway({ diff: { diff: `+${'x'.repeat(5000)}`, stat: ' a.txt | 1 +' } })

    render(<TimeMachinePanel />)

    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'See changes' }))

    const diff = await within(first).findByTestId('timemachine-diff')

    expect(request).toHaveBeenCalledWith('rollback.diff', { hash: 'bbbb2222', session_id: 'rt1' })
    expect(diff.textContent?.startsWith(' a.txt | 1 +')).toBe(true)
    expect(diff.textContent?.length).toBeLessThanOrEqual(2400)
  })

  it('says so when Hermes could not say what changed, or nothing changed', async () => {
    installBridge()
    gateway({ diff: new Error('nope') })

    const { unmount } = render(<TimeMachinePanel />)
    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'See changes' }))
    expect(await within(first).findByText('Hermes could not say what changed.')).toBeTruthy()
    unmount()

    gateway({ diff: { diff: '', stat: '' } })
    render(<TimeMachinePanel />)

    const again = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(again).getByRole('button', { name: 'See changes' }))
    expect((await within(again).findByTestId('timemachine-diff')).textContent).toBe(
      'Nothing has changed since this snapshot.'
    )
  })
})

describe('rewinding', () => {
  it('asks first, in plain words, and cancels without touching anything', async () => {
    installBridge()

    const { request } = gateway()

    render(<TimeMachinePanel />)

    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'Rewind to here' }))

    const confirm = within(first).getByTestId('timemachine-confirm')

    expect(confirm.textContent).toContain('Everything the agent changed after that is undone')
    expect(confirm.textContent).toContain('Files you edited yourself are kept')
    expect(confirm.textContent).toContain('The chat is left as it is')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(within(first).queryByTestId('timemachine-confirm')).toBeNull()
    expect(request.mock.calls.some(call => call[0] === 'slash.exec')).toBe(false)
  })

  it('puts the files back through the plugin’s own safe command, says what was done, keeps the person’s edits, and is counted', async () => {
    const bridge = installBridge()
    const { openSession, request } = gateway()

    render(<TimeMachinePanel />)

    const second = within(await screen.findByTestId('timemachine-list')).getAllByRole('listitem')[1]

    fireEvent.click(within(second).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(second).getByRole('button', { name: 'Rewind' }))

    expect((await screen.findByTestId('timemachine-note')).textContent).toBe(
      'Rewound: 2 files put back. 1 file you changed yourself was kept. The chat was left as it is, so the agent still knows what it did: tell it the files are back.'
    )
    expect(request).toHaveBeenCalledWith('slash.exec', { command: '/hermoso-rewind aaaa1111', session_id: 'rt1' })
    expect(request.mock.calls.some(call => call[0] === 'rollback.restore')).toBe(false)
    expect(openSession).not.toHaveBeenCalled()
    expect(bridge.call).toHaveBeenCalledWith('timemachine.rewound', undefined)
    expect(request.mock.calls.filter(call => call[0] === 'rollback.list').length).toBeGreaterThanOrEqual(2)
  })

  it('says when files could not be removed', async () => {
    installBridge()
    gateway({ rewind: { ...RESTORED, failed_deletes: ['locked.txt'], skipped_user_edits: [] } })
    render(<TimeMachinePanel />)

    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(first).getByRole('button', { name: 'Rewind' }))
    expect((await screen.findByTestId('timemachine-note')).textContent).toContain('1 file could not be removed.')
  })

  it('says why when Hermes refuses, and counts nothing', async () => {
    const bridge = installBridge()

    gateway({ rewind: { error: "Checkpoint 'aaaa1111' not found", success: false } })
    render(<TimeMachinePanel />)

    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(first).getByRole('button', { name: 'Rewind' }))

    const note = await screen.findByTestId('timemachine-note')

    expect(note.textContent).toBe("It was not rewound: Checkpoint 'aaaa1111' not found")
    expect(note.getAttribute('role')).toBe('alert')
    expect(bridge.call.mock.calls.some(call => call[0] === 'timemachine.rewound')).toBe(false)
  })

  it('an error from the gateway, or a command it does not know, is a failure that says so', async () => {
    installBridge()
    gateway({ rewind: new Error('gateway closed') })

    const { unmount } = render(<TimeMachinePanel />)
    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(first).getByRole('button', { name: 'Rewind' }))
    expect((await screen.findByTestId('timemachine-note')).textContent).toBe('It was not rewound: gateway closed')
    unmount()

    gateway({ rewind: 'Unknown command: /hermoso-rewind' })
    render(<TimeMachinePanel />)

    const again = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(again).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(again).getByRole('button', { name: 'Rewind' }))
    expect((await screen.findByTestId('timemachine-note')).textContent).toBe(
      'It was not rewound: Unknown command: /hermoso-rewind'
    )
  })

  it('a result that says no, with no reason, is still a no', async () => {
    installBridge()
    gateway({ rewind: { success: false } })
    render(<TimeMachinePanel />)

    const first = (await screen.findByTestId('timemachine-list')).querySelector('li') as HTMLElement

    fireEvent.click(within(first).getByRole('button', { name: 'Rewind to here' }))
    fireEvent.click(within(first).getByRole('button', { name: 'Rewind' }))
    expect((await screen.findByTestId('timemachine-note')).textContent).toBe('It was not rewound.')
  })

  it('writes what was done in words, whatever Hermes sent back', () => {
    const left = 'The chat was left as it is'

    expect(summaryOf({ restored_files: ['a'], success: true })).toMatch(
      new RegExp(`^Rewound: 1 file put back\\. ${left}`)
    )
    expect(summaryOf({ success: true })).toMatch(new RegExp(`^Rewound: 0 files put back\\. ${left}`))
    expect(summaryOf({ restored_files: ['a', 'b'], skipped_user_edits: ['c', 'd'], success: true })).toContain(
      '2 files you changed yourself were kept.'
    )
  })
})

describe('when Hermes does not answer, and the switch', () => {
  it('says so, and does not pretend there is nothing', async () => {
    installBridge()
    gateway({ list: new Error('gateway closed') })
    render(<TimeMachinePanel />)

    expect((await screen.findByRole('alert')).textContent).toBe('Hermes did not answer. Try again in a moment.')
    expect(screen.queryByTestId('timemachine-empty')).toBeNull()
  })

  it('is switched with the person’s own click, and shows what main says afterwards', async () => {
    let enabled = true

    const bridge = installBridge({
      'timemachine.enable': (params: unknown) => {
        enabled = (params as { on: boolean }).on === true

        return { active: true, enabled }
      }
    })

    gateway()
    render(<TimeMachinePanel />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Snapshot before the agent changes files' }))
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('timemachine.enable', { on: false }))
    await waitFor(() => expect($timeMachine.get()).toEqual({ active: true, enabled: false }))
    expect(await screen.findByTestId('timemachine-restart')).toBeTruthy()
  })

  it('states its limits where the person reads them', () => {
    installBridge()
    gateway()
    render(<TimeMachinePanel />)
    expect(screen.getByText(/too broad \(your whole home\)/)).toBeTruthy()
  })

  it('is on the Hermoso page, between the guardian and Teleport', () => {
    installBridge()
    gateway()
    render(<HermosoPage />)

    const [guardian, machine, teleport] = ['Guardian', 'Time Machine', 'Teleport'].map(
      title => screen.getAllByText(title)[0]
    )

    expect(guardian.compareDocumentPosition(machine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(machine.compareDocumentPosition(teleport) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
