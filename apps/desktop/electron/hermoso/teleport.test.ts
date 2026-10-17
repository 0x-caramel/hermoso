import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { RelayCountry, RelayLocation } from '../mullvad'

import { type DaemonOptions, fakeDaemon, RELAYS } from './fake-daemon'
import {
  createFileTeleportStore,
  createTeleport,
  resolveDestination,
  sanitizeTeleportRecord,
  type TeleportEvent,
  type TeleportRecord,
  type TeleportState
} from './teleport'

function harness(options: DaemonOptions = {}, record: null | TeleportRecord = null) {
  const daemon = fakeDaemon(options)
  const clock = { t: 1_000_000 }
  const states: TeleportState[] = []
  const events: TeleportEvent[] = []
  const timers: { cancelled: boolean; fn: () => void; ms: number }[] = []
  const holds = { active: 0, started: 0 }
  const changed = vi.fn()
  let stored: null | TeleportRecord = record

  const store = {
    clear: () => {
      daemon.calls.push('store:clear')
      stored = null
    },
    read: () => stored,
    write: (next: TeleportRecord) => {
      daemon.calls.push('store:write')
      stored = next
    }
  }

  const teleport = createTeleport({
    client: daemon.client,
    hold: () => {
      holds.active += 1
      holds.started += 1

      return () => {
        holds.active -= 1
      }
    },
    now: () => clock.t,
    onChanged: changed,
    onEvent: event => events.push(event),
    onState: state => states.push(state),
    schedule: (fn, ms) => {
      const timer = { cancelled: false, fn, ms }

      timers.push(timer)

      return () => {
        timer.cancelled = true
      }
    },
    sleep: async ms => {
      clock.t += ms
    },
    store
  })

  return {
    ...daemon,
    changed,
    clock,
    events,
    holds,
    /** Fire the timer that is currently armed (the end of a trip, or a retry). */
    async fireTimer() {
      const live = timers.filter(timer => !timer.cancelled)
      const timer = live[live.length - 1]

      expect(timer, 'a timer should be armed').toBeDefined()
      timer.cancelled = true
      timer.fn()
      await teleport.home('user').catch(() => {})
    },
    liveTimers: () => timers.filter(timer => !timer.cancelled),
    states,
    stored: () => stored,
    teleport
  }
}

