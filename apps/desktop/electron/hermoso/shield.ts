/**
 * Shield (main process, Electron-free): when the VPN tunnel is not up, the agent stands still.
 *
 * The app already holds its own start until the tunnel is up (the VPN gate) and holds its own network requests
 * (the egress gate). That does nothing for an agent that is already running when the tunnel drops mid-session:
 * Mullvad reconnects by itself after a blip, and until it does the machine's traffic may leave on the real address
 * (only Mullvad's "Always require VPN" really prevents that). Shield answers one question for the agent's plugin,
 * "may I act right now?", from the VPN controller's state:
 *
 *   frozen  =  the VPN is required (enabled, blocking, not waived for this launch)  and  the tunnel is not up
 *
 * A planned reconnect (Teleport) never shows as a drop: the controller keeps reporting the tunnel as it was while
 * the move is on purpose. Everything here is a pure function of that state, so it can be tested without a tunnel.
 */

import type { VpnState } from '../vpn-controller'

export type ShieldVpn = Pick<VpnState, 'gate' | 'settings' | 'tunnel' | 'waived'>

export type ShieldReason = 'tunnel-down' | null

export interface ShieldState {
  /** The agent must not act: the VPN is required and the tunnel is not up. */
  frozen: boolean
  reason: ShieldReason
  /** Whether the person's settings require the VPN for this run. */
  required: boolean
  /** When the freeze began (epoch ms); null while not frozen. */
  since: null | number
  /** The tunnel as the VPN controller last saw it. */
  tunnel: ShieldVpn['tunnel']
  updatedAt: number
}

/** Whether the person's settings ask for the tunnel to be up (the same rule that holds the backend at launch). */
export function vpnRequired(vpn: ShieldVpn): boolean {
  return vpn.settings.enabled && vpn.settings.block && !vpn.waived
}

export function evaluateShield(vpn: ShieldVpn, previous: null | ShieldState, now: number): ShieldState {
  const required = vpnRequired(vpn)
  const frozen = required && vpn.tunnel !== 'connected'

  return {
    frozen,
    reason: frozen ? 'tunnel-down' : null,
    required,
    // A freeze that carries on keeps the moment it began; a new one starts now.
    since: frozen ? (previous?.frozen && previous.since !== null ? previous.since : now) : null,
    tunnel: vpn.tunnel,
    updatedAt: now
  }
}

export interface ShieldDeps {
  /** Called when the frozen/unfrozen verdict changes (not on every look). */
  onChange?: (state: ShieldState) => void
  now?: () => number
  vpn: () => ShieldVpn
}

export function createShield(deps: ShieldDeps) {
  const now = deps.now ?? Date.now
  let state = evaluateShield(deps.vpn(), null, now())

  return {
    /** Look at the VPN controller again; tells `onChange` only when the verdict changed. */
    check(): ShieldState {
      const next = evaluateShield(deps.vpn(), state, now())
      const changed = next.frozen !== state.frozen || next.tunnel !== state.tunnel || next.required !== state.required

      state = next

      if (changed) {
        deps.onChange?.(state)
      }

      return state
    },

    getState: (): ShieldState => state
  }
}

export type Shield = ReturnType<typeof createShield>
