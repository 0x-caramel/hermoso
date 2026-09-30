import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  classifyCliFailure,
  type CliResult,
  createMullvadClient,
  defaultCliRunner,
  mullvadAppCandidates,
  mullvadCliCandidates,
  parseAccountExpiry,
  parseAccountLoggedIn,
  parseMullvadStatus,
  parseRelayList
} from './mullvad'

describe('parseMullvadStatus', () => {
  it('reads the leading state word across CLI dialects', () => {
    expect(parseMullvadStatus('Disconnected\n').state).toBe('disconnected')
    expect(parseMullvadStatus('Disconnecting...\n').state).toBe('disconnecting')
    expect(parseMullvadStatus('Connecting to WireGuard 1.2.3.4:51820/UDP...\n').state).toBe('connecting')
    expect(parseMullvadStatus('Tunnel status: Connected to se-got-wg-001 in Gothenburg, Sweden\r\n').state).toBe(
      'connected'
    )
  })

  it('does not mistake Disconnected for Connected', () => {
    expect(parseMullvadStatus('Disconnected').state).toBe('disconnected')
    expect(parseMullvadStatus('  disconnecting').state).toBe('disconnecting')
  })

  it('extracts location and relay from the legacy one-liner (city, country)', () => {
    expect(parseMullvadStatus('Connected to se-got-wg-001 in Gothenburg, Sweden')).toEqual({
      detail: null,
      location: { city: 'Gothenburg', country: 'Sweden' },
      relay: 'se-got-wg-001',
      state: 'connected'
    })
  })

  it('extracts location and relay from the multi-line dialect (country, city)', () => {
    const output = [
      'Connected',
      '    Relay:                se-sto-wg-004',
      '    Features:             Quantum Resistance',
      '    Visible location:     Sweden, Stockholm. IPv4: 203.0.113.7'
    ].join('\n')

    expect(parseMullvadStatus(output)).toEqual({
      detail: null,
      location: { city: 'Stockholm', country: 'Sweden' },
      relay: 'se-sto-wg-004',
      state: 'connected'
    })
  })

  it('never puts the visible IP into the parsed location', () => {
    const parsed = parseMullvadStatus('Connected\n    Visible location:     Germany. IPv4: 203.0.113.7')

    expect(parsed.location).toEqual({ city: null, country: 'Germany' })
    expect(JSON.stringify(parsed)).not.toContain('203.0.113.7')
  })

  it('reports Blocked/Error as blocked with the reason', () => {
    expect(parseMullvadStatus('Blocked: Failed to apply firewall policy')).toEqual({
      detail: 'Failed to apply firewall policy',
      location: null,
      relay: null,
      state: 'blocked'
    })
    expect(parseMullvadStatus('Error: no matching relay').state).toBe('blocked')
  })

  it('reads empty output as a tunnel on its way up, and unrecognised text as unknown', () => {
    // mullvad-cli prints nothing for the seconds a relay change reconnects the tunnel.
    expect(parseMullvadStatus('').state).toBe('connecting')
    expect(parseMullvadStatus('\n  \r\n').state).toBe('connecting')
    expect(parseMullvadStatus('something new the CLI invented').state).toBe('unknown')
  })
})

describe('parseAccountLoggedIn', () => {
  it('detects a logged-in and a logged-out device', () => {
    expect(parseAccountLoggedIn('Mullvad account: 1234 5678 9012 3456\nExpires at: 2030-01-01')).toBe(true)
    expect(parseAccountLoggedIn('Not logged in on any account')).toBe(false)
  })

  it('stays undecided on an output it does not recognise', () => {
    expect(parseAccountLoggedIn('')).toBeNull()
    expect(parseAccountLoggedIn('Some future wording')).toBeNull()
  })
})

