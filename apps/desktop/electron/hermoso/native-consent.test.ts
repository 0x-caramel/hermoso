import { describe, expect, it, vi } from 'vitest'

import type { ConsentPrompt } from './consent'
import { createNativeConsent } from './native-consent'

const prompt = (patch: Partial<ConsentPrompt> = {}): ConsentPrompt => ({
  allowKey: 'teleport:de',
  allowLabel: 'Germany',
  askedAt: 1,
  id: 'c1',
  kind: 'teleport',
  lines: ['Line one.', 'Line two.'],
  title: 'Teleport to Germany?',
  ...patch
})

function make(response: number) {
  const showMessageBox = vi.fn(async (_window: unknown, _options: any) => ({ response }))
  const win = { title: 'main' }

  return { ask: createNativeConsent({ dialog: { showMessageBox }, window: () => win }), showMessageBox, win }
}

describe('the native consent dialog', () => {
  it('asks with the request in plain words, attached to the main window, and defaults to no', async () => {
    const h = make(2)
    const controller = new AbortController()

    expect(await h.ask(prompt(), controller.signal)).toBe('deny')

    const [window, options] = h.showMessageBox.mock.calls[0]

    expect(window).toBe(h.win)
    expect(options).toMatchObject({
      buttons: ['Allow once', 'Always allow Germany', 'Deny'],
      cancelId: 2,
      defaultId: 2,
      detail: 'Line one.\n\nLine two.',
      message: 'Teleport to Germany?',
      title: 'Hermoso'
    })
    expect(options.signal).toBe(controller.signal)
  })

  it('maps the buttons to the answers', async () => {
    expect(await make(0).ask(prompt(), new AbortController().signal)).toBe('once')
    expect(await make(1).ask(prompt(), new AbortController().signal)).toBe('always')
    expect(await make(2).ask(prompt(), new AbortController().signal)).toBe('deny')
  })

  it('has no "always" button for a request that cannot be remembered', async () => {
    const none = prompt({ allowKey: null, allowLabel: null })
    const h = make(1)

    expect(await h.ask(none, new AbortController().signal)).toBe('deny')
    expect(h.showMessageBox.mock.calls[0][1].buttons).toEqual(['Allow once', 'Deny'])
    expect(await make(0).ask(none, new AbortController().signal)).toBe('once')
  })

  it('is not an answer when the window already answered and dismissed it', async () => {
    const controller = new AbortController()

    const showMessageBox = vi.fn(async () => {
      controller.abort()

      return { response: 0 }
    })

    const ask = createNativeConsent({ dialog: { showMessageBox }, window: () => null })

    expect(await ask(prompt(), controller.signal)).toBeNull()
  })

  it('works without a window to attach to', async () => {
    const showMessageBox = vi.fn(async (_window: unknown, _options: unknown) => ({ response: 0 }))
    const ask = createNativeConsent({ dialog: { showMessageBox }, window: () => undefined })

    expect(await ask(prompt(), new AbortController().signal)).toBe('once')
    expect(showMessageBox.mock.calls[0][0]).toBeNull()
  })
})
