/**
 * Hermoso's renderer state: whatever main last pushed, plus the actions that ask main to do something. Nothing here
 * decides anything about the tunnel or about consent: a jump that fails comes back as an answer and is shown, and
 * the person's yes goes to main as it was given, never guessed.
 */

import { atom } from '@hermes/plugin-sdk'

import {
  type AgentLink,
  type AllowedItem,
  CALM_GUARDIAN,
  CALM_SHIELD,
  type ConsentAnswer,
  type ConsentPrompt,
  type Destination,
  type GuardianView,
  hermosoAvailable,
  hermosoCall,
  IDLE_TELEPORT,
  type JumpRequest,
  onHermosoEvent,
  type RadarView,
  readEvent,
  type ShieldState,
  type TeleportResult,
  type TeleportState
} from './api'

export const $teleport = atom<TeleportState>(IDLE_TELEPORT)
export const $destinations = atom<Destination[]>([])

/** The guardian: switched on or off, what it asked and refused, its last decisions. */
export const $guardian = atom<GuardianView>(CALM_GUARDIAN)

/** The shield's verdict: is the agent standing still because the VPN tunnel is down? */
export const $shield = atom<ShieldState>(CALM_SHIELD)

/** The last look at the app's connections, and what the ledger has counted so far. */
export const $radar = atom<null | RadarView>(null)

/** Mullvad's "Always require VPN" (null: not known, the CLI did not answer). */
export const $lockdown = atom<boolean | null>(null)

/** False until main's first answer lands. */
export const $hermosoReady = atom(false)

/** Requests waiting for the person's answer, oldest first. */
export const $consent = atom<ConsentPrompt[]>([])

/** What the person said "always allow" to, listed so it can be taken back. */
export const $allowed = atom<AllowedItem[]>([])

/** Whether the agent's plugin has been in touch (it reaches the app only while the app runs). */
export const $agent = atom<AgentLink>({ seenAt: null, version: null })

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

function addPrompt(prompt: ConsentPrompt): void {
  const queue = $consent.get()

  if (!queue.some(entry => entry.id === prompt.id)) {
    $consent.set([...queue, prompt])
  }
}

/** Subscribe to main once and load the first answers. Returns the function that unsubscribes (plugin dispose). */
export function startHermoso(): () => void {
  if (!hermosoAvailable()) {
    return () => {}
  }

  const stops: (() => void)[] = []

  stops.push(
    onHermosoEvent(payload => {
      const event = readEvent(payload)

      switch (event?.type) {
        case 'teleport':
          $teleport.set(event.state)

          break

        case 'consent':
          addPrompt(event.prompt)

          break

        case 'shield':
          $shield.set(event.state)

          break

        case 'guardian':
          void loadGuardian()

          break

        case 'consent-closed':
          $consent.set($consent.get().filter(entry => entry.id !== event.id))
          void loadAllowed()

          break

        case 'agent':
          $agent.set(event.agent)

          break
      }
    })
  )

  void hermosoCall<TeleportState>('teleport.state').then(state => {
    if (state) {
      $teleport.set(state)
    }

    $hermosoReady.set(true)
  })

  // A window that opens (or reloads) while a request is waiting must see it.
  void hermosoCall<ConsentPrompt[]>('consent.pending').then(list => list?.forEach(addPrompt))
  void hermosoCall<AgentLink>('agent.state').then(link => link && $agent.set(link))
  void hermosoCall<ShieldState>('shield.state').then(state => state && $shield.set(state))
  void loadGuardian()
  void loadAllowed()

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

export async function loadAllowed(): Promise<void> {
  const list = await hermosoCall<AllowedItem[]>('consent.always')

  if (Array.isArray(list)) {
    $allowed.set(list)
  }
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

/** The person's answer to a request, exactly as given. The request leaves the queue when main says it is over. */
export async function answerConsent(id: string, answer: ConsentAnswer): Promise<void> {
  await hermosoCall('consent.answer', { answer, id })
}

/** This window is showing the request: main need not ask with a native dialog. */
export function ackConsent(id: string): void {
  void hermosoCall('consent.ack', { id })
}

export async function revokeAllowed(key: string): Promise<void> {
  await hermosoCall('consent.revoke', { key })
  await loadAllowed()
}

// ── the shield ──

/** Look at the app's connections now: the answer is painted, and the ledger counts what it saw. */
export async function lookAtRadar(): Promise<void> {
  const view = await hermosoCall<RadarView>('shield.radar')

  if (view?.sample) {
    $radar.set(view)
    $shield.set(view.shield)
  }
}

export async function loadLockdown(): Promise<void> {
  const on = await hermosoCall<boolean | null>('shield.lockdown.get')

  $lockdown.set(typeof on === 'boolean' ? on : null)
}

/** Ask Mullvad to turn "Always require VPN" on or off. What it says afterwards is what is shown, never what was asked. */
export async function setLockdown(on: boolean): Promise<boolean> {
  const result = await hermosoCall<{ ok: boolean; on: boolean | null }>('shield.lockdown.set', { on })

  $lockdown.set(typeof result?.on === 'boolean' ? result.on : null)

  return result?.ok === true
}

/** The proof report, as Markdown (null when Hermoso did not answer). */
export async function readReport(): Promise<null | string> {
  const text = await hermosoCall<string>('shield.report')

  return typeof text === 'string' ? text : null
}

export async function resetRadar(): Promise<void> {
  await hermosoCall('shield.reset')
  $radar.set(null)
  await lookAtRadar()
}

// ── the guardian ──

export async function loadGuardian(): Promise<void> {
  const view = await hermosoCall<GuardianView>('guardian.state')

  if (view && typeof view.enabled === 'boolean' && Array.isArray(view.events)) {
    $guardian.set(view)
  }
}

/** Switch the review of risky commands on or off. What main says afterwards is what is shown. */
export async function setGuardianOn(on: boolean): Promise<void> {
  const view = await hermosoCall<GuardianView>('guardian.enable', { on })

  if (view && typeof view.enabled === 'boolean' && Array.isArray(view.events)) {
    $guardian.set(view)
  }
}
