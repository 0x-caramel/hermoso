/**
 * What Hermoso has done for the person, kept in a small file in the app's data folder (main process, Electron-free):
 * a handful of counters (how often the shield froze the agent and for how long, what the guardian asked, refused
 * and allowed, how many trips) and the last few things the guardian decided. It is the memory behind the guardian's
 * journal and behind Aura; nothing here decides anything.
 *
 * Writes are small and rare: counters are batched and written a few seconds after the last change, and once more on
 * the way out.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { GuardianEvent } from './guardian'

export interface StatsFile {
  counters: Record<string, number>
  /** The guardian's last decisions, newest first. */
  recent: GuardianEvent[]
  since: number
  version: 1
}

export interface StatsStore {
  read: () => unknown
  write: (value: StatsFile) => void
}

const COUNTER = /^[a-zA-Z][a-zA-Z0-9]{0,30}$/
const MAX_RECENT = 30
const DECISIONS = new Set(['allowed', 'always', 'blocked', 'denied', 'remembered', 'timeout'])

export function sanitizeStats(raw: unknown, now: number): StatsFile {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
  const counters: Record<string, number> = {}

  for (const [name, value] of Object.entries((source.counters ?? {}) as Record<string, unknown>)) {
    if (COUNTER.test(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      counters[name] = Math.floor(value)
    }
  }

  const recent: GuardianEvent[] = []

  for (const item of Array.isArray(source.recent) ? source.recent : []) {
    if (
      recent.length < MAX_RECENT &&
      item &&
      typeof item === 'object' &&
      typeof item.rule === 'string' &&
      DECISIONS.has(item.decision)
    ) {
      recent.push({
        at: Number.isFinite(item.at) ? item.at : 0,
        decision: item.decision,
        detail: typeof item.detail === 'string' ? item.detail.slice(0, 320) : '',
        rule: item.rule.slice(0, 41),
        title: typeof item.title === 'string' ? item.title.slice(0, 80) : item.rule,
        tool: typeof item.tool === 'string' ? item.tool.slice(0, 60) : 'tool'
      })
    }
  }

  return {
    counters,
    recent,
    since: Number.isFinite(source.since) && source.since > 0 ? source.since : now,
    version: 1
  }
}

export function createFileStatsStore(file: string): StatsStore {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },

    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true })

      const temp = `${file}.${process.pid}.tmp`

      fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(temp, file)
    }
  }
}

export interface StatsDeps {
  /** A timer that can be cancelled; the default is an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  log?: (message: string) => void
  now?: () => number
  store: StatsStore
  /** How long after the last change the file is written. */
  writeAfterMs?: number
}

export function createStats(deps: StatsDeps) {
  const now = deps.now ?? Date.now
  const writeAfterMs = deps.writeAfterMs ?? 3_000

  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)

      handle.unref?.()

      return () => clearTimeout(handle)
    })

  let data = sanitizeStats(deps.store.read(), now())
  let dirty = false
  let cancel: (() => void) | null = null

  const flush = (): void => {
    cancel?.()
    cancel = null

    if (!dirty) {
      return
    }

    dirty = false

    try {
      deps.store.write(data)
    } catch (error) {
      dirty = true
      deps.log?.(`[stats] could not write: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const touched = (): void => {
    dirty = true
    cancel ??= schedule(flush, writeAfterMs)
  }

  return {
    /** Add to a counter. A name that is not a plain word is ignored. */
    bump(name: string, amount = 1): void {
      if (COUNTER.test(name) && Number.isFinite(amount) && amount > 0) {
        data.counters[name] = (data.counters[name] ?? 0) + Math.floor(amount)
        touched()
      }
    },

    /** Remember what the guardian decided (newest first, the last few only) and count it. */
    event(event: GuardianEvent): void {
      data.recent = [event, ...data.recent].slice(0, MAX_RECENT)
      touched()
    },

    flush,

    get: (): StatsFile => ({ ...data, counters: { ...data.counters }, recent: [...data.recent] }),

    /** Forget everything and start counting again from now. */
    reset(): void {
      data = sanitizeStats(null, now())
      touched()
    }
  }
}

export type Stats = ReturnType<typeof createStats>
