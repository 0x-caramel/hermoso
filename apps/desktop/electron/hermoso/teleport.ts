/**
 * Teleport (main process, Electron-free): the Mullvad tunnel's exit country, changed for a while and then
 * put back. The user (a chip in the status bar) and the agent (the `hermoso_teleport` tool, through the
 * bridge) ask for the same thing and get the same guarantees:
 *
 *   - **Home is written down before anything moves.** The exact `Location:` Mullvad had (country, city or
 *     one relay) and whether the tunnel was up are persisted first; every way out of a trip (the timer,
 *     "Return home", quitting, a crash found at the next launch) restores exactly that.
 *   - **A trip ends by itself.** Ten minutes unless asked for another length, never more than an hour.
 *   - **A trip that cannot start leaves nothing behind.** If the new exit does not come up, home is put back
 *     before the failure is reported.
 *   - **Mullvad is system-wide**: the whole computer exits from the new country, not just Hermoso. That is
 *     why the agent's request goes through the human approval gate (see the plugin) and why the UI always
 *     shows the trip and its end.
 *
 * Every operation runs one at a time (a jump, a return and the timer never interleave), and the tunnel
 * transitions they cause are announced to the VPN controller (`hold`) so a planned reconnect is not
 * shown as a dropped VPN. This file knows nothing about Electron, HTTP or the agent: it drives the
 * Mullvad client and answers with state.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  type MullvadClient,
  type MullvadStatusDetails,
  type RelayCity,
  type RelayCountry,
  relayHostCountry,
  type RelayLocation,
  sameRelayLocation
} from '../mullvad'

// A byte-order mark at the start of a file written by another program (PowerShell 5 adds one).
const BOM_AT_START = new RegExp('^' + String.fromCharCode(0xfeff))

export type TeleportClient = Pick<
  MullvadClient,
  'connect' | 'disconnect' | 'listRelays' | 'relayGet' | 'setRelayLocation' | 'statusDetails'
>

export type TeleportPhase = 'away' | 'idle' | 'jumping' | 'returning'

/** Who started a trip. */
export type TeleportActor = 'agent' | 'user'

/** Who ended one: a person (or the agent), the timer, quitting the app, or the recovery after a crash. */
export type TeleportCause = 'quit' | 'recovery' | 'timer' | TeleportActor

export type TeleportErrorCode =
  | 'already-there'
  | 'busy'
  | 'failed'
  | 'home-not-restorable'
  | 'return-incomplete'
  | 'timeout'
  | 'unknown-destination'
  | 'vpn-unavailable'

export interface TeleportHome {
  /** The `Location:` text Mullvad printed, to say "back to country no". */
  label: string
  location: RelayLocation
  /** Whether the tunnel was up when the first trip started (and so should be when it ends). */
  wasConnected: boolean
}

export interface TeleportTrip {
  by: TeleportActor
  city: null | string
  /** Two-letter code, as `mullvad relay list` prints it. */
  country: string
  countryName: null | string
  reason: null | string
  /** When the first jump of this trip started (a hop to another country keeps it). */
  since: number
  /** When the trip ends by itself (epoch ms). */
  until: number
}

export interface TeleportState {
  error: null | { at: number; code: TeleportErrorCode; message: string }
  home: null | TeleportHome
  phase: TeleportPhase
  trip: null | TeleportTrip
  updatedAt: number
}

export type TeleportResult =
  { ok: true; state: TeleportState } | { code: TeleportErrorCode; message: string; ok: false; state: TeleportState }

export interface TeleportRequest {
  by: TeleportActor
  city?: null | string
  country: string
  minutes?: number
  reason?: null | string
}

export type TeleportEvent =
  | { by: TeleportActor; city: null | string; country: string; minutes: number; type: 'jumped' }
  | { code: TeleportErrorCode; type: 'failed' }
  | { by: TeleportCause; type: 'returned' }

/** The persisted trip: everything needed to bring the machine home after a crash. */
export interface TeleportRecord {
  home: TeleportHome
  trip: TeleportTrip
  version: 1
}

export interface TeleportStore {
  clear: () => void
  read: () => null | TeleportRecord
  write: (record: TeleportRecord) => void
}

