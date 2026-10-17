import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GuardianEvent } from './guardian'
import { createFileStatsStore, createStats, sanitizeStats, type StatsFile, type StatsStore } from './stats'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-stats-'))

  dirs.push(dir)

  return dir
}

const event = (n: number): GuardianEvent => ({
  at: n,
  decision: 'denied',
  detail: `rm -rf d${n}`,
  rule: 'delete-many',
  title: 'Deleting many files',
  tool: 'terminal'
})

function make(initial: unknown = null) {
  const writes: StatsFile[] = []
  const timers: Array<{ cancelled: boolean; fn: () => void; ms: number }> = []
  const store: StatsStore = { read: () => initial, write: value => writes.push(JSON.parse(JSON.stringify(value))) }

  const stats = createStats({
    now: () => 5_000,
    schedule: (fn, ms) => {
      const timer = { cancelled: false, fn, ms }

      timers.push(timer)

      return () => {
        timer.cancelled = true
      }
    },
    store
  })

  return { stats, timers, writes }
}

describe('reading what was kept', () => {
  it('starts empty, now, when there is nothing or something that is not stats', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}]) {
      expect(sanitizeStats(raw, 7)).toEqual({ counters: {}, recent: [], since: 7, version: 1 })
    }
  })

  it('keeps sound counters and sound events, and nothing else', () => {
    const kept = sanitizeStats(
      {
        counters: { freezes: 3.9, 'bad name': 1, guardianAsked: 2, negative: -1, text: 'x', toobig: Infinity },
        recent: [event(1), { rule: 'x', decision: 'maybe' }, null, 'x', { ...event(2), detail: 'd'.repeat(900) }],
        since: 123
      },
      7
    )

    expect(kept.counters).toEqual({ freezes: 3, guardianAsked: 2 })
    expect(kept.recent.map(item => item.at)).toEqual([1, 2])
    expect(kept.recent[1].detail).toHaveLength(320)
    expect(kept.since).toBe(123)
  })
})

describe('counting', () => {
  it('adds to counters, ignoring names that are not plain words and amounts that are not positive', () => {
    const { stats } = make()

    stats.bump('freezes')
    stats.bump('freezes', 2)
    stats.bump('frozenSeconds', 41.7)
    stats.bump('bad name')
    stats.bump('x', 0)
    stats.bump('x', -3)
    stats.bump('x', Number.NaN)
    expect(stats.get().counters).toEqual({ freezes: 3, frozenSeconds: 41 })
  })

  it('writes a few seconds after the last change, once, however many changes there were', () => {
    const { stats, timers, writes } = make()

    stats.bump('a')
    stats.bump('b')
    stats.event(event(1))
    expect(writes).toEqual([])
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(3_000)

    timers[0].fn()
    expect(writes).toHaveLength(1)
    expect(writes[0].counters).toEqual({ a: 1, b: 1 })
    expect(writes[0].recent).toHaveLength(1)
  })

  it('writes at once when told to, and not at all when nothing changed', () => {
    const { stats, timers, writes } = make()

    stats.flush()
    expect(writes).toEqual([])

    stats.bump('a')
    stats.flush()
    expect(writes).toHaveLength(1)
    expect(timers[0].cancelled).toBe(true)
    stats.flush()
    expect(writes).toHaveLength(1)
  })

  it('a write that fails is tried again later, never lost and never thrown', () => {
    const log = vi.fn()
    let fail = true
    const written: StatsFile[] = []

    const stats = createStats({
      log,
      schedule: () => () => {},
      store: {
        read: () => null,
        write: value => {
          if (fail) {
            throw new Error('disk full')
          }

          written.push(value)
        }
      }
    })

    stats.bump('a')
    expect(() => stats.flush()).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'))

    fail = false
    stats.flush()
    expect(written[0].counters).toEqual({ a: 1 })
  })

  it('keeps the last thirty guardian decisions, newest first', () => {
    const { stats } = make()

    for (let n = 1; n <= 45; n++) {
      stats.event(event(n))
    }

    const recent = stats.get().recent

    expect(recent).toHaveLength(30)
    expect(recent[0].at).toBe(45)
    expect(recent[29].at).toBe(16)
  })

  it('hands out copies, so a window cannot change what is kept', () => {
    const { stats } = make()

    stats.bump('a')
    stats.get().counters.a = 99
    expect(stats.get().counters.a).toBe(1)
  })

  it('can start again from now', () => {
    const { stats } = make({ counters: { a: 9 }, recent: [event(1)], since: 1 })

    expect(stats.get().counters.a).toBe(9)
    stats.reset()
    expect(stats.get()).toEqual({ counters: {}, recent: [], since: 5_000, version: 1 })
  })
})

describe('telling a listener', () => {
  const memoryStore = (): StatsStore => ({ read: () => null, write: () => {} })

  it('says so right after a counter or the journal changes or it starts again, and not when nothing changed', () => {
    const onChange = vi.fn()
    const stats = createStats({ onChange, schedule: () => () => {}, store: memoryStore() })

    stats.bump('freezes')
    expect(onChange).toHaveBeenCalledTimes(1)
    // ignored: not a plain word, and nothing to add
    stats.bump('not a name')
    stats.bump('freezes', 0)
    expect(onChange).toHaveBeenCalledTimes(1)

    stats.event({ at: 1, decision: 'denied', detail: 'x', rule: 'delete-many', title: 't', tool: 'terminal' })
    expect(onChange).toHaveBeenCalledTimes(2)
    stats.reset()
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('never lets a listener that fails stop the counting', () => {
    const log = vi.fn()

    const stats = createStats({
      log,
      onChange: () => {
        throw new Error('window gone')
      },
      schedule: () => () => {},
      store: memoryStore()
    })

    stats.bump('rewinds')
    expect(stats.get().counters.rewinds).toBe(1)
    expect(log).toHaveBeenCalledWith('[stats] a listener failed: window gone')
  })
})

describe('the file', () => {
  it('is written whole and read back, and a missing or damaged file reads as nothing', () => {
    const file = path.join(temp(), 'nested', 'stats.json')
    const store = createFileStatsStore(file)

    expect(store.read()).toBeNull()

    const value: StatsFile = { counters: { freezes: 2 }, recent: [event(1)], since: 9, version: 1 }

    store.write(value)
    expect(store.read()).toEqual(value)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['stats.json'])

    fs.writeFileSync(file, '{ not json')
    expect(store.read()).toBeNull()
  })
})