describe('parseRelayList', () => {
  const output = [
    'Albania (al)',
    '\tTirana (tia) @ 41.33°N, 19.82°E',
    '\t\tal-tia-wg-001 (31.171.153.67, 2a04:27c0:0:1::f001) - WireGuard, hosted by Blix (rented)',
    'Germany (de)',
    '\tBerlin (ber) @ 52.52°N, 13.40°E',
    '\t\tde-ber-wg-001 (185.213.155.73, 2a03:1b20:6:f011::a01f) - WireGuard, hosted by Blix (rented)',
    '\tFrankfurt (fra) @ 50.11°N, 8.68°E',
    '\t\tde-fra-wg-001 (185.213.154.66, 2a03:1b20:5:f011::a01f) - WireGuard, hosted by 31173 (rented)',
    ''
  ].join('\r\n')

  it('groups cities under their country with lowercase codes', () => {
    expect(parseRelayList(output)).toEqual([
      { cities: [{ code: 'tia', name: 'Tirana' }], code: 'al', name: 'Albania' },
      {
        cities: [
          { code: 'ber', name: 'Berlin' },
          { code: 'fra', name: 'Frankfurt' }
        ],
        code: 'de',
        name: 'Germany'
      }
    ])
  })

  it('never reads a relay row as a city', () => {
    const cities = parseRelayList(output).flatMap(country => country.cities.map(city => city.code))

    expect(cities).not.toContain('31.171.153.67')
    expect(cities.every(code => /^[a-z0-9]{2,5}$/.test(code))).toBe(true)
  })

  it('yields nothing for output it cannot read', () => {
    expect(parseRelayList('')).toEqual([])
    expect(parseRelayList('Failed to connect to daemon')).toEqual([])
  })
})

describe('classifyCliFailure', () => {
  const base: CliResult = { code: 1, stderr: '', stdout: '' }

  it('maps spawn outcomes and daemon errors to a reason', () => {
    expect(classifyCliFailure({ ...base, code: null, error: 'missing' })).toBe('not-installed')
    expect(classifyCliFailure({ ...base, code: null, error: 'timeout' })).toBe('timeout')
    expect(classifyCliFailure({ ...base, stderr: 'Error: Failed to connect to daemon' })).toBe('daemon-unreachable')
    expect(classifyCliFailure({ ...base, stderr: 'Error: something else' })).toBe('failed')
  })
})

describe('CLI discovery', () => {
  it('looks on PATH, then in the installer location, on Windows', () => {
    const env = { PATH: 'C:\\bin;C:\\tools', ProgramFiles: 'C:\\Program Files' }

    const candidates = mullvadCliCandidates(env, 'win32')

    expect(candidates[0]).toBe(path.join('C:\\bin', 'mullvad.exe'))
    expect(candidates).toContain(path.join('C:\\Program Files', 'Mullvad VPN', 'resources', 'mullvad.exe'))
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('treats an explicit override as the only candidate', () => {
    const env = {
      HERMES_MULLVAD_CLI: 'C:\\override\\mullvad.exe',
      PATH: 'C:\\bin',
      ProgramFiles: 'C:\\Program Files'
    }

    expect(mullvadCliCandidates(env, 'win32')).toEqual(['C:\\override\\mullvad.exe'])
  })

  it('finds the GUI where the installer puts it', () => {
    expect(mullvadAppCandidates({ ProgramFiles: 'C:\\Program Files' }, 'win32')).toContain(
      path.join('C:\\Program Files', 'Mullvad VPN', 'Mullvad VPN.exe')
    )
  })

  it('reports not-installed without spawning anything when no candidate exists', async () => {
    const run = vi.fn()
    const client = createMullvadClient({ env: { PATH: '' }, exists: () => false, platform: 'win32', run })

    expect(client.findCli()).toBeNull()
    expect(await client.status()).toEqual({ failure: 'not-installed', status: null })
    expect(await client.account()).toEqual({ expiresAt: null, loggedIn: null })
    expect(await client.listRelays()).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })
})

describe('client commands', () => {
  const cli = 'C:\\mullvad.exe'

  const make = (run: (file: string, args: string[]) => Promise<CliResult>) =>
    createMullvadClient({
      env: { HERMES_MULLVAD_CLI: cli },
      exists: candidate => candidate === cli,
      platform: 'win32',
      run
    })

  it('runs the discovered CLI with the right arguments', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => ({
      code: 0,
      stderr: '',
      stdout: args[0] === 'status' ? 'Disconnected\n' : ''
    }))

    const client = make(run)

    expect(await client.status()).toEqual({
      failure: null,
      status: { detail: null, location: null, relay: null, state: 'disconnected' }
    })

    await client.connect()
    await client.disconnect()
    await client.setLocation('se', 'got')
    await client.setLocation('de', null)

    expect(run.mock.calls.map(call => [call[0], ...call[1]])).toEqual([
      [cli, 'status'],
      [cli, 'connect'],
      [cli, 'disconnect'],
      [cli, 'relay', 'set', 'location', 'se', 'got'],
      [cli, 'relay', 'set', 'location', 'de']
    ])
  })

  it('surfaces a non-zero exit as a classified failure', async () => {
    const client = make(async () => ({ code: 1, stderr: 'Error: Failed to connect to daemon', stdout: '' }))

    expect(await client.status()).toEqual({ failure: 'daemon-unreachable', status: null })
  })
})

