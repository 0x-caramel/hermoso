/**
 * Hermoso, as the window sees it: the types of what the app's main process answers (electron/hermoso/) and one
 * typed door to `window.hermesDesktop.hermoso`. Main is authoritative for everything here; this only asks and paints.
 */

export type TeleportPhase = 'away' | 'idle' | 'jumping' | 'returning'

export interface TeleportTrip {
  by: 'agent' | 'user'
  city: null | string
  /** Two-letter code, as `mullvad relay list` prints it. */
  country: string
  countryName: null | string
  reason: null | string
  since: number
  /** When the trip ends by itself (epoch ms). */
  until: number
}

export interface TeleportState {
  error: null | { at: number; code: string; message: string }
  home: null | { label: string; wasConnected: boolean }
  phase: TeleportPhase
  trip: null | TeleportTrip
  updatedAt: number
}

export interface Destination {
  cities: { code: string; name: string }[]
  code: string
  name: string
}

export type TeleportResult =
  { ok: false; code: string; message: string; state: TeleportState } | { ok: true; state: TeleportState }

export interface JumpRequest {
  city?: null | string
  country: string
  minutes?: number
}

export interface ConsentPrompt {
  allowKey: null | string
  allowLabel: null | string
  askedAt: number
  /** What exactly is about to happen, shown as it is (a command, a path). */
  code?: null | string
  id: string
  kind: string
  lines: string[]
  title: string
}

export type ConsentAnswer = 'always' | 'deny' | 'once'

export interface AllowedItem {
  at: number
  key: string
  label: string
}

export interface AgentLink {
  seenAt: null | number
  version: null | string
}

/** The verdict of the shield: the agent must stand still while the VPN is required and the tunnel is not up. */
export interface ShieldState {
  frozen: boolean
  reason: 'tunnel-down' | null
  /** Whether the person's settings ask for the tunnel to be up. */
  required: boolean
  /** When the freeze began (epoch ms); null while not frozen. */
  since: null | number
  tunnel: string
  updatedAt: number
}

export type GuardianDecision = 'allowed' | 'always' | 'blocked' | 'denied' | 'remembered' | 'timeout'

export interface GuardianEvent {
  at: number
  decision: GuardianDecision
  detail: string
  rule: string
  title: string
  tool: string
}

/** The guardian as main reports it: switched on or off, its last decisions, and how many of each kind. */
export interface GuardianView {
  enabled: boolean
  events: GuardianEvent[]
  totals: { allowed: number; asked: number; blocked: number; denied: number }
}

export const CALM_GUARDIAN: GuardianView = {
  enabled: true,
  events: [],
  totals: { allowed: 0, asked: 0, blocked: 0, denied: 0 }
}

/** The Time Machine as main reports it: whether the person wants snapshots, and whether this run has them. */
export interface TimeMachineView {
  /** Hermes was started asking for snapshots (the choice is read once, when the backend starts). */
  active: boolean
  enabled: boolean
}

export const CALM_TIME_MACHINE: TimeMachineView = { active: false, enabled: true }

/** One snapshot of the project folder, as Hermes lists them (newest first). */
export interface Snapshot {
  hash: string
  message: string
  timestamp: string
}

export interface SnapshotList {
  checkpoints: Snapshot[]
  enabled: boolean
}

export interface SnapshotDiff {
  diff: string
  stat: string
}

export interface RestoreResult {
  error?: string
  failed_deletes?: string[]
  /** How many chat messages went with the rewind. */
  history_removed?: number
  restore?: string[]
  skipped_oversize?: string[]
  /** Files the person changed by hand after the snapshot: kept, not overwritten. */
  skipped_user_edits?: string[]
  success?: boolean
}

export type Route = 'lan' | 'loopback' | 'outside' | 'tunnel'

export interface RadarConnection {
  localAddress: string
  localPort: number
  pid: number
  process: string
  remoteAddress: string
  remotePort: number
  route: Route
  state: string
}

export interface RadarSample {
  at: number
  connections: RadarConnection[]
  error: null | string
  tunnelAddresses: string[]
}

export interface LedgerSummary {
  byRoute: Record<Route, number>
  frozenSeconds: number
  lastAt: null | number
  missed: number
  outside: { at: number; pid: number; port: number; process: string; remote: string }[]
  samples: number
  seen: number
  startedAt: number
}

/** What one look at the machine gives back. */
export interface RadarView {
  sample: RadarSample
  shield: ShieldState
  summary: LedgerSummary
}

export const CALM_SHIELD: ShieldState = {
  frozen: false,
  reason: null,
  required: false,
  since: null,
  tunnel: 'unknown',
  updatedAt: 0
}

export const IDLE_TELEPORT: TeleportState = { error: null, home: null, phase: 'idle', trip: null, updatedAt: 0 }

type HermosoBridge = {
  call: (method: string, params?: unknown) => Promise<unknown>
  onEvent: (callback: (payload: unknown) => void) => () => void
}

function bridge(): HermosoBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as { hermesDesktop?: { hermoso?: HermosoBridge } }).hermesDesktop?.hermoso
}

/** True when the shell exposes Hermoso (the desktop app built as Hermoso; a plain browser tab does not). */
export const hermosoAvailable = (): boolean => typeof bridge()?.call === 'function'

export async function hermosoCall<T>(method: string, params?: unknown): Promise<null | T> {
  try {
    return ((await bridge()?.call(method, params)) ?? null) as null | T
  } catch {
    return null
  }
}

export function onHermosoEvent(callback: (payload: unknown) => void): () => void {
  return bridge()?.onEvent(callback) ?? (() => {})
}

type HermosoEvent =
  | { agent: AgentLink; type: 'agent' }
  | { event: GuardianEvent; type: 'guardian' }
  | { id: string; type: 'consent-closed' }
  | { prompt: ConsentPrompt; type: 'consent' }
  | { state: ShieldState; type: 'shield' }
  | { state: TeleportState; type: 'teleport' }

export function readEvent(payload: unknown): HermosoEvent | null {
  const event = payload as {
    agent?: unknown
    event?: unknown
    id?: unknown
    prompt?: unknown
    state?: { phase?: unknown }
    type?: unknown
  } | null

  switch (event?.type) {
    case 'teleport':
      return event.state && typeof event.state.phase === 'string' ? (event as HermosoEvent) : null

    case 'consent':
      return event.prompt && typeof (event.prompt as { id?: unknown }).id === 'string' ? (event as HermosoEvent) : null

    case 'guardian':
      return event.event && typeof (event.event as { rule?: unknown }).rule === 'string'
        ? (event as HermosoEvent)
        : null

    case 'shield':
      return event.state && typeof (event.state as { frozen?: unknown }).frozen === 'boolean'
        ? (event as HermosoEvent)
        : null

    case 'consent-closed':
      return typeof event.id === 'string' ? (event as HermosoEvent) : null

    case 'agent':
      return event.agent && typeof event.agent === 'object' ? (event as HermosoEvent) : null

    default:
      return null
  }
}

export function isTeleportEvent(payload: unknown): payload is { state: TeleportState; type: 'teleport' } {
  const event = payload as { state?: { phase?: unknown }; type?: unknown } | null

  return Boolean(event && event.type === 'teleport' && event.state && typeof event.state.phase === 'string')
}