export interface TeleportDeps {
  client: TeleportClient
  /**
   * Called around every operation that moves the tunnel; the returned function ends the hold. The VPN
   * controller uses it to not report the planned reconnect as a dropped VPN.
   */
  hold?: () => () => void
  log?: (message: string) => void
  now?: () => number
  /** The tunnel changed (a trip began or ended): refresh whatever shows it. */
  onChanged?: () => void
  onEvent?: (event: TeleportEvent) => void
  onState?: (state: TeleportState) => void
  /** A timer that can be cancelled; the default is setTimeout (unref'd). */
  schedule?: (fn: () => void, ms: number) => () => void
  sleep?: (ms: number) => Promise<void>
  store: TeleportStore
}

export const DEFAULT_TRIP_MINUTES = 10
export const MAX_TRIP_MINUTES = 60
export const MIN_TRIP_MINUTES = 1

const SETTLE_TIMEOUT_MS = 30_000
const POLL_MS = 500
const BLOCKED_STREAK_LIMIT = 4
const RETRY_HOME_MS = 15_000
const REASON_MAX = 200

export const clampTripMinutes = (minutes: unknown): number => {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes) : DEFAULT_TRIP_MINUTES

  return Math.min(MAX_TRIP_MINUTES, Math.max(MIN_TRIP_MINUTES, value))
}

const cleanReason = (reason: unknown): null | string => {
  const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : ''

  return text ? text.slice(0, REASON_MAX) : null
}

// What people (and models) call a country that Mullvad's list names differently.
const COUNTRY_ALIASES: Record<string, string> = {
  america: 'us',
  'great britain': 'gb',
  holland: 'nl',
  'south korea': 'kr',
  uk: 'gb',
  'united kingdom': 'gb',
  'united states': 'us',
  'united states of america': 'us',
  usa: 'us'
}

const plain = (text: unknown): string =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * A country (and optionally a city) out of what someone typed or an agent wrote: a code ("de"), a name
 * ("Germany", "germany", "UK") and a city by code ("fra") or by name ("Frankfurt"). Only places Mullvad
 * actually lists are ever returned; anything else is a message that says so.
 */
export function resolveDestination(
  relays: RelayCountry[],
  countryInput: unknown,
  cityInput?: unknown
): { city: null | RelayCity; country: RelayCountry } | { message: string } {
  const wanted = plain(countryInput)

  if (!wanted) {
    return { message: 'No country given. Use a Mullvad country (a name like "Germany" or a code like "de").' }
  }

  const code = COUNTRY_ALIASES[wanted] ?? wanted

  const country =
    relays.find(candidate => candidate.code === code) ?? relays.find(candidate => plain(candidate.name) === wanted)

  if (!country) {
    return {
      message: `Mullvad has no servers in "${String(countryInput).trim()}". Ask for the list of exits to see where it can go.`
    }
  }

  const cityWanted = plain(cityInput)

  if (!cityWanted) {
    return { city: null, country }
  }

  const city = country.cities.find(candidate => candidate.code === cityWanted || plain(candidate.name) === cityWanted)

  return city
    ? { city, country }
    : {
        message: `Mullvad has no "${String(cityInput).trim()}" server in ${country.name}. Leave the city out to let Mullvad choose.`
      }
}

