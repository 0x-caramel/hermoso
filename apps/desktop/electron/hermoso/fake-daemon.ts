/**
 * A tiny Mullvad daemon for tests: a relay constraint, a tunnel that takes a couple of polls to come up, a
 * call log, and switches to make single operations fail. Shared by the Teleport and glue tests.
 */

import type { CliResult, MullvadStatusDetails, RelayCountry, RelayLocation } from '../mullvad'

export const RELAYS: RelayCountry[] = [
  { cities: [{ code: 'osl', name: 'Oslo' }], code: 'no', name: 'Norway' },
  { cities: [{ code: 'fra', name: 'Frankfurt' }], code: 'de', name: 'Germany' },
  { cities: [{ code: 'par', name: 'Paris' }], code: 'fr', name: 'France' },
  { cities: [{ code: 'got', name: 'Gothenburg' }], code: 'se', name: 'Sweden' },
  { cities: [{ code: 'mil', name: 'Milan' }], code: 'it', name: 'Italy' }
]

const ok: CliResult = { code: 0, stderr: '', stdout: '' }

function printed(location: RelayLocation): string {
  switch (location.kind) {
    case 'any':
      return 'any'

    case 'country':
      return `country ${location.country}`

    case 'city':
      return `city ${location.city}, ${location.country}`

    case 'hostname':
      return `city ${location.city}, ${location.country}, hostname ${location.hostname}`
  }
}

function exitHost(location: RelayLocation): string {
  switch (location.kind) {
    case 'any':
      return 'se-got-wg-001'

    case 'country':
      return `${location.country}-xxx-wg-001`

    case 'city':
      return `${location.country}-${location.city}-wg-001`

    case 'hostname':
      return location.hostname
  }
}

export interface DaemonOptions {
  connected?: boolean
  constraint?: RelayLocation
  /** `relay get` prints a form that cannot be put back (a custom list). */
  customList?: boolean
}

/** A tiny Mullvad daemon: a relay constraint, a tunnel that takes a couple of polls to come up, and a call log. */
export function fakeDaemon(options: DaemonOptions = {}) {
  const calls: string[] = []
  let constraint: RelayLocation = options.constraint ?? { country: 'no', kind: 'country' }
  let tunnel: MullvadStatusDetails['state'] = options.connected === false ? 'disconnected' : 'connected'
  let pending = 0

  const fail = { connect: false, refuse: null as null | string, relayGet: false, set: false, stuck: false }

  const details = (): MullvadStatusDetails => ({
    city: null,
    country: null,
    entryHostname: null,
    hostname: tunnel === 'connected' ? exitHost(constraint) : null,
    state: tunnel,
    tunnelInterface: tunnel === 'connected' ? 'Mullvad' : null
  })

  const client = {
    async connect() {
      calls.push('connect')

      if (fail.connect) {
        return { code: 1, stderr: 'Error: nope', stdout: '' }
      }

      tunnel = 'connecting'
      pending = 2

      return ok
    },

    async disconnect() {
      calls.push('disconnect')
      tunnel = 'disconnected'

      return ok
    },

    async listRelays() {
      calls.push('relays')

      return RELAYS
    },

    async relayGet() {
      calls.push('relay-get')

      if (fail.relayGet) {
        return { constraints: null, failure: 'daemon-unreachable' as const }
      }

      return options.customList
        ? { constraints: { location: null, locationText: 'custom list Home' }, failure: null }
        : { constraints: { location: constraint, locationText: printed(constraint) }, failure: null }
    },

    async setRelayLocation(location: RelayLocation) {
      calls.push(`set:${printed(location)}`)

      if (fail.set || (fail.refuse !== null && printed(location) === fail.refuse)) {
        return { code: 1, stderr: 'Error: Failed to connect to daemon', stdout: '' }
      }

      constraint = location

      if (tunnel === 'connected') {
        tunnel = 'connecting'
        pending = 2
      }

      return ok
    },

    async statusDetails() {
      calls.push('status')

      if (tunnel === 'connecting' && !fail.stuck) {
        pending -= 1

        if (pending <= 0) {
          tunnel = 'connected'
        }
      }

      return { details: details(), failure: null }
    }
  }

  return {
    calls,
    client,
    constraint: () => constraint,
    fail,
    tunnel: () => tunnel
  }
}
