/**
 * VPN gate controller (main process, Electron-free).
 *
 * Owns the one policy the desktop needs from a VPN: *before Hermes starts
 * talking to anything, the Mullvad tunnel is up* — or the user has been told
 * exactly why not and given a way out. It is a small state machine over the
 * Mullvad client (mullvad.ts):
 *
 *   checking → connecting → ready
 *                       ↘ blocked (not-installed / not-logged-in / account-expired / daemon-unreachable /
 *                                  error-state / timeout / failed)
 *
 * Authority split (see AGENTS.md → "Decide state by authority"): main owns the
 * machine fact (is the tunnel up) and the persisted preference; the renderer
 * only paints the pushed state and asks for retries. Every caller shares one
 * in-flight attempt, so the eager main-process boot, the renderer's pre-boot
 * wait, and a Settings "Connect" never race two `mullvad connect` calls.
 *
 * The gate is a *startup* gate. A mid-session drop is published as state (the
 * renderer turns it into a non-blocking notice) and never tears the app down:
 * Mullvad reconnects on its own after a network blip, and a deliberate
 * disconnect is the user's call. The next backend spawn re-runs the gate.
 *
 * "Startup" is a one-way latch (`isStartupReleased`): closed at launch while the
 * VPN is required, released the first time the tunnel is up — or the moment the
 * user stops requiring it — and never closed again in this process. The egress
 * gate (egress-gate.ts) holds every outbound request of the app's own network
 * stack on that latch, so nothing leaves the machine outside the tunnel at launch.
 */

import { classifyCliFailure } from './mullvad'
import type { MullvadClient, MullvadFailure, MullvadLocation, MullvadTunnelState, RelayCountry } from './mullvad'

export interface VpnSettings {
  /** Hold backend startup until the tunnel is up. Off = connect in the background. */
  block: boolean
  /** Mullvad city code (`got`); only meaningful with a country. */
  city: null | string
  /** Mullvad country code (`se`); null keeps whatever the Mullvad app has selected. */
  country: null | string
  /** Master switch for the whole integration. */
  enabled: boolean
}

export const DEFAULT_VPN_SETTINGS: VpnSettings = { block: true, city: null, country: null, enabled: true }

const COUNTRY_CODE = /^[a-z]{2}$/
const CITY_CODE = /^[a-z0-9]{2,5}$/

/** Coerce anything read from disk or IPC into a valid settings object. */
export function sanitizeVpnSettings(raw: unknown): VpnSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const country = typeof source.country === 'string' ? source.country.trim().toLowerCase() : ''
  const city = typeof source.city === 'string' ? source.city.trim().toLowerCase() : ''
  const validCountry = COUNTRY_CODE.test(country)

  return {
    block: typeof source.block === 'boolean' ? source.block : DEFAULT_VPN_SETTINGS.block,
    city: validCountry && CITY_CODE.test(city) ? city : null,
    country: validCountry ? country : null,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_VPN_SETTINGS.enabled
  }
}

export type VpnGateStatus = 'blocked' | 'checking' | 'connecting' | 'off' | 'ready'

export type VpnBlockReason = 'account-expired' | 'error-state' | 'not-logged-in' | MullvadFailure

export interface VpnState {
  /** Whether a Mullvad CLI was found on this machine. */
  cliFound: boolean
  gate: VpnGateStatus
  location: MullvadLocation | null
  /** Short CLI-provided detail for a blocked gate. Never contains an account number. */
  message: null | string
  reason: null | VpnBlockReason
  relay: null | string
  settings: VpnSettings
  tunnel: MullvadTunnelState
  updatedAt: number
  /**
   * The user chose to start without the VPN for THIS launch. Session-only by design: it is
   * never written to disk, so one stray click cannot switch the requirement off for good
   * (that is a deliberate toggle in Settings → VPN).
   */
  waived: boolean
}

/** Thrown by assertReady() so a backend spawn refuses to run without the tunnel. */
export class VpnGateError extends Error {
  readonly reason: VpnBlockReason
  readonly vpnGate = true

  constructor(reason: VpnBlockReason, message?: null | string) {
    super(`Mullvad VPN is required but is not connected (${reason}${message ? `: ${message}` : ''}).`)
    this.name = 'VpnGateError'
    this.reason = reason
  }
}

export function isVpnGateError(error: unknown): error is VpnGateError {
  return Boolean(error && typeof error === 'object' && (error as { vpnGate?: unknown }).vpnGate === true)
}