/** Does this exit relay match the place we asked for? */
function reachedLocation(details: MullvadStatusDetails, location: RelayLocation): boolean {
  if (details.state !== 'connected') {
    return false
  }

  if (location.kind === 'any') {
    return true
  }

  const host = details.hostname

  if (relayHostCountry(host) !== location.country) {
    return false
  }

  if (location.kind === 'country') {
    return true
  }

  if (location.kind === 'city') {
    return host?.split('-')[1] === location.city
  }

  return host === location.hostname
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────────

const isLocation = (value: any): value is RelayLocation =>
  Boolean(value) &&
  (value.kind === 'any' ||
    (value.kind === 'country' && typeof value.country === 'string') ||
    (value.kind === 'city' && typeof value.country === 'string' && typeof value.city === 'string') ||
    (value.kind === 'hostname' &&
      typeof value.country === 'string' &&
      typeof value.city === 'string' &&
      typeof value.hostname === 'string'))

/** Anything read from disk is checked field by field: a damaged file is "no trip", never a crash. */
export function sanitizeTeleportRecord(raw: unknown): null | TeleportRecord {
  const source = raw as any

  if (!source || source.version !== 1 || !isLocation(source.home?.location) || !source.trip) {
    return null
  }

  const { home, trip } = source

  if (typeof home.wasConnected !== 'boolean' || typeof trip.country !== 'string' || !Number.isFinite(trip.until)) {
    return null
  }

  return {
    home: {
      label: typeof home.label === 'string' ? home.label.slice(0, 80) : '',
      location: home.location,
      wasConnected: home.wasConnected
    },
    trip: {
      by: trip.by === 'agent' ? 'agent' : 'user',
      city: typeof trip.city === 'string' ? trip.city : null,
      country: trip.country.toLowerCase(),
      countryName: typeof trip.countryName === 'string' ? trip.countryName : null,
      reason: cleanReason(trip.reason),
      since: Number.isFinite(trip.since) ? trip.since : trip.until,
      until: trip.until
    },
    version: 1
  }
}

/** The trip file in the app's data folder; written through a temp file so a crash never leaves half a record. */
export function createFileTeleportStore(file: string): TeleportStore {
  return {
    clear() {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        // nothing to clear
      }
    },

    read() {
      try {
        return sanitizeTeleportRecord(JSON.parse(fs.readFileSync(file, 'utf8').replace(BOM_AT_START, '')))
      } catch {
        return null
      }
    },

    write(record) {
      fs.mkdirSync(path.dirname(file), { recursive: true })

      const temp = `${file}.${process.pid}.tmp`

      fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8')
      fs.renameSync(temp, file)
    }
  }
}

// ── the controller ──────────────────────────────────────────────────────────────────────────────