describe('a trip, from a connected tunnel', () => {
  it('writes home down BEFORE anything moves, then ends up away with a timer', async () => {
    const h = harness()
    const result = await h.teleport.jump({ by: 'agent', country: 'DE', minutes: 15, reason: '  compare\nprices  ' })

    expect(result.ok).toBe(true)
    expect(h.stored()?.home).toEqual({
      label: 'country no',
      location: { country: 'no', kind: 'country' },
      wasConnected: true
    })

    // the record is on disk before the relay is touched
    expect(h.calls.indexOf('store:write')).toBeGreaterThanOrEqual(0)
    expect(h.calls.indexOf('store:write')).toBeLessThan(h.calls.indexOf('set:country de'))

    const state = h.teleport.getState()

    expect(state.phase).toBe('away')
    expect(state.trip).toMatchObject({
      by: 'agent',
      city: null,
      country: 'de',
      countryName: 'Germany',
      reason: 'compare prices'
    })
    expect(state.trip!.until - state.trip!.since).toBe(15 * 60_000)
    expect(h.tunnel()).toBe('connected')
    expect(h.constraint()).toEqual({ country: 'de', kind: 'country' })
    expect(h.liveTimers().map(timer => timer.ms)).toHaveLength(1)
    expect(h.states.map(s => s.phase)).toEqual(['jumping', 'away'])
    expect(h.events).toEqual([{ by: 'agent', city: null, country: 'de', minutes: 15, type: 'jumped' }])
    expect(h.teleport.needsQuitWait()).toBe(true)
  })

  it('does not touch the tunnel state itself when it was up: the relay change reconnects it', async () => {
    const h = harness()

    await h.teleport.jump({ by: 'user', country: 'de' })

    expect(h.calls).not.toContain('connect')
    expect(h.calls).not.toContain('disconnect')
  })

  it('the timer brings it home: the exact location, the tunnel up, the record gone', async () => {
    const h = harness()

    await h.teleport.jump({ by: 'user', country: 'de', minutes: 10 })
    expect(h.liveTimers()[0].ms).toBeGreaterThan(9 * 60_000)
    expect(h.liveTimers()[0].ms).toBeLessThanOrEqual(10 * 60_000)

    await h.fireTimer()

    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.tunnel()).toBe('connected')
    expect(h.stored()).toBeNull()
    expect(h.teleport.getState()).toMatchObject({ error: null, home: null, phase: 'idle', trip: null })
    expect(h.teleport.needsQuitWait()).toBe(false)
    expect(h.events.at(-1)).toEqual({ by: 'timer', type: 'returned' })
  })

  it('puts a city or a single relay back exactly as it was', async () => {
    const city = harness({ constraint: { city: 'got', country: 'se', kind: 'city' } })

    await city.teleport.jump({ by: 'user', country: 'de' })
    await city.teleport.home('user')

    expect(city.constraint()).toEqual({ city: 'got', country: 'se', kind: 'city' })

    const relay = harness({ constraint: { city: 'got', country: 'se', hostname: 'se-got-wg-004', kind: 'hostname' } })

    await relay.teleport.jump({ by: 'user', country: 'de' })
    await relay.teleport.home('user')

    expect(relay.constraint()).toEqual({ city: 'got', country: 'se', hostname: 'se-got-wg-004', kind: 'hostname' })
    expect(relay.calls).toContain('set:city got, se, hostname se-got-wg-004')
  })

  it('understands a country and a city by name as well as by code', async () => {
    const h = harness()
    const result = await h.teleport.jump({ by: 'agent', city: 'Frankfurt', country: 'Germany' })

    expect(result.ok).toBe(true)
    expect(h.constraint()).toEqual({ city: 'fra', country: 'de', kind: 'city' })
    expect(h.teleport.getState().trip).toMatchObject({ city: 'fra', country: 'de', countryName: 'Germany' })
  })

  it('goes to a city when asked for one', async () => {
    const h = harness()
    const result = await h.teleport.jump({ by: 'user', city: 'FRA', country: 'de' })

    expect(result.ok).toBe(true)
    expect(h.constraint()).toEqual({ city: 'fra', country: 'de', kind: 'city' })
    expect(h.teleport.getState().trip).toMatchObject({ city: 'fra', country: 'de' })
  })

  it('clamps the length of a trip to 1..60 minutes, 10 by default', async () => {
    const lengths: number[] = []

    for (const minutes of [undefined, 0, -5, 999, Number.NaN, 25]) {
      const h = harness()

      await h.teleport.jump({ by: 'user', country: 'de', minutes })
      lengths.push(Math.round(h.liveTimers()[0].ms / 60_000))
    }

    expect(lengths).toEqual([10, 1, 1, 60, 10, 25])
  })

  it("holds the VPN controller's attention around every move and refreshes after", async () => {
    const h = harness()

    await h.teleport.jump({ by: 'user', country: 'de' })
    expect(h.holds).toEqual({ active: 0, started: 1 })
    expect(h.changed).toHaveBeenCalledTimes(1)

    await h.teleport.home('user')
    expect(h.holds).toEqual({ active: 0, started: 2 })
    expect(h.changed).toHaveBeenCalledTimes(2)
  })
})

describe('a trip, from a tunnel that was down', () => {
  it('connects for the trip and disconnects when it ends, as it found it', async () => {
    const h = harness({ connected: false })

    await h.teleport.jump({ by: 'user', country: 'de' })

    expect(h.stored()?.home.wasConnected).toBe(false)
    expect(h.calls).toContain('connect')
    expect(h.tunnel()).toBe('connected')

    await h.teleport.home('user')

    expect(h.calls).toContain('disconnect')
    expect(h.tunnel()).toBe('disconnected')
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.teleport.getState().phase).toBe('idle')
  })
})

