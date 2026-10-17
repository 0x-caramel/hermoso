import { describe, expect, it, vi } from 'vitest'

import {
  classifyRoute,
  createRadar,
  descendants,
  isLoopback,
  isPrivate,
  judgeConnections,
  parseNetstat,
  parseProcessList
} from './radar'

// `netstat -ano -p tcp` on Windows (a few of the shapes it prints, including IPv6 and an Italian header)
const NETSTAT = [
  '',
  'Connessioni attive',
  '',
  '  Proto  Indirizzo locale       Indirizzo esterno      Stato           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1088',
  '  TCP    10.64.12.5:51234       142.250.74.46:443      ESTABLISHED     200',
  '  TCP    192.168.1.20:51300     93.184.216.34:443      ESTABLISHED     200',
  '  TCP    127.0.0.1:61000        127.0.0.1:18434        ESTABLISHED     300',
  '  TCP    192.168.1.20:51400     192.168.1.1:80         ESTABLISHED     300',
  '  TCP    [::1]:5000             [::1]:49701            ESTABLISHED     300',
  '  TCP    [fe80::1%12]:51500     [fe80::2%12]:445       ESTABLISHED     400',
  '  TCP    10.64.12.5:51600       151.101.1.69:443       SYN_SENT        300',
  '  TCP    10.64.12.5:51700       151.101.1.69:443       TIME_WAIT       0',
  '  TCP    192.168.1.20:52000     8.8.8.8:53             ESTABLISHED     999',
  ''
].join('\r\n')

// `Get-CimInstance Win32_Process`: 100 is the app, 200 its network service, 300 the backend, 310 a tool it ran
const PROCESSES = [
  '100,1,Hermoso.exe',
  '200,100,Hermoso.exe',
  '300,100,python.exe',
  '310,300,curl.exe',
  '999,1,chrome.exe',
  '400,1,svchost.exe'
].join('\r\n')

const TUNNEL = new Set(['10.64.12.5'])

describe('reading netstat', () => {
  it('reads TCP lines in any language, IPv4 and IPv6, and ignores everything else', () => {
    const parsed = parseNetstat(NETSTAT)

    expect(parsed).toHaveLength(10)
    expect(parsed[1]).toEqual({
      local: { address: '10.64.12.5', port: 51234 },
      pid: 200,
      remote: { address: '142.250.74.46', port: 443 },
      state: 'ESTABLISHED'
    })
    expect(parsed.find(c => c.pid === 400)?.local.address).toBe('fe80::1')
    expect(parsed.find(c => c.local.address === '::1')?.remote.port).toBe(49701)
  })

  it('a text that is not netstat gives nothing', () => {
    expect(parseNetstat('')).toEqual([])
    expect(parseNetstat('UDP 0.0.0.0:53 *:* 1234')).toEqual([])
    expect(parseNetstat('TCP garbage')).toEqual([])
  })
})

describe('the process tree', () => {
  it('reads pid,ppid,name lines', () => {
    const list = parseProcessList(PROCESSES)

    expect(list.get(310)).toEqual({ name: 'curl.exe', parent: 300 })
    expect(list.size).toBe(6)
    expect(parseProcessList('nonsense\n,,').size).toBe(0)
  })

  it('finds everything below the app and nothing else', () => {
    const list = parseProcessList(PROCESSES)

    expect([...descendants(list, [100])].sort()).toEqual([100, 200, 300, 310])
    expect([...descendants(list, [999])]).toEqual([999])
    // a cycle (a reused pid) does not loop forever
    expect(
      descendants(
        new Map([
          [1, { name: 'a', parent: 2 }],
          [2, { name: 'b', parent: 1 }]
        ]),
        [1]
      ).size
    ).toBe(2)
  })
})

