/**
 * The shield's ledger (main process, Electron-free): what the radar saw over time, and the report that says it.
 *
 * Every look at the app's connections is added here. The ledger counts each distinct connection once (by who
 * opened it and to where), remembers every one that left OUTSIDE the tunnel, and adds up how long the agent
 * stood frozen. From that it writes the proof report: "N connections observed in M looks, none outside the
 * tunnel", or the list of those that were. It states its own limits, because a sampling proof that hides them
 * is not a proof.
 */

import type { RadarSample, Route } from './radar'
import type { ShieldState } from './shield'

export interface OutsideEvent {
  at: number
  pid: number
  port: number
  process: string
  remote: string
}

export interface LedgerSummary {
  byRoute: Record<Route, number>
  /** Seconds the agent stood frozen (the VPN required, the tunnel not up), over the looks that saw it. */
  frozenSeconds: number
  lastAt: null | number
  /** Looks that could not read the connections (netstat failed). */
  missed: number
  outside: OutsideEvent[]
  /** Distinct connections seen. */
  seen: number
  samples: number
  startedAt: number
}

export interface ReportContext {
  appVersion?: string
  /** Where the tunnel exits, in words (no address). */
  exit: null | string
  /** Whether Mullvad's "Always require VPN" is on (null: unknown). */
  lockdown: boolean | null
  now?: number
  vpnRequired: boolean
}

const MAX_OUTSIDE = 100
// A freeze counts only between two looks this close: a gap (the app asleep) is not time the agent stood frozen.
const MAX_GAP_MS = 30_000

const empty = (): Record<Route, number> => ({ lan: 0, loopback: 0, outside: 0, tunnel: 0 })

export function createLedger(now: () => number = Date.now) {
  let startedAt = now()
  let samples = 0
  let missed = 0
  let frozenMs = 0
  let lastAt: null | number = null
  let lastFrozen = false
  let byRoute = empty()
  let outside: OutsideEvent[] = []
  let seen = new Set<string>()

  return {
    /** Add one look. `shield` is the verdict at that moment. */
    record(sample: RadarSample, shield: Pick<ShieldState, 'frozen'>): void {
      if (lastAt !== null && lastFrozen && sample.at - lastAt <= MAX_GAP_MS) {
        frozenMs += sample.at - lastAt
      }

      lastAt = sample.at
      lastFrozen = shield.frozen

      if (sample.error) {
        missed += 1

        return
      }

      samples += 1

      for (const connection of sample.connections) {
        const key = `${connection.pid}|${connection.localAddress}:${connection.localPort}|${connection.remoteAddress}:${connection.remotePort}`

        if (seen.has(key)) {
          continue
        }

        seen.add(key)
        byRoute[connection.route] += 1

        if (connection.route === 'outside' && outside.length < MAX_OUTSIDE) {
          outside.push({
            at: sample.at,
            pid: connection.pid,
            port: connection.remotePort,
            process: connection.process,
            remote: connection.remoteAddress
          })
        }
      }
    },

    reset(): void {
      startedAt = now()
      samples = 0
      missed = 0
      frozenMs = 0
      lastAt = null
      lastFrozen = false
      byRoute = empty()
      outside = []
      seen = new Set()
    },

    summary(): LedgerSummary {
      return {
        byRoute: { ...byRoute },
        frozenSeconds: Math.round(frozenMs / 1000),
        lastAt,
        missed,
        outside: [...outside],
        samples,
        seen: seen.size,
        startedAt
      }
    },

    /** The report, in Markdown, ready to save or share. */
    report(context: ReportContext): string {
      const summary = this.summary()

      const stamp = (ms: number) =>
        new Date(ms)
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, ' UTC')

      const total = summary.seen
      const clean = summary.byRoute.outside === 0

      const lines = [
        '# Hermoso shield report',
        '',
        `Watched from ${stamp(summary.startedAt)} to ${stamp(context.now ?? summary.lastAt ?? now())}` +
          ` (${summary.samples} looks${summary.missed ? `, ${summary.missed} could not be read` : ''}).`,
        '',
        '## Result',
        '',
        total === 0
          ? 'No connections were observed yet.'
          : clean
            ? `**${total} connection${total === 1 ? '' : 's'} observed. None left outside the VPN tunnel.**`
            : `**${total} connections observed. ${summary.byRoute.outside} left OUTSIDE the VPN tunnel.**`,
        '',
        `- through the tunnel: ${summary.byRoute.tunnel}`,
        `- to this computer (loopback): ${summary.byRoute.loopback}`,
        `- to the local network (Mullvad may allow this outside the tunnel): ${summary.byRoute.lan}`,
        `- outside the tunnel: ${summary.byRoute.outside}`
      ]

      if (summary.outside.length > 0) {
        lines.push('', '### Connections outside the tunnel', '')

        for (const event of summary.outside) {
          lines.push(`- ${stamp(event.at)}: ${event.process} (pid ${event.pid}) -> ${event.remote}:${event.port}`)
        }
      }

      lines.push(
        '',
        '## Conditions',
        '',
        `- VPN required by the settings: ${context.vpnRequired ? 'yes' : 'no'}`,
        `- Tunnel exit: ${context.exit ?? 'not connected'}`,
        `- Mullvad "Always require VPN" (blocks everything if the tunnel drops): ${context.lockdown === null ? 'unknown' : context.lockdown ? 'ON' : 'off'}`,
        `- Time the agent stood frozen because the tunnel was down: ${summary.frozenSeconds} s`
      )

      lines.push(
        '',
        '## What this does and does not prove',
        '',
        '- It watches the TCP connections of Hermoso and everything it started (the Hermes backend, the commands it ran), every few seconds, and checks which network interface each one uses. A connection that opens and closes between two looks is not seen. UDP and DNS are not listed.',
        '- It proves "these connections went where it says", not "no packet ever left". The only guarantee against leaks while the tunnel is down is Mullvad’s "Always require VPN", which this report shows above.',
        context.appVersion ? `- Hermoso ${context.appVersion}` : ''
      )

      return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')}\n`
    }
  }
}

export type Ledger = ReturnType<typeof createLedger>