describe('hopping from one country to another', () => {
  it('keeps the first home and the first start, and one way back', async () => {
    const h = harness()

    await h.teleport.jump({ by: 'agent', country: 'de' })

    const first = h.teleport.getState().trip!

    h.clock.t += 60_000
    await h.teleport.jump({ by: 'agent', country: 'fr', minutes: 5 })

    const second = h.teleport.getState().trip!

    expect(second.country).toBe('fr')
    expect(second.since).toBe(first.since)
    expect(h.stored()?.home.location).toEqual({ country: 'no', kind: 'country' })

    await h.teleport.home('user')

    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.liveTimers()).toHaveLength(0)
  })
})

describe('what it refuses, without touching anything', () => {
  const untouched = (calls: string[]) =>
    expect(
      calls.filter(
        call => call.startsWith('set:') || call === 'connect' || call === 'disconnect' || call === 'store:write'
      )
    ).toEqual([])

  it('a malformed or unknown destination', async () => {
    const h = harness()

    for (const country of ['atlantis', '', 'zz', '../etc']) {
      const result = await h.teleport.jump({ by: 'agent', country })

      expect(result).toMatchObject({ code: 'unknown-destination', ok: false })
    }

    expect(await h.teleport.jump({ by: 'agent', city: 'xxx', country: 'de' })).toMatchObject({
      code: 'unknown-destination',
      ok: false
    })

    untouched(h.calls)
    expect(h.teleport.getState().error).toBeNull()
  })

  it('where it already is', async () => {
    const h = harness()

    expect(await h.teleport.jump({ by: 'user', country: 'no' })).toMatchObject({ code: 'already-there', ok: false })
    untouched(h.calls)
  })

  it('a home it could not put back (a custom list)', async () => {
    const h = harness({ customList: true })
    const result = await h.teleport.jump({ by: 'user', country: 'de' })

    expect(result).toMatchObject({ code: 'home-not-restorable', ok: false })
    expect((result as { message: string }).message).toContain('custom list Home')
    untouched(h.calls)
  })

  it('a daemon that does not answer', async () => {
    const h = harness()

    h.fail.relayGet = true

    expect(await h.teleport.jump({ by: 'user', country: 'de' })).toMatchObject({ code: 'vpn-unavailable', ok: false })
    untouched(h.calls)
  })
})

describe('a trip that cannot start leaves nothing behind', () => {
  it('Mullvad refuses the new location: nothing moved, nothing left on disk', async () => {
    const h = harness()

    h.fail.refuse = 'country de'

    const result = await h.teleport.jump({ by: 'agent', country: 'de' })

    expect(result).toMatchObject({ code: 'failed', ok: false })
    expect(h.stored()).toBeNull()
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.calls.filter(call => call.startsWith('set:'))).toEqual(['set:country de'])
    expect(h.teleport.getState()).toMatchObject({ home: null, phase: 'idle', trip: null })
    expect(h.teleport.getState().error?.code).toBe('failed')
    expect(h.events.at(-1)).toEqual({ code: 'failed', type: 'failed' })
    expect(h.liveTimers()).toHaveLength(0)
  })

  it('a hop that is refused leaves the trip that was already running exactly as it was', async () => {
    const h = harness()

    await h.teleport.jump({ by: 'agent', country: 'de', minutes: 20 })

    const running = h.stored()

    h.fail.refuse = 'country fr'

    expect(await h.teleport.jump({ by: 'agent', country: 'fr' })).toMatchObject({ code: 'failed', ok: false })
    expect(h.stored()).toEqual(running)
    expect(h.teleport.getState()).toMatchObject({ phase: 'away', trip: { country: 'de' } })
    expect(h.constraint()).toEqual({ country: 'de', kind: 'country' })
    expect(h.liveTimers()).toHaveLength(1)
  })

  it('the tunnel never comes up in the new country: home is put back before the failure is reported', async () => {
    const h = harness()

    // after the relay change the tunnel stays "connecting"; the controller gives up after 30 s and goes home
    const original = h.client.setRelayLocation

    h.client.setRelayLocation = async (location: RelayLocation) => {
      const result = await original(location)

      h.fail.stuck = location.kind === 'country' && location.country === 'de'

      return result
    }

    const result = await h.teleport.jump({ by: 'agent', country: 'de' })

    expect(result).toMatchObject({ code: 'timeout', ok: false })
    expect((result as { message: string }).message).toContain('back home')
    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.stored()).toBeNull()
    expect(h.teleport.getState()).toMatchObject({ home: null, phase: 'idle', trip: null })
  })
})