describe('defaultCliRunner', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-mullvad-'))

  const write = (name: string, body: string) => {
    const file = path.join(scratch, name)
    fs.writeFileSync(file, body, 'utf8')

    return file
  }

  it('runs a scripted stand-in (HERMES_MULLVAD_CLI=*.mjs) with the current runtime', async () => {
    const script = write('cli.mjs', "console.log('Disconnected'); console.error(process.argv.slice(2).join(' '))")

    expect(await defaultCliRunner(script, ['status', '-v'], { timeoutMs: 10_000 })).toEqual({
      code: 0,
      stderr: 'status -v\n',
      stdout: 'Disconnected\n'
    })
  })

  it('reports a non-zero exit with its stderr', async () => {
    const script = write('fail.mjs', "console.error('boom'); process.exit(3)")
    const result = await defaultCliRunner(script, [], { timeoutMs: 10_000 })

    expect(result.code).toBe(3)
    expect(result.stderr).toContain('boom')
    expect(result.error).toBeUndefined()
  })

  it('reports a missing binary as missing', async () => {
    const result = await defaultCliRunner(path.join(scratch, 'nope', 'mullvad-does-not-exist'), [], {
      timeoutMs: 10_000
    })

    expect(result).toMatchObject({ code: null, error: 'missing' })
  })

  it('kills a call that outlives its timeout', async () => {
    const script = write('hang.mjs', 'setInterval(() => {}, 1000)')

    expect(await defaultCliRunner(script, [], { timeoutMs: 300 })).toMatchObject({ code: null, error: 'timeout' })
  })
})

// Captured from a real Mullvad (mullvad-cli 2026.5) on Windows; the visible IP is replaced by a
// documentation address and the account number by a placeholder.
describe('real mullvad-cli 2026.5 output', () => {
  const disconnected = 'Disconnected\n    Visible location:       Italy, Naples. IPv4: 203.0.113.7\n'

  const connecting = [
    'Connecting',
    '    Relay:                  it-mil-wg-201',
    '    Features:               Quantum Resistance',
    '    Visible location:       Italy, Milan',
    ''
  ].join('\n')

  const connected = [
    'Connected',
    '    Relay:                  it-mil-wg-003',
    '    Features:               Quantum Resistance',
    '    Visible location:       Italy, Milan',
    ''
  ].join('\n')

  it('reads a disconnected daemon', () => {
    expect(parseMullvadStatus(disconnected)).toEqual({
      detail: null,
      location: { city: 'Naples', country: 'Italy' },
      relay: null,
      state: 'disconnected'
    })
  })

  it('reads the transitional and connected states', () => {
    expect(parseMullvadStatus(connecting)).toMatchObject({ relay: 'it-mil-wg-201', state: 'connecting' })
    expect(parseMullvadStatus(connected)).toEqual({
      detail: null,
      location: { city: 'Milan', country: 'Italy' },
      relay: 'it-mil-wg-003',
      state: 'connected'
    })
    expect(parseMullvadStatus('Disconnecting\n').state).toBe('disconnecting')
  })

  it('reads the verbose connected form too', () => {
    const verbose = [
      'Connected',
      '    Relay:                  it-mil-wg-003 (178.249.211.92:6600/UDP)',
      '    Features:               Quantum Resistance',
      '    Tunnel interface:       Mullvad',
      '    Visible location:       Italy, Milan. IPv4: 203.0.113.9',
      ''
    ].join('\n')

    expect(parseMullvadStatus(verbose)).toMatchObject({
      location: { city: 'Milan', country: 'Italy' },
      relay: 'it-mil-wg-003',
      state: 'connected'
    })
  })

  it('reads a blocked daemon', () => {
    expect(parseMullvadStatus('Blocked: Authentication with remote server failed: invalid account\n')).toMatchObject({
      detail: 'Authentication with remote server failed: invalid account',
      state: 'blocked'
    })
  })

  it('reads the account output and the logged-out answer', () => {
    const account = [
      'Mullvad account:    1234 5678 9012 3456',
      'Expires at:         2030-01-01 00:00:00 +01:00',
      'Device name:        Great Viper',
      ''
    ].join('\n')

    expect(parseAccountLoggedIn(account)).toBe(true)
    expect(parseAccountLoggedIn('Not logged in on any account\n')).toBe(false)
  })

  it('reads a relay list, including non-ASCII city names', () => {
    const relays = [
      'Italy (it)',
      '\tMilan (mil) @ 45.46667°N, 9.20000°W',
      '\t\tit-mil-wg-001 (178.249.211.66, 2a02:6ea0:d509:1::a09f) - hosted by DataPacket (rented)',
      '\tPalermo (pmo) @ 38.11569°N, 13.36127°W',
      '\t\tit-pmo-wg-001 (149.22.91.66, 2a02:6ea0:4f00::f001) - hosted by DataPacket (rented)',
      '',
      'Sweden (se)',
      '\tMalmö (mma) @ 55.60587°N, 13.00073°W',
      '\t\tse-mma-wg-001 (185.65.135.66, 2a03:1b20:2:f011::a01f) - hosted by Blix (rented)',
      ''
    ].join('\n')

    expect(parseRelayList(relays)).toEqual([
      {
        cities: [
          { code: 'mil', name: 'Milan' },
          { code: 'pmo', name: 'Palermo' }
        ],
        code: 'it',
        name: 'Italy'
      },
      { cities: [{ code: 'mma', name: 'Malmö' }], code: 'se', name: 'Sweden' }
    ])
  })
})