export function createTeleport(deps: TeleportDeps) {
  const { client, store } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)

      handle.unref?.()

      return () => clearTimeout(handle)
    })

  let state: TeleportState = { error: null, home: null, phase: 'idle', trip: null, updatedAt: now() }
  let record: null | TeleportRecord = null
  let cancelTimer: (() => void) | null = null
  let relayCache: null | RelayCountry[] = null
  let recovering: null | Promise<void> = null
  let disposed = false
  let chain: Promise<unknown> = Promise.resolve()

  const publish = (patch: Partial<TeleportState>): TeleportState => {
    const next = { ...state, ...patch }

    const changed = (Object.keys(next) as (keyof TeleportState)[]).some(
      key => key !== 'updatedAt' && JSON.stringify(next[key]) !== JSON.stringify(state[key])
    )

    if (!changed) {
      return state
    }

    state = { ...next, updatedAt: now() }
    deps.onState?.(state)

    return state
  }

  /** One operation at a time: a jump, a return and the timer never interleave. */
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)

    chain = run.then(
      () => undefined,
      () => undefined
    )

    return run
  }

  const clearTimer = () => {
    cancelTimer?.()
    cancelTimer = null
  }

  const armTimer = (ms: number) => {
    clearTimer()

    if (disposed) {
      return
    }

    cancelTimer = schedule(
      () => {
        cancelTimer = null
        void home('timer')
      },
      Math.max(0, ms)
    )
  }

  const failure = (code: TeleportErrorCode, message: string): TeleportResult => {
    log(`[teleport] ${code}: ${message}`)

    // A tunnel that misbehaved stays in the state (the chip shows it); a bad request is only the caller's answer.
    if (code === 'failed' || code === 'return-incomplete' || code === 'timeout') {
      publish({ error: { at: now(), code, message } })
    }

    deps.onEvent?.({ code, type: 'failed' })

    return { code, message, ok: false, state }
  }

  const withHold = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = deps.hold?.()

    try {
      return await fn()
    } finally {
      release?.()
      deps.onChanged?.()
    }
  }

  /** Poll the tunnel until `done` says so; false on timeout or a tunnel that stays blocked. */
  const settle = async (done: (details: MullvadStatusDetails) => boolean): Promise<boolean> => {
    const deadline = now() + SETTLE_TIMEOUT_MS
    let blocked = 0

    while (now() < deadline && !disposed) {
      const read = await client.statusDetails()

      if (read.details) {
        if (done(read.details)) {
          return true
        }

        blocked = read.details.state === 'blocked' ? blocked + 1 : 0

        if (blocked >= BLOCKED_STREAK_LIMIT) {
          return false
        }
      }

      await sleep(POLL_MS)
    }

    return false
  }

  const destinations = async (): Promise<RelayCountry[]> => {
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

  /** The tunnel put back the way the record says: location first, then up or down as it was. */
  const restoreHome = async (rec: TeleportRecord): Promise<{ complete: boolean; restored: boolean }> => {
    const set = await client.setRelayLocation(rec.home.location)

    if (set.code !== 0) {
      return { complete: false, restored: false }
    }

    if (rec.home.wasConnected) {
      const read = await client.statusDetails()

      // Changing the relay of a live tunnel reconnects it by itself; only a tunnel that is down is asked.
      if (read.details && read.details.state !== 'connected' && read.details.state !== 'connecting') {
        await client.connect()
      }

      const complete = await settle(details => reachedLocation(details, rec.home.location))

      return { complete, restored: true }
    }

    await client.disconnect()

    const complete = await settle(details => details.state === 'disconnected')

    return { complete, restored: true }
  }

  const clearRecord = () => {
    store.clear()
    record = null
    clearTimer()
  }

  // ── jump ──

  async function doJump(request: TeleportRequest): Promise<TeleportResult> {
    const relays = await destinations()

    if (relays.length === 0) {
      return failure('vpn-unavailable', 'Mullvad did not answer: is it installed, logged in and running?')
    }

    const resolved = resolveDestination(relays, request.country, request.city)

    if ('message' in resolved) {
      return failure('unknown-destination', resolved.message)
    }

    const { city: resolvedCity, country } = resolved

    const location: RelayLocation = resolvedCity
      ? { city: resolvedCity.code, country: country.code, kind: 'city' }
      : { country: country.code, kind: 'country' }

    const minutes = clampTripMinutes(request.minutes)
    const hopping = record !== null
    let home = record?.home ?? null

    // The first hop of a trip: find out where home is, and refuse to leave a place we could not come back to.
    if (!home) {
      const status = await client.statusDetails()

      if (!status.details || status.details.state === 'blocked' || status.details.state === 'unknown') {
        return failure('vpn-unavailable', 'Mullvad is not in a usable state (blocked or not answering)')
      }

      const wasConnected = status.details.state === 'connected'

      if (!wasConnected && status.details.state !== 'disconnected') {
        // connecting / disconnecting: let it settle before taking a picture of it
        const settled = await settle(details => details.state === 'connected' || details.state === 'disconnected')

        if (!settled) {
          return failure('busy', 'The tunnel is changing state; try again in a moment')
        }
      }

      const after = await client.statusDetails()
      const relay = await client.relayGet()

      if (!relay.constraints || !after.details) {
        return failure('vpn-unavailable', 'Could not read the current Mullvad location')
      }

      if (!relay.constraints.location) {
        return failure(
          'home-not-restorable',
          `Mullvad is set to "${relay.constraints.locationText}", which cannot be put back automatically: pick a country in Mullvad first`
        )
      }

      if (sameRelayLocation(relay.constraints.location, location)) {
        return failure('already-there', `The tunnel already exits from ${country.name}`)
      }

      home = {
        label: relay.constraints.locationText,
        location: relay.constraints.location,
        wasConnected: after.details.state === 'connected'
      }
    }

    const trip: TeleportTrip = {
      by: request.by,
      city: location.kind === 'city' ? location.city : null,
      country: location.country,
      countryName: country.name,
      reason: cleanReason(request.reason),
      since: record?.trip.since ?? now(),
      until: now() + minutes * 60_000
    }

    // Written BEFORE anything moves: from here on, every way out knows where home is.
    const previous = record

    record = { home, trip, version: 1 }
    store.write(record)
    clearTimer()
    publish({ error: null, home, phase: 'jumping', trip })
    log(
      `[teleport] ${hopping ? 'hop' : 'jump'} to ${country.name}${trip.city ? `/${trip.city}` : ''} for ${minutes} min (${request.by})`
    )

    const set = await client.setRelayLocation(location)

    if (set.code !== 0) {
      // Nothing moved: only the bookkeeping is undone, and a trip that was already running carries on.
      if (previous) {
        record = previous
        store.write(previous)
        publish({ home: previous.home, phase: 'away', trip: previous.trip })
        armTimer(previous.trip.until - now())
      } else {
        clearRecord()
        publish({ home: null, phase: 'idle', trip: null })
      }

      return failure('failed', `Mullvad refused the new location (${(set.stderr || set.stdout).trim().split('\n')[0]})`)
    }

    const current = await client.statusDetails()

    if (!current.details || current.details.state === 'disconnected') {
      await client.connect()
    }

    const reached = await settle(details => reachedLocation(details, location))

    if (!reached) {
      const outcome = await giveUp(record, hopping)

      return failure('timeout', `The tunnel did not come up in ${country.name} in time${outcome}`)
    }

    publish({ error: null, home, phase: 'away', trip })
    armTimer(trip.until - now())
    deps.onEvent?.({ by: request.by, city: trip.city, country: trip.country, minutes, type: 'jumped' })

    return { ok: true, state }
  }

  /** A jump that did not work: bring everything back, and say whether that worked too. */
  async function giveUp(rec: TeleportRecord, wasHop: boolean): Promise<string> {
    const outcome = await restoreHome(rec)

    if (outcome.restored) {
      clearRecord()
      publish({ home: null, phase: 'idle', trip: null })

      return outcome.complete || !wasHop ? '; you are back home' : '; you are back home (the tunnel is still coming up)'
    }

    // Could not even put the location back: keep the record, the timer retries.
    publish({ phase: 'away', trip: rec.trip })
    armTimer(RETRY_HOME_MS)

    return `; and could not come back yet, retrying in ${RETRY_HOME_MS / 1000}s`
  }

  // ── home ──

  async function doHome(by: TeleportCause): Promise<TeleportResult> {
    const rec = record

    if (!rec) {
      publish({ home: null, phase: 'idle', trip: null })

      return { ok: true, state }
    }

    clearTimer()
    publish({ phase: 'returning' })
    log(`[teleport] returning home (${by})`)

    const outcome = await restoreHome(rec)

    if (!outcome.restored) {
      publish({ phase: 'away', trip: { ...rec.trip, until: now() + RETRY_HOME_MS } })
      armTimer(RETRY_HOME_MS)

      return failure(
        'failed',
        `Could not put Mullvad back to ${rec.home.label || 'where it was'}; retrying in ${RETRY_HOME_MS / 1000}s`
      )
    }

    clearRecord()
    publish({ error: null, home: null, phase: 'idle', trip: null })
    deps.onEvent?.({ by, type: 'returned' })

    if (!outcome.complete) {
      return failure('return-incomplete', 'The location is back, but the tunnel has not finished coming up')
    }

    return { ok: true, state }
  }

  // ── recovery ──

  /**
   * At launch, BEFORE the VPN gate connects anything: a trip found on disk means the app died away from home.
   * Put the location back (only the location: the gate decides about the tunnel, and must never wait for this).
   */
  async function doRecover(): Promise<void> {
    const rec = store.read()

    if (!rec) {
      return
    }

    log(`[teleport] a trip to ${rec.trip.countryName ?? rec.trip.country} was left open; bringing the location home`)

    record = rec
    publish({ home: rec.home, phase: 'returning', trip: rec.trip })

    const current = await client.relayGet()

    const alreadyHome =
      current.constraints?.location && sameRelayLocation(current.constraints.location, rec.home.location)

    const set = alreadyHome ? { code: 0 } : await client.setRelayLocation(rec.home.location)

    if (set.code === 0) {
      clearRecord()
      publish({ error: null, home: null, phase: 'idle', trip: null })
      deps.onEvent?.({ by: 'recovery', type: 'returned' })
      deps.onChanged?.()

      return
    }

    // The daemon is not answering yet: it is a trip that is due, and the timer keeps trying.
    publish({ phase: 'away', trip: { ...rec.trip, until: now() } })
    armTimer(RETRY_HOME_MS)
  }

  function home(by: TeleportCause = 'user'): Promise<TeleportResult> {
    return exclusive(() => withHold(() => doHome(by)))
  }

  return {
    destinations,

    dispose(): void {
      disposed = true
      clearTimer()
    },

    getState: (): TeleportState => state,
    home,

    jump: (request: TeleportRequest): Promise<TeleportResult> => exclusive(() => withHold(() => doJump(request))),

    /** True while the machine is away from home, so quitting must wait for the way back. */
    needsQuitWait: (): boolean => record !== null,

    recover(): Promise<void> {
      recovering ??= exclusive(doRecover).catch(error => {
        log(`[teleport] recovery failed: ${error instanceof Error ? error.message : String(error)}`)
      })

      return recovering
    }
  }
}

export type Teleport = ReturnType<typeof createTeleport>