describe('when the way back fails', () => {
  it('stays away, keeps the record, and tries again until it works', async () => {
    const h = harness()

    await h.teleport.jump({ by: 'user', country: 'de' })

    h.fail.set = true

    const result = await h.teleport.home('user')

    expect(result).toMatchObject({ code: 'failed', ok: false })
    expect(h.teleport.getState().phase).toBe('away')
    expect(h.stored()).not.toBeNull()
    expect(h.liveTimers()).toHaveLength(1)

    h.fail.set = false
    await h.fireTimer()

    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.stored()).toBeNull()
    expect(h.teleport.getState().phase).toBe('idle')
  })

  it('returning when already home is a no-op that says so', async () => {
    const h = harness()

    expect((await h.teleport.home('user')).ok).toBe(true)
    expect(h.calls).not.toContain('set:country no')
  })
})

describe('operations never interleave', () => {
  it('a return asked while a jump is running waits for it, then brings it home', async () => {
    const h = harness()
    const jump = h.teleport.jump({ by: 'user', country: 'de' })
    const back = h.teleport.home('user')

    await Promise.all([jump, back])

    expect(h.calls.filter(call => call.startsWith('set:'))).toEqual(['set:country de', 'set:country no'])
    expect(h.teleport.getState().phase).toBe('idle')
  })
})

describe('recovery after a crash', () => {
  const left: TeleportRecord = {
    home: { label: 'country no', location: { country: 'no', kind: 'country' }, wasConnected: true },
    trip: { by: 'agent', city: null, country: 'de', countryName: 'Germany', reason: null, since: 1, until: 2 },
    version: 1
  }

  it('puts the location back and only the location: the gate decides about the tunnel', async () => {
    const h = harness({ constraint: { country: 'de', kind: 'country' } }, left)

    await h.teleport.recover()

    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.calls).not.toContain('connect')
    expect(h.calls).not.toContain('disconnect')
    expect(h.stored()).toBeNull()
    expect(h.teleport.getState().phase).toBe('idle')
    expect(h.events.at(-1)).toEqual({ by: 'recovery', type: 'returned' })
  })

  it('runs once, however many callers wait for it', async () => {
    const h = harness({ constraint: { country: 'de', kind: 'country' } }, left)

    await Promise.all([h.teleport.recover(), h.teleport.recover(), h.teleport.recover()])
    await h.teleport.recover()

    expect(h.calls.filter(call => call === 'set:country no')).toHaveLength(1)
  })

  it('does nothing without a record, and clears one whose home is already back', async () => {
    const none = harness()

    await none.teleport.recover()
    expect(none.calls).toEqual([])

    const already = harness({ constraint: { country: 'no', kind: 'country' } }, left)

    await already.teleport.recover()
    expect(already.calls.filter(call => call.startsWith('set:'))).toEqual([])
    expect(already.stored()).toBeNull()
  })

  it('a daemon that is not answering yet: the trip stays, due now, and the timer keeps trying', async () => {
    const h = harness({ constraint: { country: 'de', kind: 'country' } }, left)

    h.fail.set = true
    await h.teleport.recover()

    expect(h.teleport.getState().phase).toBe('away')
    expect(h.stored()).not.toBeNull()
    expect(h.liveTimers()).toHaveLength(1)

    h.fail.set = false
    await h.fireTimer()

    expect(h.constraint()).toEqual({ country: 'no', kind: 'country' })
    expect(h.stored()).toBeNull()
  })
})