describe('account state over a failing CLI call', () => {
  const cli = 'C:\\mullvad.exe'

  const make = (result: CliResult) =>
    createMullvadClient({
      env: { HERMES_MULLVAD_CLI: cli },
      exists: candidate => candidate === cli,
      platform: 'win32',
      run: async () => result
    })

  it('hears "not logged in" whatever the exit code and stream', async () => {
    const stdout = await make({ code: 0, stderr: '', stdout: 'Not logged in on any account\n' }).account()
    const stderr = await make({ code: 1, stderr: 'Not logged in on any account\n', stdout: '' }).account()

    expect(stdout.loggedIn).toBe(false)
    expect(stderr.loggedIn).toBe(false)
  })

  it('never reads a failing call as a logged-in, unexpired account', async () => {
    const failing = await make({
      code: 1,
      stderr: 'boom',
      stdout: 'Mullvad account: 1234\nExpires at: 2030-01-01 00:00:00 UTC'
    }).account()

    expect(failing).toEqual({ expiresAt: null, loggedIn: null })
  })

  it('reads login state and expiry from a good answer', async () => {
    const account = await make({
      code: 0,
      stderr: '',
      stdout:
        'Mullvad account:    1234 5678\nExpires at:         2026-10-31 04:31:42 +01:00\nDevice name:        Great Viper\n'
    }).account()

    expect(account.loggedIn).toBe(true)
    expect(account.expiresAt?.toISOString()).toBe('2026-10-31T03:31:42.000Z')
  })
})

describe('account expiry and revoked devices', () => {
  it('reads the expiry in every zone spelling the CLI has used', () => {
    expect(parseAccountExpiry('Expires at:         2026-10-31 04:31:42 +01:00')?.toISOString()).toBe(
      '2026-10-31T03:31:42.000Z'
    )
    expect(parseAccountExpiry('Expires at     : 2022-06-07 07:13:33 UTC')?.toISOString()).toBe(
      '2022-06-07T07:13:33.000Z'
    )
    expect(parseAccountExpiry('Expires at: 2026-01-02 03:04:05 -0500')?.toISOString()).toBe('2026-01-02T08:04:05.000Z')
    expect(parseAccountExpiry('Expires at: 2026-01-02 03:04:05')?.toISOString()).toBe('2026-01-02T03:04:05.000Z')
  })

  it('never invents an expiry', () => {
    expect(parseAccountExpiry('')).toBeNull()
    expect(parseAccountExpiry('Mullvad account: 1234')).toBeNull()
    expect(parseAccountExpiry('Expires at: soon')).toBeNull()
    expect(parseAccountExpiry('Expires at: 2026-13-45 99:99:99 UTC')).toBeNull()
  })

  it('treats a revoked device as logged out, since signing in again is the remedy', () => {
    expect(parseAccountLoggedIn('Warning: This device has been revoked\nMullvad account: 1234')).toBe(false)
  })
})
