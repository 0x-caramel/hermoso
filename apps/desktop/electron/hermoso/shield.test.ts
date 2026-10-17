import { describe, expect, it, vi } from 'vitest'

import { createShield, evaluateShield, type ShieldVpn, vpnRequired } from './shield'

const vpn = (
  patch: Omit<Partial<ShieldVpn>, 'settings'> & { settings?: Partial<ShieldVpn['settings']> } = {}
): ShieldVpn => ({
  gate: 'ready',
  tunnel: 'connected',
  waived: false,
  ...patch,
  settings: { block: true, city: null, country: null, enabled: true, ...patch.settings }
})

describe('when the agent must stand still', () => {
  it('not while the tunnel is up', () => {
    expect(evaluateShield(vpn(), null, 1)).toMatchObject({ frozen: false, reason: null, required: true, since: null })
  })

  it('whenever the VPN is required and the tunnel is not up, whatever way it is not', () => {
    for (const tunnel of ['disconnected', 'connecting', 'disconnecting', 'blocked', 'unknown'] as const) {
      expect(evaluateShield(vpn({ tunnel }), null, 5), tunnel).toMatchObject({
        frozen: true,
        reason: 'tunnel-down',
        since: 5,
        tunnel
      })
    }
  })

  it('never when the person does not require the VPN', () => {
    expect(evaluateShield(vpn({ settings: { enabled: false }, tunnel: 'disconnected' }), null, 1).frozen).toBe(false)
    expect(evaluateShield(vpn({ settings: { block: false }, tunnel: 'disconnected' }), null, 1).frozen).toBe(false)
    expect(evaluateShield(vpn({ tunnel: 'disconnected', waived: true }), null, 1)).toMatchObject({
      frozen: false,
      required: false
    })
  })

  it('knows what "required" means: the same rule that holds the backend at launch', () => {
    expect(vpnRequired(vpn())).toBe(true)
    expect(vpnRequired(vpn({ waived: true }))).toBe(false)
    expect(vpnRequired(vpn({ settings: { block: false } }))).toBe(false)
    expect(vpnRequired(vpn({ settings: { enabled: false } }))).toBe(false)
  })

  it('a freeze that carries on keeps the moment it began; a new one starts at its own moment', () => {
    const first = evaluateShield(vpn({ tunnel: 'disconnected' }), null, 100)
    const still = evaluateShield(vpn({ tunnel: 'connecting' }), first, 150)

    expect(still.since).toBe(100)

    const back = evaluateShield(vpn(), still, 200)

    expect(back).toMatchObject({ frozen: false, since: null })
    expect(evaluateShield(vpn({ tunnel: 'disconnected' }), back, 300).since).toBe(300)
  })
})

describe('the shield the app keeps', () => {
  function make() {
    let current = vpn()
    let clock = 1_000
    const onChange = vi.fn()
    const shield = createShield({ now: () => clock, onChange, vpn: () => current })

    return {
      onChange,
      set: (next: ShieldVpn) => {
        current = next
        clock += 10
      },
      shield
    }
  }

  it('starts from what the VPN controller says now', () => {
    expect(make().shield.getState().frozen).toBe(false)
  })

  it('tells only when the verdict changes, not on every look', () => {
    const { onChange, set, shield } = make()

    shield.check()
    shield.check()
    expect(onChange).not.toHaveBeenCalled()

    set(vpn({ tunnel: 'disconnected' }))
    expect(shield.check().frozen).toBe(true)
    shield.check()
    expect(onChange).toHaveBeenCalledTimes(1)

    set(vpn({ tunnel: 'connecting' }))
    shield.check()
    expect(onChange).toHaveBeenCalledTimes(2)

    set(vpn())
    expect(shield.check().frozen).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange.mock.calls.map(call => call[0].frozen)).toEqual([true, true, false])
  })

  it('a person waiving the VPN for this launch lifts the freeze at once', () => {
    const { set, shield } = make()

    set(vpn({ tunnel: 'disconnected' }))
    expect(shield.check().frozen).toBe(true)

    set(vpn({ tunnel: 'disconnected', waived: true }))
    expect(shield.check().frozen).toBe(false)
  })
})
