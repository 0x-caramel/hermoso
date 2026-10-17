import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  type ConsentAnswer,
  type ConsentAsk,
  type ConsentPrompt,
  createConsent,
  createFileConsentStore,
  type Remembered,
  sanitizeRemembered
} from './consent'

const ASK: ConsentAsk = {
  allowKey: 'teleport:de',
  allowLabel: 'Germany',
  kind: 'teleport',
  lines: ['The agent wants to move your whole connection to Germany for 10 minutes.', 'Reason: compare prices'],
  title: 'Teleport to Germany?'
}

const ACK_MS = 1500
const TIMEOUT_MS = 120_000

function harness(
  options: {
    native?: (prompt: ConsentPrompt, signal: AbortSignal) => Promise<ConsentAnswer | null>
    remembered?: Record<string, Remembered>
  } = {}
) {
  let remembered = options.remembered ?? {}
  const presented: ConsentPrompt[] = []
  const retired: string[] = []
  const timers: { cancelled: boolean; fn: () => void; ms: number }[] = []
  const log = vi.fn()
  let clock = 1_000

  const consent = createConsent({
    ackMs: ACK_MS,
    log,
    native: options.native,
    now: () => (clock += 1),
    present: prompt => presented.push(prompt),
    retire: id => retired.push(id),
    schedule: (fn, ms) => {
      const timer = { cancelled: false, fn, ms }

      timers.push(timer)

      return () => {
        timer.cancelled = true
      }
    },
    store: {
      read: () => ({ ...remembered }),
      write: all => {
        remembered = { ...all }
      }
    },
    timeoutMs: TIMEOUT_MS
  })

  return {
    consent,
    fire: (ms: number) => timers.filter(timer => timer.ms === ms && !timer.cancelled).forEach(timer => timer.fn()),
    log,
    presented,
    remembered: () => remembered,
    retired,
    timers
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('asking', () => {
  it('shows the request, waits, and returns the answer; the windows are told when it is over', async () => {
    const h = harness()
    const decision = h.consent.ask(ASK)

    await settle()
    expect(h.presented).toHaveLength(1)
    expect(h.presented[0]).toMatchObject({ kind: 'teleport', title: 'Teleport to Germany?' })
    expect(h.consent.pending()).toHaveLength(1)

    expect(h.consent.answer(h.presented[0].id, 'once')).toBe(true)
    expect(await decision).toEqual({ allowed: true, answer: 'once' })
    expect(h.retired).toEqual([h.presented[0].id])
    expect(h.consent.pending()).toHaveLength(0)
  })

  it('a no, and anything that is not a clear yes, is a no', async () => {
    for (const given of ['deny', 'maybe', '', null, undefined, 5, { answer: 'once' }]) {
      const h = harness()
      const decision = h.consent.ask(ASK)

      await settle()
      h.consent.answer(h.presented[0].id, given)
      expect(await decision).toEqual({ allowed: false, answer: 'deny' })
    }
  })

  it('no answer in two minutes is a no', async () => {
    const h = harness()
    const decision = h.consent.ask(ASK)

    await settle()
    h.fire(TIMEOUT_MS)

    expect(await decision).toEqual({ allowed: false, answer: 'timeout' })
    expect(h.retired).toHaveLength(1)
    // an answer that comes too late changes nothing
    expect(h.consent.answer(h.presented[0].id, 'once')).toBe(false)
  })

  it('answers for a request that does not exist are refused', () => {
    const h = harness()

    expect(h.consent.answer('nope', 'once')).toBe(false)
  })

  it('every request has its own id, and each is answered on its own', async () => {
    const h = harness()
    const a = h.consent.ask({ ...ASK, allowKey: null })
    const b = h.consent.ask({ ...ASK, allowKey: null })

    await settle()
    expect(new Set(h.presented.map(prompt => prompt.id)).size).toBe(2)

    h.consent.answer(h.presented[1].id, 'once')
    h.consent.answer(h.presented[0].id, 'deny')
    expect((await a).allowed).toBe(false)
    expect((await b).allowed).toBe(true)
  })

  it('a window that cannot show the request does not lose it', async () => {
    const h = harness()

    const throwing = createConsent({
      log: h.log,
      present: () => {
        throw new Error('no window')
      },
      retire: () => {},
      schedule: () => () => {},
      store: { read: () => ({}), write: () => {} }
    })

    void throwing.ask(ASK)
    await settle()
    expect(throwing.pending()).toHaveLength(1)
    expect(h.log.mock.calls.join('\n')).toContain('could not present the request: no window')
  })
})

describe('"always allow"', () => {
  it('is remembered for exactly the thing asked about, and nothing else', async () => {
    const h = harness()
    const first = h.consent.ask(ASK)

    await settle()
    h.consent.answer(h.presented[0].id, 'always')
    expect(await first).toEqual({ allowed: true, answer: 'always' })
    expect(Object.keys(h.remembered())).toEqual(['teleport:de'])
    expect(h.remembered()['teleport:de'].label).toBe('Germany')

    // the same thing again: no question
    expect(await h.consent.ask(ASK)).toEqual({ allowed: true, answer: 'remembered' })
    expect(h.presented).toHaveLength(1)

    // another country: asks again
    const other = h.consent.ask({ ...ASK, allowKey: 'teleport:fr', allowLabel: 'France' })

    await settle()
    expect(h.presented).toHaveLength(2)
    h.consent.answer(h.presented[1].id, 'deny')
    expect((await other).allowed).toBe(false)
  })

  it('cannot be remembered for a request that has no key', async () => {
    const h = harness()
    const decision = h.consent.ask({ ...ASK, allowKey: null })

    await settle()
    h.consent.answer(h.presented[0].id, 'always')
    expect((await decision).allowed).toBe(true)
    expect(h.remembered()).toEqual({})
  })

  it('is listed and can be taken back', async () => {
    const h = harness({ remembered: { 'teleport:de': { at: 5, label: 'Germany' } } })

    expect(h.consent.always()).toEqual([{ at: 5, key: 'teleport:de', label: 'Germany' }])
    expect(h.consent.revoke('teleport:de')).toBe(true)
    expect(h.consent.revoke('teleport:de')).toBe(false)
    expect(h.consent.always()).toEqual([])

    const decision = h.consent.ask(ASK)

    await settle()
    expect(h.presented).toHaveLength(1)
    h.consent.answer(h.presented[0].id, 'deny')
    expect((await decision).allowed).toBe(false)
  })
})

describe('when no window shows the request', () => {
  it('a native dialog asks instead, after a moment, and its answer counts', async () => {
    const native = vi.fn(async () => 'once' as ConsentAnswer)
    const h = harness({ native })
    const decision = h.consent.ask(ASK)

    await settle()
    expect(native).not.toHaveBeenCalled()

    h.fire(ACK_MS)
    expect(await decision).toEqual({ allowed: true, answer: 'once' })
    expect(native).toHaveBeenCalledTimes(1)
    expect((native.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'Teleport to Germany?' })
    expect(h.retired).toHaveLength(1)
  })

  it('a window that says it is showing the request makes the native dialog unnecessary', async () => {
    const native = vi.fn(async () => 'once' as ConsentAnswer)
    const h = harness({ native })
    const decision = h.consent.ask(ASK)

    await settle()
    h.consent.ack(h.presented[0].id)
    h.fire(ACK_MS)
    expect(native).not.toHaveBeenCalled()

    h.consent.answer(h.presented[0].id, 'deny')
    expect((await decision).allowed).toBe(false)
  })

  it('whoever answers first wins, and the native dialog is dismissed when the window does', async () => {
    let signal: AbortSignal | undefined

    const native = vi.fn(
      (_prompt: ConsentPrompt, given: AbortSignal) =>
        new Promise<ConsentAnswer | null>(() => {
          signal = given
        })
    )

    const h = harness({ native })
    const decision = h.consent.ask(ASK)

    await settle()
    h.fire(ACK_MS)
    expect(signal?.aborted).toBe(false)

    h.consent.answer(h.presented[0].id, 'once')
    expect((await decision).allowed).toBe(true)
    expect(signal?.aborted).toBe(true)
  })

  it('a native dialog that could not be shown, or failed, leaves the request waiting for the window', async () => {
    const none = harness({ native: async () => null })
    const a = none.consent.ask(ASK)

    await settle()
    none.fire(ACK_MS)
    await settle()
    expect(none.consent.pending()).toHaveLength(1)
    none.consent.answer(none.presented[0].id, 'once')
    expect((await a).allowed).toBe(true)

    const broken = harness({
      native: async () => {
        throw new Error('dialog crashed')
      }
    })

    const b = broken.consent.ask(ASK)

    await settle()
    broken.fire(ACK_MS)
    await settle()
    expect(broken.log.mock.calls.join('\n')).toContain('dialog crashed')
    expect(broken.consent.pending()).toHaveLength(1)
    broken.consent.answer(broken.presented[0].id, 'deny')
    expect((await b).allowed).toBe(false)
  })
})

describe('what is remembered on disk', () => {
  it('keeps only well-formed entries', () => {
    expect(sanitizeRemembered(null)).toEqual({})
    expect(sanitizeRemembered({ always: 'x' })).toEqual({})

    expect(
      sanitizeRemembered({
        always: {
          '../evil': { at: 1, label: 'x' },
          'teleport:DE': { at: 1, label: 'x' },
          'teleport:de': { at: 5, label: 'Germany' },
          'teleport:fr': 'not an object',
          'teleport:it': { at: 'soon', label: 42 }
        }
      })
    ).toEqual({
      'teleport:de': { at: 5, label: 'Germany' },
      'teleport:it': { at: 0, label: 'teleport:it' }
    })
  })

  it('round-trips through a file, survives a damaged one, and writes atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-consent-'))

    try {
      const file = path.join(dir, 'nested', 'consent.json')
      const store = createFileConsentStore(file)

      expect(store.read()).toEqual({})
      store.write({ 'teleport:de': { at: 5, label: 'Germany' } })
      expect(store.read()).toEqual({ 'teleport:de': { at: 5, label: 'Germany' } })
      expect(fs.readdirSync(path.dirname(file))).toEqual(['consent.json'])

      fs.writeFileSync(file, '{ not json')
      expect(store.read()).toEqual({})
    } finally {
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })
})
