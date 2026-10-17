/**
 * Hermoso's renderer state: whatever main last pushed, plus the actions that ask main to do something. Nothing here
 * decides anything about the tunnel: a jump that fails comes back as an answer and is shown, never guessed.
 */

import { atom } from '@hermes/plugin-sdk'

import {
  type Destination,
  hermosoAvailable,
  hermosoCall,
  IDLE_TELEPORT,
  isTeleportEvent,
  type JumpRequest,
  onHermosoEvent,
  type TeleportResult,
  type TeleportState
} from './api'

export const $teleport = atom<TeleportState>(IDLE_TELEPORT)
export const $destinations = atom<Destination[]>([])

/** False until main's first answer lands. */
export const $hermosoReady = atom(false)

/** What the Mullvad tunnel says right now (the part Teleport shows: where the connection exits). */
export interface ExitPlace {
  city: null | string
  country: null | string
  /** False when the tunnel is not up (nothing to say about an exit). */
  up: boolean
}

export const $exit = atom<ExitPlace>({ city: null, country: null, up: false })

// ── subscribing ──

type VpnBridge = {
  getState: () => Promise<{ location: null | { city: null | string; country: null | string }; tunnel: string }>
  onState: (
    callback: (state: { location: null | { city: null | string; country: null | string }; tunnel: string }) => void
  ) => () => void
}

const vpnBridge = (): undefined | VpnBridge =>
  typeof window === 'undefined' ? undefined : (window as { hermesDesktop?: { vpn?: VpnBridge } }).hermesDesktop?.vpn

function paintExit(state: { location: null | { city: null | string; country: null | string }; tunnel: string }): void {
  $exit.set({
    city: state.location?.city ?? null,
    country: state.location?.country ?? null,
    up: state.tunnel === 'connected'
  })
}

/** Subscribe to main once and load the first answers. Returns the function that unsubscribes (plugin dispose). */
export function startHermoso(): () => void {
  if (!hermosoAvailable()) {
    return () => {}
  }

  const stops: (() => void)[] = []

  stops.push(
    onHermosoEvent(payload => {
      if (isTeleportEvent(payload)) {
        $teleport.set(payload.state)
      }
    })
  )

  void hermosoCall<TeleportState>('teleport.state').then(state => {
    if (state) {
      $teleport.set(state)
    }

    $hermosoReady.set(true)
  })

  const vpn = vpnBridge()

  if (vpn) {
    void vpn.getState().then(paintExit)
    stops.push(vpn.onState(paintExit))
  }

  return () => stops.forEach(stop => stop())
}

/** The countries Mullvad can exit from; read once the tunnel's CLI answers, kept after. */
export async function loadDestinations(): Promise<Destination[]> {
  if ($destinations.get().length > 0) {
    return $destinations.get()
  }

  const list = (await hermosoCall<Destination[]>('teleport.destinations')) ?? []

  if (list.length > 0) {
    $destinations.set(list)
  }

  return list
}

// ── acting ──

const failed = (message: string): TeleportResult => ({
  code: 'unavailable',
  message,
  ok: false,
  state: $teleport.get()
})

export async function teleportTo(request: JumpRequest): Promise<TeleportResult> {
  const result = await hermosoCall<TeleportResult>('teleport.jump', request)

  if (!result) {
    return failed('Hermoso did not answer.')
  }

  $teleport.set(result.state)

  return result
}

export async function teleportHome(): Promise<TeleportResult> {
  const result = await hermosoCall<TeleportResult>('teleport.home')

  if (!result) {
    return failed('Hermoso did not answer.')
  }

  $teleport.set(result.state)

  return result
}
