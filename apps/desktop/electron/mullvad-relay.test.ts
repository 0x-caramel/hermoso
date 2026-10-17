import { describe, expect, it, vi } from 'vitest'

import {
  type CliResult,
  createMullvadClient,
  parseMullvadStatusJson,
  parseRelayConstraints,
  relayHostCountry,
  relayLocationArgs,
  relayLocationFromCodes,
  sameRelayLocation
} from './mullvad'

describe('parseRelayConstraints (real `mullvad relay get`, mullvad-cli 2026.5)', () => {
  const printed = (location: string) =>
    [
      'Generic constraints',
      `    Location:               ${location}`,
      '    Provider(s):            any',
      '    Ownership:              any',
      'WireGuard constraints',
      '    IP protocol:            any',
      '    Multihop state:         disabled',
      '    Multihop entry:         country it',
      ''
    ].join('\r\n')

  it('reads every form the CLI prints for the exit location', () => {
    expect(parseRelayConstraints(printed('any'))).toEqual({ location: { kind: 'any' }, locationText: 'any' })

    expect(parseRelayConstraints(printed('country no'))).toEqual({
      location: { country: 'no', kind: 'country' },
      locationText: 'country no'
    })

    expect(parseRelayConstraints(printed('city got, se'))).toEqual({
      location: { city: 'got', country: 'se', kind: 'city' },
      locationText: 'city got, se'
    })

    expect(parseRelayConstraints(printed('city got, se, hostname se-got-wg-004'))).toEqual({
      location: { city: 'got', country: 'se', hostname: 'se-got-wg-004', kind: 'hostname' },
      locationText: 'city got, se, hostname se-got-wg-004'
    })
  })

  it('reads only the exit location, never the multihop entry line', () => {
    expect(parseRelayConstraints(printed('country no'))?.location).toEqual({ country: 'no', kind: 'country' })
  })

  it('says "not restorable" (location null) for a form it cannot put back, instead of guessing', () => {
    expect(parseRelayConstraints(printed('custom list Home'))).toEqual({
      location: null,
      locationText: 'custom list Home'
    })

    expect(parseRelayConstraints(printed('city got, se, hostname nonsense'))?.location).toBeNull()
  })

  it('is null when the text is not a relay answer at all', () => {
    expect(parseRelayConstraints('')).toBeNull()
    expect(parseRelayConstraints('Error: daemon not running')).toBeNull()
  })
})

describe('relay locations', () => {
  it('turns a location back into the arguments of `relay set location`', () => {
    expect(relayLocationArgs({ kind: 'any' })).toEqual(['any'])
    expect(relayLocationArgs({ country: 'no', kind: 'country' })).toEqual(['no'])
    expect(relayLocationArgs({ city: 'got', country: 'se', kind: 'city' })).toEqual(['se', 'got'])

    expect(relayLocationArgs({ city: 'got', country: 'se', hostname: 'se-got-wg-004', kind: 'hostname' })).toEqual([
      'se',
      'got',
      'se-got-wg-004'
    ])
  })

  it('what the CLI printed is what gets set back (round trip through the parser)', () => {
    const cases: [string, string[]][] = [
      ['any', ['any']],
      ['country no', ['no']],
      ['city got, se', ['se', 'got']],
      ['city got, se, hostname se-got-wg-004', ['se', 'got', 'se-got-wg-004']]
    ]

    for (const [text, args] of cases) {
      const parsed = parseRelayConstraints(`    Location:               ${text}`)?.location

      expect(parsed).not.toBeNull()
      expect(relayLocationArgs(parsed!)).toEqual(args)
    }
  })

  it('builds a location from codes and refuses malformed ones', () => {
    expect(relayLocationFromCodes('DE')).toEqual({ country: 'de', kind: 'country' })
    expect(relayLocationFromCodes(' se ', 'GOT')).toEqual({ city: 'got', country: 'se', kind: 'city' })
    expect(relayLocationFromCodes('germany')).toBeNull()
    expect(relayLocationFromCodes('de', 'x')).toBeNull()
    expect(relayLocationFromCodes('', null)).toBeNull()
  })

  it('compares by what would be set', () => {
    expect(sameRelayLocation({ country: 'no', kind: 'country' }, { country: 'no', kind: 'country' })).toBe(true)
    expect(sameRelayLocation({ country: 'no', kind: 'country' }, { country: 'se', kind: 'country' })).toBe(false)

    expect(sameRelayLocation({ country: 'no', kind: 'country' }, { city: 'osl', country: 'no', kind: 'city' })).toBe(
      false
    )

    expect(sameRelayLocation(null, null)).toBe(false)
  })
})