type VpnClient = Pick<
  MullvadClient,
  'account' | 'connect' | 'disconnect' | 'findApp' | 'findCli' | 'listRelays' | 'setLocation' | 'status'
>

export interface VpnControllerDeps {
  /**
   * Awaited before the gate reads or changes anything. Hermoso uses it to bring a trip left open by a
   * crash (a Mullvad exit still in another country) home before the gate connects there.
   */
  beforeGate?: () => Promise<void>
  client: VpnClient
  /** How long a connect may take before the gate gives up. */
  connectTimeoutMs?: number
  log?: (message: string) => void
  monitorIntervalMs?: number
  now?: () => number
  /** Called with every state change (main broadcasts it to the renderers). */
  onState?: (state: VpnState) => void
  pollIntervalMs?: number
  readSettings: () => VpnSettings
  sleep?: (ms: number) => Promise<void>
  writeSettings: (settings: VpnSettings) => void
}

// A daemon mid-handshake can report `Blocked` for a beat before it settles; only a
// persistent block is an error worth surfacing.
const BLOCKED_STREAK_LIMIT = 4
// A daemon that stays `Disconnected` after `connect` was swallowed (or raced a
// stale disconnect); ask again, but only a couple of times.
const DISCONNECTED_STREAK_LIMIT = 6
const MAX_REISSUES = 2
// The Mullvad service may still be starting when Hermes is opened right after login;
// give it a few seconds before calling it unreachable.
const DAEMON_RETRIES = 10
const DAEMON_RETRY_MS = 1_000
const MESSAGE_MAX = 200

function shortMessage(text: null | string | undefined): null | string {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .find(line => line.trim() !== '')
    ?.trim()

  return first ? first.slice(0, MESSAGE_MAX) : null
}

