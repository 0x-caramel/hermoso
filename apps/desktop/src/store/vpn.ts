/**
 * Mullvad VPN gate (renderer side).
 *
 * The MAIN process is authoritative: it owns the tunnel (via the Mullvad CLI),
 * the persisted preference, and the gate that holds backend startup until the
 * tunnel is up (electron/vpn-controller.ts). This module only caches what main
 * pushes, paints it, and asks main to act — same authority split as Quick
 * Entry and keep-awake.
 *
 * Three consumers ride it: the boot overlay (components/vpn-gate-overlay), the
 * Settings → VPN page, and the statusbar chip. The boot itself waits on
 * `awaitVpnGate()` so the gateway is never dialed while the gate is closed.
 */

import { atom } from 'nanostores'

import { translateNow } from '@/i18n'
import { dismissNotification, notify } from '@/store/notifications'

export type VpnGateStatus = 'blocked' | 'checking' | 'connecting' | 'off' | 'ready'

export type VpnTunnelState = 'blocked' | 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown'

export type VpnBlockReason =
  'account-expired' | 'daemon-unreachable' | 'error-state' | 'failed' | 'not-installed' | 'not-logged-in' | 'timeout'

export interface VpnSettings {
  /** Hold backend startup until the tunnel is up. */
  block: boolean
  /** Mullvad city code; only meaningful with a country. */
  city: null | string
  /** Mullvad country code; null keeps whatever the Mullvad app has selected. */
  country: null | string
  /** Master switch for the integration. */
  enabled: boolean
}

export interface VpnLocation {
  city: null | string
  country: null | string
}

export interface VpnState {
  cliFound: boolean
  gate: VpnGateStatus
  location: null | VpnLocation
  /** Short CLI-provided detail for a blocked gate. */
  message: null | string
  reason: null | VpnBlockReason
  relay: null | string
  settings: VpnSettings
  tunnel: VpnTunnelState
  updatedAt: number
  /** The user chose to start without the VPN for this launch (session-only, never saved). */
  waived: boolean
}

export interface VpnRelayCity {
  code: string
  name: string
}

export interface VpnRelayCountry {
  cities: VpnRelayCity[]
  code: string
  name: string
}

export const DEFAULT_VPN_SETTINGS: VpnSettings = { block: true, city: null, country: null, enabled: true }

const DROPPED_NOTICE_ID = 'vpn-dropped'

// A disconnect the user just asked for is not a drop worth a warning.
const EXPECTED_DISCONNECT_MS = 5_000
let expectedDisconnectUntil = 0

const INITIAL_VPN_STATE: VpnState = {
  cliFound: true,
  gate: 'off',
  location: null,
  message: null,
  reason: null,
  relay: null,
  settings: DEFAULT_VPN_SETTINGS,
  tunnel: 'unknown',
  updatedAt: 0,
  waived: false
}

export const $vpn = atom<VpnState>(INITIAL_VPN_STATE)

/** False until main's first answer lands — nothing gates or paints on a guess. */
export const $vpnLoaded = atom(false)

/** True when the shell exposes the VPN capability (desktop only). */
export function canUseVpn(): boolean {
  return typeof window !== 'undefined' && typeof window.hermesDesktop?.vpn?.getState === 'function'
}

/** Whether this state is holding the app's startup (and so owns the boot screen). */
export function vpnHoldsBoot(state: VpnState): boolean {
  return (
    state.settings.enabled && state.settings.block && !state.waived && state.gate !== 'ready' && state.gate !== 'off'
  )
}

export type VpnStatusKey =
  | 'blocked'
  | 'checking'
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disconnecting'
  | 'notInstalled'
  | 'off'
  | 'unknown'

/** One label for the tunnel as the user should read it, across gate + live tunnel state. */
export function vpnStatusKey(state: VpnState): VpnStatusKey {
  if (!state.settings.enabled) {
    return 'off'
  }

  if (!state.cliFound) {
    return 'notInstalled'
  }

  if (state.gate === 'checking') {
    return 'checking'
  }

  // Between "connect" being issued and the daemon reporting it, the tunnel still says
  // disconnected; the honest answer is that we are connecting.
  if (state.gate === 'connecting' && state.tunnel !== 'connected') {
    return 'connecting'
  }

  return state.tunnel
}

/** "Sweden, Stockholm" (or just the country) for a live tunnel, else null. */
export function vpnPlace(state: VpnState): null | string {
  const { city, country } = state.location ?? { city: null, country: null }

  if (!country) {
    return null
  }

  return city ? `${country}, ${city}` : country
}

function isVpnState(value: unknown): value is VpnState {
  return Boolean(value) && typeof value === 'object' && typeof (value as VpnState).gate === 'string'
}

/**
 * A live tunnel that went away while the app is up is worth one calm, non-blocking
 * notice. It is not a gate: Mullvad reconnects by itself after a network blip, and a
 * deliberate disconnect is the user's call.
 */
