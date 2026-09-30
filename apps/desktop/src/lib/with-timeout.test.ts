import { describe, expect, it, vi } from 'vitest'

import { isTimeoutError, withTimeout, withTimeoutWhile } from './with-timeout'

describe('withTimeoutWhile', () => {
  it('renews the budget while the wait is a legitimately long one, then settles with the work', async () => {
    vi.useFakeTimers()

    try {
      let resolveWork: (value: string) => void = () => undefined
      const work = new Promise<string>(resolve => (resolveWork = resolve))
      const keepWaiting = vi.fn(async () => true)
      const result = withTimeoutWhile(work, 100, 'timed out', keepWaiting)

      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(100)
      expect(keepWaiting).toHaveBeenCalledTimes(3)

      resolveWork('connected')
      await expect(result).resolves.toBe('connected')

      // nothing is left armed once the work settled
      await vi.advanceTimersByTimeAsync(1000)
      expect(keepWaiting).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out like withTimeout once the wait is no longer a legitimate one', async () => {
    vi.useFakeTimers()

    try {
      let answers = [true, true, false]
      const keepWaiting = vi.fn(async () => answers.shift() ?? false)
      const result = withTimeoutWhile(new Promise<never>(() => undefined), 100, 'timed out', keepWaiting)
      const rejection = expect(result).rejects.toSatisfy(isTimeoutError)

      await vi.advanceTimersByTimeAsync(300)
      await rejection
      expect(keepWaiting).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a failing check as "not a legitimate wait": a broken probe must not hang the boot', async () => {
    vi.useFakeTimers()

    try {
      const result = withTimeoutWhile(new Promise<never>(() => undefined), 50, 'timed out', async () => {
        throw new Error('bridge gone')
      })

      const rejection = expect(result).rejects.toSatisfy(isTimeoutError)

      await vi.advanceTimersByTimeAsync(50)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with the work error right away, and runs onTimeout before a real timeout', async () => {
    vi.useFakeTimers()

    try {
      await expect(
        withTimeoutWhile(Promise.reject(new Error('boom')), 50, 'timed out', async () => true)
      ).rejects.toThrow('boom')

      const onTimeout = vi.fn()

      const result = withTimeoutWhile(
        new Promise<never>(() => undefined),
        50,
        'timed out',
        async () => false,
        onTimeout
      )

      const rejection = expect(result).rejects.toSatisfy(isTimeoutError)

      await vi.advanceTimersByTimeAsync(50)
      await rejection
      expect(onTimeout).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('withTimeout', () => {
  it('rejects with an onTimeout exception instead of letting it escape the timer callback', async () => {
    vi.useFakeTimers()

    try {
      const callbackFailure = new Error('abort callback failed')

      const result = withTimeout(new Promise<never>(() => undefined), 10, 'work timed out', () => {
        throw callbackFailure
      })

      const rejection = expect(result).rejects.toBe(callbackFailure)

      await vi.advanceTimersByTimeAsync(10)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