describe('parseMullvadStatusJson (real `mullvad status --json`)', () => {
  const connected = JSON.stringify({
    details: {
      endpoint: {
        address: '203.0.113.9:15255',
        daita: false,
        entry_endpoint: null,
        obfuscation: null,
        protocol: 'udp',
        quantum_resistant: true,
        tunnel_interface: 'Mullvad'
      },
      feature_indicators: ['LanSharing', 'QuantumResistance'],
      location: {
        city: 'Oslo',
        country: 'Norway',
        entry_city: null,
        entry_country: null,
        entry_hostname: null,
        hostname: 'no-osl-wg-001',
        ipv4: '203.0.113.7',
        ipv6: null,
        latitude: 59.916667,
        longitude: 10.75,
        mullvad_exit_ip: true
      }
    },
    state: 'connected'
  })

  it('reads the exit relay, the place and the tunnel interface', () => {
    expect(parseMullvadStatusJson(connected)).toEqual({
      city: 'Oslo',
      country: 'Norway',
      entryHostname: null,
      hostname: 'no-osl-wg-001',
      state: 'connected',
      tunnelInterface: 'Mullvad'
    })
  })

  it('never carries an IP address', () => {
    expect(JSON.stringify(parseMullvadStatusJson(connected))).not.toContain('203.0.113')
  })

  it('has no exit relay or interface unless the tunnel is up', () => {
    const disconnected = JSON.stringify({
      details: { location: { city: 'Naples', country: 'Italy', hostname: null, ipv4: '203.0.113.7' } },
      state: 'disconnected'
    })

    expect(parseMullvadStatusJson(disconnected)).toEqual({
      city: 'Naples',
      country: 'Italy',
      entryHostname: null,
      hostname: null,
      state: 'disconnected',
      tunnelInterface: null
    })
  })

  it('reads an empty answer as a tunnel on its way up, and anything else as unknown', () => {
    expect(parseMullvadStatusJson('').state).toBe('connecting')
    expect(parseMullvadStatusJson('   \n').state).toBe('connecting')
    expect(parseMullvadStatusJson('not json').state).toBe('unknown')
    expect(parseMullvadStatusJson('{"state":"on-fire"}').state).toBe('unknown')
    expect(parseMullvadStatusJson('{"state":"error","details":{}}').state).toBe('blocked')
  })

  it('names the country an exit relay hostname belongs to', () => {
    expect(relayHostCountry('no-osl-wg-001')).toBe('no')
    expect(relayHostCountry('DE-FRA-WG-004')).toBe('de')
    expect(relayHostCountry(null)).toBeNull()
    expect(relayHostCountry('mullvad')).toBeNull()
  })
})

describe('client: relay get / set / status --json', () => {
  const cli = 'C:\\mullvad.exe'

  const make = (run: (file: string, args: string[]) => Promise<CliResult>) =>
    createMullvadClient({
      env: { HERMES_MULLVAD_CLI: cli },
      exists: candidate => candidate === cli,
      platform: 'win32',
      run
    })

  it('reads the relay constraints and puts an exact location back', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => ({
      code: 0,
      stderr: '',
      stdout:
        args[0] === 'relay' && args[1] === 'get' ? 'Generic constraints\n    Location:               country no\n' : ''
    }))

    const client = make(run)

    expect((await client.relayGet()).constraints?.location).toEqual({ country: 'no', kind: 'country' })

    await client.setRelayLocation({ city: 'got', country: 'se', hostname: 'se-got-wg-004', kind: 'hostname' })
    await client.setRelayLocation({ kind: 'any' })

    expect(run.mock.calls.map(call => call[1])).toEqual([
      ['relay', 'get'],
      ['relay', 'set', 'location', 'se', 'got', 'se-got-wg-004'],
      ['relay', 'set', 'location', 'any']
    ])
  })

  it('classifies a relay get that failed, or that printed something else', async () => {
    const down = make(async () => ({ code: 1, stderr: 'Error: Failed to connect to daemon', stdout: '' }))

    expect(await down.relayGet()).toEqual({ constraints: null, failure: 'daemon-unreachable' })

    const odd = make(async () => ({ code: 0, stderr: '', stdout: 'Something else\n' }))

    expect(await odd.relayGet()).toEqual({ constraints: null, failure: 'failed' })
  })

  it('asks for the JSON status', async () => {
    const run = vi.fn(async (_file: string, _args: string[]) => ({
      code: 0,
      stderr: '',
      stdout: '{"state":"disconnected"}'
    }))

    expect((await make(run).statusDetails()).details?.state).toBe('disconnected')
    expect(run.mock.calls[0][1]).toEqual(['status', '--json'])
  })
})