describe('resolveDestination', () => {
  const relays: RelayCountry[] = [
    ...RELAYS,
    { cities: [{ code: 'nyc', name: 'New York, NY' }], code: 'us', name: 'USA' },
    { cities: [{ code: 'lon', name: 'London' }], code: 'gb', name: 'UK' }
  ]

  it('takes a code, a name, any case, any accents', () => {
    expect(resolveDestination(relays, 'DE')).toMatchObject({ city: null, country: { code: 'de' } })
    expect(resolveDestination(relays, ' germany ')).toMatchObject({ country: { code: 'de' } })
    expect(resolveDestination(relays, 'ITALY')).toMatchObject({ country: { code: 'it' } })
    expect(resolveDestination(relays, 'Nórway')).toMatchObject({ country: { code: 'no' } })
  })

  it('knows the usual other names for a country', () => {
    expect(resolveDestination(relays, 'United States')).toMatchObject({ country: { code: 'us' } })
    expect(resolveDestination(relays, 'usa')).toMatchObject({ country: { code: 'us' } })
    expect(resolveDestination(relays, 'United Kingdom')).toMatchObject({ country: { code: 'gb' } })
    expect(resolveDestination(relays, 'uk')).toMatchObject({ country: { code: 'gb' } })
  })

  it('takes a city by code or by name, and only a city that country has', () => {
    expect(resolveDestination(relays, 'de', 'fra')).toMatchObject({ city: { code: 'fra' }, country: { code: 'de' } })
    expect(resolveDestination(relays, 'de', 'Frankfurt')).toMatchObject({ city: { code: 'fra' } })
    expect(resolveDestination(relays, 'de', 'Paris')).toHaveProperty('message')
    expect(resolveDestination(relays, 'de', '')).toMatchObject({ city: null })
  })

  it('says why when it cannot, and never invents a place', () => {
    for (const input of ['', '   ', 'atlantis', 'germanyy', 42, null, undefined, { country: 'de' }]) {
      expect(resolveDestination(relays, input)).toHaveProperty('message')
    }

    expect(resolveDestination([], 'de')).toHaveProperty('message')
  })
})

describe('the trip file', () => {
  const valid = {
    home: { label: 'country no', location: { country: 'no', kind: 'country' }, wasConnected: true },
    trip: { by: 'agent', city: null, country: 'DE', countryName: 'Germany', reason: 'x', since: 1, until: 2 },
    version: 1
  }

  it('accepts a good record and normalises it', () => {
    expect(sanitizeTeleportRecord(valid)?.trip.country).toBe('de')
  })

  it('treats anything damaged as no trip, never a crash', () => {
    expect(sanitizeTeleportRecord(null)).toBeNull()
    expect(sanitizeTeleportRecord({})).toBeNull()
    expect(sanitizeTeleportRecord({ ...valid, version: 2 })).toBeNull()
    expect(sanitizeTeleportRecord({ ...valid, home: { ...valid.home, location: { kind: 'nowhere' } } })).toBeNull()
    expect(sanitizeTeleportRecord({ ...valid, home: { ...valid.home, wasConnected: 'yes' } })).toBeNull()
    expect(sanitizeTeleportRecord({ ...valid, trip: { ...valid.trip, until: 'soon' } })).toBeNull()
  })

  it('round-trips through the file, tolerates a BOM and a damaged file, and clears', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-teleport-'))

    try {
      const file = path.join(dir, 'nested', 'teleport.json')
      const store = createFileTeleportStore(file)

      expect(store.read()).toBeNull()

      store.write(valid as TeleportRecord)
      expect(store.read()?.home.location).toEqual({ country: 'no', kind: 'country' })
      expect(fs.readdirSync(path.dirname(file))).toEqual(['teleport.json'])

      fs.writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify(valid), 'utf8')
      expect(store.read()).not.toBeNull()

      fs.writeFileSync(file, '{ not json', 'utf8')
      expect(store.read()).toBeNull()

      store.write(valid as TeleportRecord)
      store.clear()
      expect(fs.existsSync(file)).toBe(false)
      store.clear()
    } finally {
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })
})
