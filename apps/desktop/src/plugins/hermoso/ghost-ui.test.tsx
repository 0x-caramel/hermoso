import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CALM_GHOST, type GhostView } from './api'
import { GhostChip } from './ghost-chip'
import { GhostPanel } from './ghost-panel'
import { HermosoPage } from './page'
import { $ghost, $hermosoReady, loadGhost, startHermoso } from './store'

const KEY = 'CommandOrControl+Alt+Shift+Backspace'

const main = (patch: Partial<GhostView> = {}): GhostView => ({ canOpen: true, ghost: false, key: KEY, ...patch })
const ghost = (patch: Partial<GhostView> = {}): GhostView => ({ canOpen: false, ghost: true, key: KEY, ...patch })

function installBridge(answers: Record<string, unknown> = {}) {
  const call = vi.fn(async (method: string, params?: unknown) => {
    const answer = answers[method]

    return typeof answer === 'function' ? (answer as (params?: unknown) => unknown)(params) : (answer ?? null)
  })

  const hermoso = { call, onEvent: vi.fn(() => () => {}) }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { hermoso }

  return { call }
}

beforeEach(() => {
  $ghost.set(CALM_GHOST)
  $hermosoReady.set(false)
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the ghost in the store', () => {
  it('loads what main says, and ignores an answer that is not a view', async () => {
    installBridge({ 'ghost.state': main() })
    await loadGhost()
    expect($ghost.get()).toEqual(main())

    installBridge({ 'ghost.state': { nonsense: 1 } })
    await loadGhost()
    expect($ghost.get()).toEqual(main())
  })

  it('is loaded when the window starts', async () => {
    installBridge({ 'ghost.state': ghost() })
    startHermoso()
    await waitFor(() => expect($ghost.get().ghost).toBe(true))
  })
})

describe('the ghost section in the main window', () => {
  it('says what a ghost is and what is copied into it, and what deleting does not do', () => {
    installBridge()
    $ghost.set(main())
    render(<GhostPanel />)

    expect(screen.getByText(/A window that keeps nothing/)).toBeTruthy()
    expect(screen.getByText(/copied into the temporary folder for the session, and deleted with it/)).toBeTruthy()
    expect(screen.getByText(/Deleted is not shredded/)).toBeTruthy()
    expect(screen.getByText(/Your model’s provider still sees what you send it/)).toBeTruthy()
    expect(screen.queryByTestId('ghost-banner')).toBeNull()
  })

  it('opens a ghost on the person’s click, and says it is opening', async () => {
    const bridge = installBridge({ 'ghost.open': { dir: 'C:\\tmp\\hermoso-ghost-0123456789ab', ok: true, pid: 12 } })

    $ghost.set(main())
    render(<GhostPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Open a ghost window/ }))
    expect((await screen.findByTestId('ghost-opened')).textContent).toBe('The ghost window is opening…')
    expect(bridge.call).toHaveBeenCalledWith('ghost.open', undefined)
  })

  it('says why not in plain words, and falls back to what main said for a reason it has no words for', async () => {
    installBridge({ 'ghost.open': { code: 'no-setup', message: 'raw', ok: false } })
    $ghost.set(main())

    const { unmount } = render(<GhostPanel />)

    fireEvent.click(screen.getByRole('button', { name: /Open a ghost window/ }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'There is no model setup to copy yet. Set a model up first, then open a ghost.'
    )
    unmount()

    installBridge({ 'ghost.open': { code: 'something-new', message: 'The disk is full.', ok: false } })
    render(<GhostPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Open a ghost window/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('The disk is full.')
  })

  it('a silent main is an answer too', async () => {
    installBridge()
    $ghost.set(main())
    render(<GhostPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Open a ghost window/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('Hermoso did not answer.')
  })

  it('cannot be opened when main says it cannot', () => {
    installBridge()
    $ghost.set(main({ canOpen: false }))
    render(<GhostPanel />)
    expect((screen.getByRole('button', { name: /Open a ghost window/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('inside a ghost', () => {
  it('says so, has the panic button and the key, and no way to open another', () => {
    installBridge()
    $ghost.set(ghost())
    render(<GhostPanel />)

    expect(screen.getByTestId('ghost-banner').textContent).toBe('This is a ghost window: nothing is kept.')
    expect(screen.getByRole('button', { name: 'Panic: delete everything and close' })).toBeTruthy()
    expect(screen.getByText(`Or press ${KEY} from anywhere.`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open a ghost window/ })).toBeNull()
  })

  it('panics on the person’s click', async () => {
    const bridge = installBridge({ 'ghost.panic': { ok: true } })

    $ghost.set(ghost())
    render(<GhostPanel />)
    fireEvent.click(screen.getByTestId('panic'))
    await waitFor(() => expect(bridge.call).toHaveBeenCalledWith('ghost.panic', undefined))
  })
})

describe('the status-bar chip', () => {
  it('is not there in the main window, nor before main has answered', () => {
    installBridge()
    $ghost.set(main())

    const { container } = render(<GhostChip />)

    expect(container.querySelector('button')).toBeNull()
    act(() => $hermosoReady.set(true))
    expect(container.querySelector('button')).toBeNull()
  })

  it('is there in a ghost, and the panic button is behind a click', () => {
    installBridge()
    $hermosoReady.set(true)
    $ghost.set(ghost())
    render(<GhostChip />)

    const chip = screen.getByRole('button', { name: 'Ghost window: nothing is kept' })

    expect(chip.textContent).toBe('Ghost')
    fireEvent.click(chip)
    expect(screen.getByTestId('panic')).toBeTruthy()
  })
})

describe('the page', () => {
  it('has the ghost section after the Time Machine', () => {
    installBridge()
    render(<HermosoPage />)

    const [machine, phantom] = ['Time Machine', 'Ghost'].map(title => screen.getAllByText(title)[0])

    expect(machine.compareDocumentPosition(phantom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
