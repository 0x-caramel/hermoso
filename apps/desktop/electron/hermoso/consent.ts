/**
 * Consent (main process, Electron-free): the person's yes, asked by Hermoso itself.
 *
 * Hermes has its own approval gate, and the agent's plugin used to lean on it. It cannot be the only guard for
 * things that change the person's whole computer: with approvals switched off, in "smart" mode (another model
 * decides) or under YOLO that gate says yes without a human. Hermoso therefore asks in its own voice, in the
 * app, and the agent has no way to answer for the person:
 *
 *   - a request is shown in the window (the app brings itself forward) and the call that asked waits for the answer;
 *   - if no window shows it within a moment (none open, the part of the UI that hosts it hidden), a native dialog
 *     asks instead, so a request can never sit unseen;
 *   - no answer in two minutes is a no;
 *   - "always allow this" is remembered for exactly the thing asked about (one country, one kind of risky command),
 *     listed on the Hermoso page and revocable there; everything else asks again.
 *
 * This module knows nothing about windows or dialogs: it holds the requests, the clock and the remembered yeses.
 */

import fs from 'node:fs'
import path from 'node:path'

export type ConsentAnswer = 'always' | 'deny' | 'once' | 'timeout'

export interface ConsentAsk {
  /** What "always allow" would remember (`teleport:de`); null when this kind of request can only be allowed once. */
  allowKey: null | string
  /** The thing the person would be allowing always, in words ("Germany"). */
  allowLabel: null | string
  /** What exactly is about to happen, shown as it is (a command, a path); null when the sentences say it all. */
  code?: null | string
  kind: string
  /** Plain sentences: what will happen, and why the agent says it needs it. */
  lines: string[]
  title: string
}

export interface ConsentPrompt extends ConsentAsk {
  askedAt: number
  id: string
}

export interface ConsentDecision {
  allowed: boolean
  answer: ConsentAnswer | 'remembered'
}

export interface Remembered {
  at: number
  label: string
}

export interface ConsentStore {
  read: () => Record<string, Remembered>
  write: (all: Record<string, Remembered>) => void
}

export interface ConsentDeps {
  /** How long a window gets to say it is showing the request before the native dialog is used. */
  ackMs?: number
  log?: (message: string) => void
  /** A native dialog: the answer, or null when it could not be shown. Raced against the window. */
  native?: (prompt: ConsentPrompt, signal: AbortSignal) => Promise<ConsentAnswer | null>
  now?: () => number
  /** Show the request in the windows (and bring the app forward). */
  present: (prompt: ConsentPrompt) => void
  /** Tell the windows a request is over (answered, timed out): they close it. */
  retire: (id: string) => void
  /** A timer that can be cancelled; the default is setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
  store: ConsentStore
  timeoutMs?: number
}

const DEFAULT_ACK_MS = 1_500
const DEFAULT_TIMEOUT_MS = 120_000

export function sanitizeRemembered(raw: unknown): Record<string, Remembered> {
  const source = (raw as { always?: unknown } | null)?.always
  const out: Record<string, Remembered> = {}

  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, any>)) {
      if (/^[a-z]+:[a-z0-9_-]{1,40}$/.test(key) && value && typeof value === 'object') {
        out[key] = {
          at: Number.isFinite(value.at) ? value.at : 0,
          label: typeof value.label === 'string' ? value.label.slice(0, 80) : key
        }
      }
    }
  }

  return out
}

/** The remembered yeses, in a file in the app's data folder. */
export function createFileConsentStore(file: string): ConsentStore {
  return {
    read() {
      try {
        return sanitizeRemembered(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {
        return {}
      }
    },

    write(all) {
      fs.mkdirSync(path.dirname(file), { recursive: true })

      const temp = `${file}.${process.pid}.tmp`

      fs.writeFileSync(temp, JSON.stringify({ always: all, version: 1 }, null, 2), 'utf8')
      fs.renameSync(temp, file)
    }
  }
}

export function createConsent(deps: ConsentDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const ackMs = deps.ackMs ?? DEFAULT_ACK_MS
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)

      handle.unref?.()

      return () => clearTimeout(handle)
    })

  interface Pending {
    abort: AbortController
    acked: boolean
    cancel: Array<() => void>
    prompt: ConsentPrompt
    resolve: (answer: ConsentAnswer) => void
  }

  const pending = new Map<string, Pending>()
  let counter = 0

  const finish = (id: string, answer: ConsentAnswer): boolean => {
    const entry = pending.get(id)

    if (!entry) {
      return false
    }

    pending.delete(id)
    entry.cancel.forEach(cancel => cancel())
    entry.abort.abort()
    deps.retire(id)
    entry.resolve(answer)

    return true
  }

  return {
    /** A window is showing the request: the native dialog is not needed. */
    ack(id: string): void {
      const entry = pending.get(id)

      if (entry) {
        entry.acked = true
      }
    },

    /** The person's answer, from a window. False for a request that is not open any more. */
    answer(id: string, answer: unknown): boolean {
      const value: ConsentAnswer = answer === 'once' || answer === 'always' ? answer : 'deny'

      return finish(id, value)
    },

    async ask(request: ConsentAsk): Promise<ConsentDecision> {
      if (request.allowKey && deps.store.read()[request.allowKey]) {
        return { allowed: true, answer: 'remembered' }
      }

      const prompt: ConsentPrompt = { ...request, askedAt: now(), id: `c${++counter}-${now().toString(36)}` }

      const answer = await new Promise<ConsentAnswer>(resolve => {
        const entry: Pending = { abort: new AbortController(), acked: false, cancel: [], prompt, resolve }

        pending.set(prompt.id, entry)
        entry.cancel.push(schedule(() => finish(prompt.id, 'timeout'), timeoutMs))

        // If no window says it is showing the request, ask with a native dialog (it races the window).
        if (deps.native) {
          entry.cancel.push(
            schedule(() => {
              if (entry.acked || !pending.has(prompt.id)) {
                return
              }

              void deps.native!(prompt, entry.abort.signal)
                .then(native => {
                  if (native) {
                    finish(prompt.id, native)
                  }
                })
                .catch(error =>
                  log(`[consent] native dialog failed: ${error instanceof Error ? error.message : String(error)}`)
                )
            }, ackMs)
          )
        }

        try {
          deps.present(prompt)
        } catch (error) {
          log(`[consent] could not present the request: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

      if (answer === 'always' && request.allowKey) {
        deps.store.write({
          ...deps.store.read(),
          [request.allowKey]: { at: now(), label: request.allowLabel ?? request.allowKey }
        })
        log(`[consent] always allowed: ${request.allowKey}`)
      }

      log(`[consent] ${request.kind} "${request.title}": ${answer}`)

      return { allowed: answer === 'once' || answer === 'always', answer }
    },

    /** The remembered yeses, for the page that lists them. */
    always: (): { key: string; label: string; at: number }[] =>
      Object.entries(deps.store.read()).map(([key, value]) => ({ at: value.at, key, label: value.label })),

    /** Requests waiting for an answer (a window that opens late asks for these). */
    pending: (): ConsentPrompt[] => [...pending.values()].map(entry => entry.prompt),

    /** Forget a remembered yes: the next such request asks again. */
    revoke(key: string): boolean {
      const all = deps.store.read()

      if (!all[key]) {
        return false
      }

      delete all[key]
      deps.store.write(all)

      return true
    }
  }
}

export type Consent = ReturnType<typeof createConsent>
