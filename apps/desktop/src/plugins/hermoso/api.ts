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
  | { id: string; type: 'consent-closed' }
  | { prompt: ConsentPrompt; type: 'consent' }
  | { state: TeleportState; type: 'teleport' }

export function readEvent(payload: unknown): HermosoEvent | null {
  const event = payload as {
    agent?: unknown
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