function noteTransition(previous: VpnState, next: VpnState): void {
  if (!$vpnLoaded.get()) {
    return
  }

  if (next.tunnel === 'connected') {
    if (previous.tunnel !== 'connected') {
      dismissNotification(DROPPED_NOTICE_ID)
    }

    return
  }

  const dropped =
    Date.now() >= expectedDisconnectUntil &&
    previous.tunnel === 'connected' &&
    (next.tunnel === 'disconnected' || next.tunnel === 'blocked') &&
    next.settings.enabled &&
    next.gate === 'ready'

  if (dropped) {
    notify({
      action: { label: translateNow('vpn.dropped.reconnect'), onClick: () => void ensureVpn() },
      id: DROPPED_NOTICE_ID,
      kind: 'warning',
      message: translateNow('vpn.dropped.message'),
      title: translateNow('vpn.dropped.title')
    })
  }
}

function adopt(next: unknown): void {
  if (!isVpnState(next)) {
    return
  }

  const current = $vpn.get()

  // A reply can land after a newer push; never let the past overwrite the present.
  if ($vpnLoaded.get() && next.updatedAt < current.updatedAt) {
    return
  }

  noteTransition(current, next)
  $vpn.set(next)
  $vpnLoaded.set(true)
}

let unsubscribeState: (() => void) | null = null

const disposeBridge = () => {
  unsubscribeState?.()
  unsubscribeState = null
}

/**
 * Wire main's state pushes into the store once (idempotent). The bridge lives for
 * the window's lifetime; the returned disposer exists for tests and hot reload.
 */
export function initVpnBridge(): () => void {
  const api = typeof window === 'undefined' ? undefined : window.hermesDesktop?.vpn

  if (api?.onState && !unsubscribeState) {
    unsubscribeState = api.onState(adopt)
  }

  return disposeBridge
}

/** Read main's current state into the store (mount of any consumer). */
export async function loadVpnState(): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  try {
    adopt(await window.hermesDesktop.vpn.getState())
  } catch {
    // Leave the store as it was; the next push repairs it.
  }
}

/** Connect / retry. Single-flight in main: safe to call while an attempt is running. */
export async function ensureVpn(): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  try {
    adopt(await window.hermesDesktop.vpn.ensure())
  } catch {
    // main answers every ensure; a rejected IPC means the bridge is gone.
  }
}

/** Re-read the live tunnel (Settings mount), without connecting anything. */
export async function refreshVpn(): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  try {
    adopt(await window.hermesDesktop.vpn.refresh())
  } catch {
    // Keep the last known state.
  }
}

export async function disconnectVpn(): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  expectedDisconnectUntil = Date.now() + EXPECTED_DISCONNECT_MS

  try {
    adopt(await window.hermesDesktop.vpn.disconnect())
  } catch {
    // The monitor's next push reports the real tunnel state.
  }
}

/**
 * Write a preference and adopt whatever main reports back. Optimistic: the
 * intent paints in this frame, and the authoritative reply (or a rollback on
 * failure) gets the last word.
 */
export async function saveVpnSettings(patch: Partial<VpnSettings>): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  const previous = $vpn.get()
  $vpn.set({ ...previous, settings: { ...previous.settings, ...patch } })

  try {
    adopt(await window.hermesDesktop.vpn.setSettings(patch))
  } catch {
    $vpn.set(previous)
  }
}

/**
 * "Continue without VPN": start this launch without the tunnel. Main remembers it for the
 * session only — the saved preference is untouched, so the next launch gates again.
 */
export async function waiveVpnStartup(): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  try {
    adopt(await window.hermesDesktop.vpn.waive())
  } catch {
    // Nothing to roll back: the gate simply stays where it was.
  }
}

export async function openMullvad(): Promise<void> {
  try {
    await window.hermesDesktop?.vpn?.openApp()
  } catch {
    // Nothing to recover: the button simply did nothing.
  }
}

export async function loadVpnRelays(): Promise<VpnRelayCountry[]> {
  if (!canUseVpn()) {
    return []
  }

  try {
    const relays = await window.hermesDesktop.vpn.listRelays()

    return Array.isArray(relays) ? relays : []
  } catch {
    return []
  }
}

function nextVpnChange(): Promise<void> {
  return new Promise(resolve => {
    const off = $vpn.listen(() => {
      off()
      resolve()
    })
  })
}

/**
 * Hold a boot until the VPN gate lets it through. Resolves at once when the
 * integration is off, non-blocking, or the tunnel is already up; otherwise it
 * waits on main's pushes (the overlay is showing the state and the way out). A
 * broken bridge never blocks boot — main enforces the gate again at spawn.
 */
export async function awaitVpnGate(isCancelled: () => boolean = () => false): Promise<void> {
  if (!canUseVpn()) {
    return
  }

  initVpnBridge()

  try {
    adopt(await window.hermesDesktop.vpn.getState())
  } catch {
    return
  }

  // Joins the attempt main's eager boot already started, or starts one if idle.
  void ensureVpn()

  while (vpnHoldsBoot($vpn.get()) && !isCancelled()) {
    await nextVpnChange()
  }
}
