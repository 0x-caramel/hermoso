import { describe, expect, it } from 'vitest'

import { createLedger } from './ledger'
import type { RadarConnection, RadarSample } from './radar'

const conn = (patch: Partial<RadarConnection>): RadarConnection => ({
  localAddress: '10.64.12.5',
  localPort: 50000,
  pid: 200,
  process: 'python.exe',
  remoteAddress: '142.250.74.46',
  remotePort: 443,
  route: 'tunnel',
  state: 'ESTABLISHED',
  ...patch
})

const sample = (at: number, connections: RadarConnection[] = [], error: null | string = null): RadarSample => ({
  at,
  connections,
  error,
  tunnelAddresses: ['10.64.12.5']
})

const calm = { frozen: false }
const frozen = { frozen: true }

describe('counting what the radar saw', () => {
  it('counts each distinct connection once, however many looks it is seen in', () => {
    const ledger = createLedger(() => 1000)

    ledger.record(sample(1000, [conn({})]), calm)
    ledger.record(sample(4000, [conn({}), conn({ localPort: 50001 })]), calm)
    ledger.record(sample(7000, [conn({}), conn({ localPort: 50001 })]), calm)

    expect(ledger.summary()).toMatchObject({ byRoute: { tunnel: 2 }, samples: 3, seen: 2 })
  })

  it('keeps every connection that left outside the tunnel, with who and where', () => {
    const ledger = createLedger()

    ledger.record(
      sample(5000, [
        conn({
          localAddress: '192.168.1.20',
          pid: 300,
          process: 'curl.exe',
          remoteAddress: '93.184.216.34',
          route: 'outside'
        })
      ]),
      calm
    )

    expect(ledger.summary().outside).toEqual([
      { at: 5000, pid: 300, port: 443, process: 'curl.exe', remote: '93.184.216.34' }
    ])
    expect(ledger.summary().byRoute.outside).toBe(1)
  })

  it('a look that could not read the connections is counted as missed, not as clean', () => {
    const ledger = createLedger()

    ledger.record(sample(1000, [], 'netstat failed'), calm)
    expect(ledger.summary()).toMatchObject({ missed: 1, samples: 0 })
  })

  it('adds up the time the agent stood frozen, but not across a long gap', () => {
    const ledger = createLedger()

    ledger.record(sample(0), calm)
    ledger.record(sample(3000), frozen)
    ledger.record(sample(6000), frozen)
    ledger.record(sample(9000), calm)
    expect(ledger.summary().frozenSeconds).toBe(6)

    // the app slept for ten minutes while "frozen": that is not ten minutes of a frozen agent
    ledger.record(sample(10_000), frozen)
    ledger.record(sample(610_000), frozen)
    expect(ledger.summary().frozenSeconds).toBe(6)
  })

  it('can start again', () => {
    const ledger = createLedger()

    ledger.record(sample(1000, [conn({ route: 'outside' })]), frozen)
    ledger.reset()
    expect(ledger.summary()).toMatchObject({
      byRoute: { lan: 0, loopback: 0, outside: 0, tunnel: 0 },
      outside: [],
      samples: 0,
      seen: 0
    })
  })

  it('caps the list of outside connections so a flood cannot grow it for ever', () => {
    const ledger = createLedger()

    for (let i = 0; i < 150; i++) {
      ledger.record(sample(1000 + i, [conn({ localPort: 1000 + i, route: 'outside' })]), calm)
    }

    expect(ledger.summary().outside).toHaveLength(100)
    expect(ledger.summary().byRoute.outside).toBe(150)
  })
})

describe('the report', () => {
  const context = { exit: 'Norway, Oslo', lockdown: false, now: Date.UTC(2026, 9, 17, 12, 0, 0), vpnRequired: true }

  it('says so plainly when nothing left outside, with the conditions and the limits', () => {
    const ledger = createLedger(() => Date.UTC(2026, 9, 17, 11, 0, 0))

    ledger.record(
      sample(Date.UTC(2026, 9, 17, 11, 30, 0), [
        conn({}),
        conn({ localPort: 2, remoteAddress: '127.0.0.1', route: 'loopback' })
      ]),
      calm
    )

    const text = ledger.report({ ...context, appVersion: '2026.10.17' })

    expect(text).toContain('# Hermoso shield report')
    expect(text).toContain('2 connections observed. None left outside the VPN tunnel.')
    expect(text).toContain('- through the tunnel: 1')
    expect(text).toContain('- to this computer (loopback): 1')
    expect(text).toContain('Tunnel exit: Norway, Oslo')
    expect(text).toContain('"Always require VPN"')
    expect(text).toContain('off')
    expect(text).toContain('does not prove')
    expect(text).toContain('not "no packet ever left"')
    expect(text).toContain('Hermoso 2026.10.17')
    expect(text).not.toContain('Connections outside the tunnel')
  })

  it('lists what left outside, and never calls that clean', () => {
    const ledger = createLedger()

    ledger.record(
      sample(Date.UTC(2026, 9, 17, 11, 30, 0), [
        conn({ process: 'curl.exe', remoteAddress: '93.184.216.34', route: 'outside' })
      ]),
      calm
    )

    const text = ledger.report(context)

    expect(text).toContain('1 connections observed. 1 left OUTSIDE the VPN tunnel.')
    expect(text).toContain('### Connections outside the tunnel')
    expect(text).toContain('curl.exe (pid 200) -> 93.184.216.34:443')
    expect(text).not.toContain('None left outside')
  })

  it('says it has seen nothing yet, and what it does not know', () => {
    const text = createLedger().report({ exit: null, lockdown: null, vpnRequired: false })

    expect(text).toContain('No connections were observed yet.')
    expect(text).toContain('Tunnel exit: not connected')
    expect(text).toContain('Always require VPN"')
    expect(text).toContain('unknown')
    expect(text).toContain('VPN required by the settings: no')
  })
})