describe('judging a connection', () => {
  it('knows loopback and private addresses', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1']) {
      expect(isLoopback(address), address).toBe(true)
    }

    for (const address of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      'fe80::1',
      'fd12:3456::1'
    ]) {
      expect(isPrivate(address), address).toBe(true)
    }

    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '151.101.1.69', '2a03:1b20::1']) {
      expect(isPrivate(address), address).toBe(false)
    }
  })

  it('a connection from the tunnel address leaves through the tunnel; from any other address to a public host it is outside', () => {
    expect(classifyRoute('10.64.12.5', '142.250.74.46', TUNNEL)).toBe('tunnel')
    expect(classifyRoute('192.168.1.20', '93.184.216.34', TUNNEL)).toBe('outside')
    expect(classifyRoute('127.0.0.1', '127.0.0.1', TUNNEL)).toBe('loopback')
    expect(classifyRoute('192.168.1.20', '192.168.1.1', TUNNEL)).toBe('lan')
    // with no tunnel at all, a public connection is outside
    expect(classifyRoute('192.168.1.20', '93.184.216.34', new Set())).toBe('outside')
  })

  it("keeps only the app's own connections that are live, and says which way each goes", () => {
    const list = parseProcessList(PROCESSES)
    const judged = judgeConnections(parseNetstat(NETSTAT), descendants(list, [100]), list, TUNNEL)

    expect(judged.map(c => [c.pid, c.process, c.remoteAddress, c.route])).toEqual([
      [200, 'Hermoso.exe', '142.250.74.46', 'tunnel'],
      [200, 'Hermoso.exe', '93.184.216.34', 'outside'],
      [300, 'python.exe', '127.0.0.1', 'loopback'],
      [300, 'python.exe', '192.168.1.1', 'lan'],
      [300, 'python.exe', '::1', 'loopback'],
      [300, 'python.exe', '151.101.1.69', 'tunnel']
    ])

    // a stranger (pid 999) and listeners/closed sockets are not the app's traffic
    expect(judged.some(c => c.pid === 999 || c.state === 'TIME_WAIT')).toBe(false)
  })
})

describe('looking at the machine', () => {
  const make = (
    options: { netstat?: { code: number; stdout: string }; processes?: { code: number; stdout: string } } = {}
  ) => {
    const exec = vi.fn(async (file: string) =>
      file === 'netstat.exe'
        ? (options.netstat ?? { code: 0, stdout: NETSTAT })
        : (options.processes ?? { code: 0, stdout: PROCESSES })
    )

    let clock = 1_000

    const radar = createRadar({
      exec,
      interfaces: () => ({ Mullvad: [{ address: '10.64.12.5' }], Ethernet: [{ address: '192.168.1.20' }] }),
      now: () => (clock += 1),
      roots: () => [100],
      tunnelInterface: () => 'Mullvad'
    })

    return { exec, radar, tick: (ms: number) => (clock += ms) }
  }

  it("samples the app's connections with the tunnel's own addresses", async () => {
    const { radar } = make()
    const sample = await radar.sample()

    expect(sample.error).toBeNull()
    expect(sample.tunnelAddresses).toEqual(['10.64.12.5'])
    expect(sample.connections).toHaveLength(6)
    expect(sample.connections.filter(c => c.route === 'outside')).toHaveLength(1)
  })

  it('with no tunnel interface, nothing counts as through the tunnel', async () => {
    const exec = vi.fn(async (file: string) =>
      file === 'netstat.exe' ? { code: 0, stdout: NETSTAT } : { code: 0, stdout: PROCESSES }
    )
    const radar = createRadar({ exec, interfaces: () => ({}), roots: () => [100], tunnelInterface: () => 'Mullvad' })
    const sample = await radar.sample()

    expect(sample.tunnelAddresses).toEqual([])
    expect(sample.connections.filter(c => c.route === 'tunnel')).toHaveLength(0)
    expect(sample.connections.filter(c => c.route === 'outside').length).toBeGreaterThan(1)
  })

  it('reads the process list once in a while, not at every look', async () => {
    const { exec, radar, tick } = make()

    await radar.sample()
    await radar.sample()
    expect(exec.mock.calls.filter(call => call[0] === 'powershell.exe')).toHaveLength(1)

    tick(11_000)
    await radar.sample()
    expect(exec.mock.calls.filter(call => call[0] === 'powershell.exe')).toHaveLength(2)
  })

  it('a failing command is an answer with the reason, never a crash', async () => {
    expect((await make({ netstat: { code: 1, stdout: '' } }).radar.sample()).error).toBe('netstat failed')
    expect((await make({ processes: { code: 1, stdout: '' } }).radar.sample()).error).toBe(
      'could not read the process list'
    )
    expect((await make({ netstat: { code: 1, stdout: '' } }).radar.sample()).connections).toEqual([])
  })
})