export function createVpnController(deps: VpnControllerDeps) {
  const { client } = deps
  const connectTimeoutMs = deps.connectTimeoutMs ?? 30_000
  const pollIntervalMs = deps.pollIntervalMs ?? 500
  const monitorIntervalMs = deps.monitorIntervalMs ?? 8_000
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const initialSettings = deps.readSettings()

  let state: VpnState = {
    cliFound: Boolean(client.findCli()),
    // Painted from the first frame: an enabled+blocking gate starts "checking"
    // so the app never flashes the shell before the tunnel is known.
    gate: initialSettings.enabled ? 'checking' : 'off',
    location: null,
    message: null,
    reason: null,
    relay: null,
    settings: initialSettings,
    tunnel: 'unknown',
    updatedAt: now(),
    waived: false
  }

  let inflight: null | Promise<VpnState> = null
  let monitor: null | ReturnType<typeof setInterval> = null
  let relayCache: null | RelayCountry[] = null
  let disposed = false
  // Planned tunnel transitions in progress (a Teleport reconnect): while any is, a tunnel that is not
  // up is the plan, not a dropped VPN, so it is not published.
  let transitionHolds = 0

  // One-way latch: open from the start when the VPN is not required, otherwise closed
  // until the tunnel is first up or the requirement is waived. See the module doc.
  let startupReleased = !(initialSettings.enabled && initialSettings.block)
  const releaseWaiters: (() => void)[] = []

  const releaseStartup = (why: string) => {
    if (startupReleased) {
      return
    }

    startupReleased = true
    log(`[vpn] startup gate released (${why})`)

    for (const resolve of releaseWaiters.splice(0)) {
      resolve()
    }
  }

  const evaluateRelease = () => {
    if (startupReleased) {
      return
    }

    if (state.waived) {
      releaseStartup('waived for this launch')
    } else if (!state.settings.enabled || !state.settings.block) {
      releaseStartup('no longer required')
    } else if (state.gate === 'ready') {
      releaseStartup('tunnel up')
    }
  }

  const publish = (patch: Partial<VpnState>): VpnState => {
    const next = { ...state, ...patch }

    const changed = (Object.keys(next) as (keyof VpnState)[]).some(
      key => key !== 'updatedAt' && JSON.stringify(next[key]) !== JSON.stringify(state[key])
    )

    if (!changed) {
      return state
    }

    state = { ...next, updatedAt: now() }
    evaluateRelease()
    deps.onState?.(state)

    return state
  }

  const fail = (reason: VpnBlockReason, message?: null | string): VpnState => {
    const detail = shortMessage(message)
    log(`[vpn] gate blocked: ${reason}${detail ? ` (${detail})` : ''}`)

    return publish({
      cliFound: reason !== 'not-installed',
      gate: 'blocked',
      message: detail,
      reason
    })
  }

  const ready = (status: { location: MullvadLocation | null; relay: null | string }): VpnState => {
    log(`[vpn] tunnel up${status.location?.country ? ` (${status.location.country})` : ''}`)

    return publish({
      cliFound: true,
      gate: 'ready',
      location: status.location,
      message: null,
      reason: null,
      relay: status.relay,
      tunnel: 'connected'
    })
  }

  const applyLocation = async (settings: VpnSettings): Promise<void> => {
    if (!settings.country) {
      return
    }

    const result = await client.setLocation(settings.country, settings.city)

    // Not fatal: a stale country code must not lock the user out of the tunnel.
    // Mullvad keeps its previous selection and we connect there.
    if (result.code !== 0) {
      log(
        `[vpn] could not select ${settings.country}${settings.city ? `/${settings.city}` : ''}; keeping Mullvad's current location`
      )
    }
  }

  async function runGate(): Promise<VpnState> {
    // Never lets the gate fail: whatever has to happen first must not be able to keep the tunnel down.
    await deps.beforeGate?.().catch(error => log(`[vpn] pre-gate step failed: ${String(error?.message ?? error)}`))

    const settings = deps.readSettings()

    if (!settings.enabled) {
      return publish({ gate: 'off', message: null, reason: null, settings })
    }

    publish({ gate: 'checking', message: null, reason: null, settings })

    let initial = await client.status()

    for (
      let attempt = 0;
      !initial.status && initial.failure === 'daemon-unreachable' && attempt < DAEMON_RETRIES;
      attempt++
    ) {
      await sleep(DAEMON_RETRY_MS)

      if (disposed) {
        return state
      }

      initial = await client.status()
    }

    if (!initial.status) {
      return fail(initial.failure ?? 'failed')
    }

    publish({ cliFound: true, tunnel: initial.status.state })

    if (initial.status.state === 'connected') {
      return ready(initial.status)
    }

    if (initial.status.state !== 'connecting') {
      const account = await client.account()

      if (account.loggedIn === false) {
        return fail('not-logged-in')
      }

      // An account with no time left cannot connect: say so instead of a generic tunnel error.
      if (account.expiresAt && account.expiresAt.getTime() <= now()) {
        return fail('account-expired')
      }

      await applyLocation(settings)

      publish({ gate: 'connecting' })
      const started = await client.connect()

      // A CLI that blocks until the tunnel is up (older releases) and outlives our
      // command timeout has still handed the daemon the request: keep polling.
      if (started.code !== 0 && started.error !== 'timeout') {
        return fail(classifyCliFailure(started), started.stderr || started.stdout)
      }
    } else {
      publish({ gate: 'connecting' })
    }

    const deadline = now() + connectTimeoutMs
    let blockedStreak = 0
    let disconnectedStreak = 0
    let reissues = 0

    while (now() < deadline) {
      await sleep(pollIntervalMs)

      if (disposed) {
        return state
      }

      const polled = await client.status()

      if (!polled.status) {
        return fail(polled.failure ?? 'failed')
      }

      const { status } = polled
      publish({ tunnel: status.state })

      if (status.state === 'connected') {
        return ready(status)
      }

      blockedStreak = status.state === 'blocked' ? blockedStreak + 1 : 0
      disconnectedStreak = status.state === 'disconnected' ? disconnectedStreak + 1 : 0

      if (blockedStreak >= BLOCKED_STREAK_LIMIT) {
        return fail('error-state', status.detail)
      }

      if (disconnectedStreak >= DISCONNECTED_STREAK_LIMIT && reissues < MAX_REISSUES) {
        reissues += 1
        disconnectedStreak = 0
        log('[vpn] tunnel stayed disconnected after connect; asking again')

        const again = await client.connect()

        if (again.code !== 0 && again.error !== 'timeout') {
          return fail(classifyCliFailure(again), again.stderr || again.stdout)
        }
      }
    }

    return fail('timeout')
  }

  /**
   * Bring the tunnel up per the saved settings. Never rejects: the outcome is
   * the returned state (`ready`, `off`, or `blocked` with a reason). Concurrent
   * callers share one attempt.
   */
  function ensure(): Promise<VpnState> {
    if (!inflight) {
      inflight = runGate()
        .catch(error => fail('failed', error instanceof Error ? error.message : String(error)))
        .finally(() => {
          inflight = null
        })
    }

    return inflight
  }

  /** For backend spawns: refuse to proceed while the gate requires a tunnel that is not up. */
  async function assertReady(): Promise<void> {
    const settings = deps.readSettings()

    if (!settings.enabled || !settings.block || state.waived) {
      return
    }

    const outcome = await ensure()

    if (outcome.gate !== 'ready') {
      throw new VpnGateError(outcome.reason ?? 'failed', outcome.message)
    }
  }

  async function refresh(): Promise<VpnState> {
    const polled = await client.status()

    // A planned reconnect (Teleport) is not a drop: keep showing the tunnel as it was until it is up again.
    if (transitionHolds > 0 && polled.status?.state !== 'connected') {
      return state
    }

    if (!polled.status) {
      return publish({ cliFound: polled.failure !== 'not-installed', tunnel: 'unknown' })
    }

    // The user did what a blocked gate asked (signed in, connected from the Mullvad
    // app itself): let the boot through without making them press "Try again".
    if (polled.status.state === 'connected' && state.gate === 'blocked' && deps.readSettings().enabled) {
      return ready(polled.status)
    }

    return publish({
      cliFound: true,
      location: polled.status.state === 'connected' ? polled.status.location : null,
      relay: polled.status.state === 'connected' ? polled.status.relay : null,
      tunnel: polled.status.state
    })
  }

  async function setSettings(patch: Partial<VpnSettings>): Promise<VpnState> {
    const previous = deps.readSettings()
    const next = sanitizeVpnSettings({ ...previous, ...patch })

    deps.writeSettings(next)
    publish({ settings: next })

    if (!next.enabled) {
      return publish({ gate: 'off', message: null, reason: null })
    }

    // Turning the integration on (or back on) connects now — the user just asked for it.
    if (!previous.enabled) {
      void ensure()

      return state
    }

    const locationChanged = next.country !== previous.country || next.city !== previous.city

    // Move a tunnel that is (or may be) up right now. Only a tunnel KNOWN to be down waits: its
    // next connect applies the saved location first. `unknown` must not wait — a status read that
    // lands inside the daemon's reconnect window is momentarily unreadable, and skipping the move
    // then silently drops the user's choice.
    if (locationChanged && state.tunnel !== 'disconnected') {
      await applyLocation(next)

      return refresh()
    }

    return state
  }

  async function disconnect(): Promise<VpnState> {
    const result = await client.disconnect()

    if (result.code !== 0) {
      log(`[vpn] disconnect failed: ${classifyCliFailure(result)}`)
    }

    return refresh()
  }

  async function listRelays(): Promise<RelayCountry[]> {
    if (relayCache) {
      return relayCache
    }

    const relays = await client.listRelays()

    // An empty answer is a failed read (CLI missing, daemon down), not a fact worth caching.
    if (relays.length > 0) {
      relayCache = relays
    }

    return relays
  }

  /**
   * "Continue without VPN" for this launch only. Opens the startup gate (backend and held
   * requests proceed) without touching the saved preference; the next launch gates again.
   */
  function waiveStartup(): VpnState {
    if (!state.waived) {
      log('[vpn] startup gate waived by the user for this launch')
    }

    return publish({ waived: true })
  }

  /**
   * Announce a tunnel change that is on purpose (Teleport moves the exit country, which reconnects).
   * Returns the function that ends the announcement; until then a tunnel that is momentarily not up
   * is not published as a drop. Holds nest.
   */
  function holdTransition(): () => void {
    let released = false

    transitionHolds += 1

    return () => {
      if (!released) {
        released = true
        transitionHolds = Math.max(0, transitionHolds - 1)
      }
    }
  }

  function startMonitor(): void {
    if (monitor) {
      return
    }

    monitor = setInterval(() => {
      if (inflight || disposed || !deps.readSettings().enabled) {
        return
      }

      void refresh().catch(() => {})
    }, monitorIntervalMs)

    monitor.unref?.()
  }

  function dispose(): void {
    disposed = true

    if (monitor) {
      clearInterval(monitor)
      monitor = null
    }
  }

  return {
    assertReady,
    disconnect,
    dispose,
    ensure,
    findApp: () => client.findApp(),
    getState: (): VpnState => state,
    holdTransition,
    isStartupReleased: (): boolean => startupReleased,
    listRelays,
    refresh,
    setSettings,
    startMonitor,
    waiveStartup,
    whenStartupReleased: (): Promise<void> =>
      startupReleased ? Promise.resolve() : new Promise<void>(resolve => releaseWaiters.push(resolve))
  }
}

export type VpnController = ReturnType<typeof createVpnController>
