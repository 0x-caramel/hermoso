/**
 * Radar (main process, Electron-free): which network connections the agent's side of the app has open right now,
 * and whether each one goes through the VPN tunnel.
 *
 * "The agent's side" is the app and everything it started: the Electron processes (their own network stack), the
 * Hermes backend and every command or tool the backend ran. They all descend from this process, so the radar takes
 * the process tree below it and looks at their TCP connections (`netstat`).
 *
 * How a connection is judged, with no guessing about who the remote is:
 *   - the local end is one of the tunnel interface's addresses  -> `tunnel` (it leaves through Mullvad);
 *   - the remote end is this machine                            -> `loopback`;
 *   - the remote end is a private network address (not through the tunnel) -> `lan` (Mullvad's LAN sharing);
 *   - anything else                                             -> `outside`: it left on the real address.
 *
 * The honest limits are part of the report: it samples every few seconds (a connection that opens and closes
 * between two looks is not seen), it reads TCP only, and it cannot see inside Mullvad. The proof it gives is
 * "N connections observed, none outside the tunnel", never "no packet ever left".
 */

export type Route = 'lan' | 'loopback' | 'outside' | 'tunnel'

export interface RadarConnection {
  localAddress: string
  localPort: number
  pid: number
  process: string
  remoteAddress: string
  remotePort: number
  route: Route
  state: string
}

export interface RadarSample {
  at: number
  connections: RadarConnection[]
  error: null | string
  /** The tunnel interface's addresses at the time (empty when the tunnel is down). */
  tunnelAddresses: string[]
}

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────

function splitEndpoint(text: string): null | { address: string; port: number } {
  const match = /^\[?([^\]]+?)(?:%\w+)?\]?:(\d+)$/.exec(text.trim())

  return match ? { address: match[1].toLowerCase(), port: Number(match[2]) } : null
}

export interface RawConnection {
  local: { address: string; port: number }
  pid: number
  remote: { address: string; port: number }
  state: string
}

/** `netstat -ano` text → TCP connections (headers in any language are ignored). */
export function parseNetstat(output: string): RawConnection[] {
  const found: RawConnection[] = []

  for (const line of String(output ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)

    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') {
      continue
    }

    const local = splitEndpoint(parts[1])
    const remote = splitEndpoint(parts[2])
    const pid = Number(parts[4])

    if (local && remote && Number.isInteger(pid)) {
      found.push({ local, pid, remote, state: parts[3].toUpperCase() })
    }
  }

  return found
}

/** `pid,ppid,name` lines → who is whose child. */
export function parseProcessList(output: string): Map<number, { name: string; parent: number }> {
  const map = new Map<number, { name: string; parent: number }>()

  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^(\d+),(\d+),(.*)$/.exec(line.trim())

    if (match) {
      map.set(Number(match[1]), { name: match[3].trim(), parent: Number(match[2]) })
    }
  }

  return map
}

/** The roots and everything below them. */
export function descendants(list: Map<number, { name: string; parent: number }>, roots: number[]): Set<number> {
  const children = new Map<number, number[]>()

  for (const [pid, entry] of list) {
    children.set(entry.parent, [...(children.get(entry.parent) ?? []), pid])
  }

  const found = new Set<number>(roots)
  const queue = [...roots]

  while (queue.length > 0) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        queue.push(child)
      }
    }
  }

  return found
}

// ── judging ──────────────────────────────────────────────────────────────────────────────────────

export function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || address === '0:0:0:0:0:0:0:1'
}

/** Private network addresses: what a LAN uses, which Mullvad may leave outside the tunnel on purpose. */
export function isPrivate(address: string): boolean {
  const a = address.toLowerCase()

  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) {
    return true
  }

  const second = /^172\.(\d+)\./.exec(a)

  if (second && Number(second[1]) >= 16 && Number(second[1]) <= 31) {
    return true
  }

  return /^fe[89ab][0-9a-f]:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a)
}

export function classifyRoute(local: string, remote: string, tunnelAddresses: ReadonlySet<string>): Route {
  if (isLoopback(remote)) {
    return 'loopback'
  }

  if (tunnelAddresses.has(local.toLowerCase())) {
    return 'tunnel'
  }

  return isPrivate(remote) ? 'lan' : 'outside'
}

/** Only connections that are live or being made: a listener or a closing socket is not traffic. */
const LIVE_STATES = new Set(['ESTABLISHED', 'SYN_SENT', 'SYN_RECEIVED', 'CLOSE_WAIT'])

export function judgeConnections(
  raw: RawConnection[],
  pids: ReadonlySet<number>,
  names: Map<number, { name: string; parent: number }>,
  tunnelAddresses: ReadonlySet<string>
): RadarConnection[] {
  return raw
    .filter(connection => pids.has(connection.pid) && LIVE_STATES.has(connection.state))
    .map(connection => ({
      localAddress: connection.local.address,
      localPort: connection.local.port,
      pid: connection.pid,
      process: names.get(connection.pid)?.name ?? `pid ${connection.pid}`,
      remoteAddress: connection.remote.address,
      remotePort: connection.remote.port,
      route: classifyRoute(connection.local.address, connection.remote.address, tunnelAddresses),
      state: connection.state
    }))
}

// ── looking ──────────────────────────────────────────────────────────────────────────────────────

export interface RadarDeps {
  exec: (file: string, args: string[], timeoutMs: number) => Promise<{ code: null | number; stdout: string }>
  /** `os.networkInterfaces()`. */
  interfaces: () => Record<string, undefined | { address: string }[]>
  now?: () => number
  /** The processes whose tree is watched (the app itself). */
  roots: () => number[]
  /** The tunnel's interface name (`Mullvad`). */
  tunnelInterface: () => string
}

const PROCESS_LIST_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }"
const PROCESS_TTL_MS = 10_000
const EXEC_TIMEOUT_MS = 8_000

export function createRadar(deps: RadarDeps) {
  const now = deps.now ?? Date.now
  let cache: null | { at: number; list: Map<number, { name: string; parent: number }> } = null

  const processes = async (): Promise<Map<number, { name: string; parent: number }>> => {
    if (cache && now() - cache.at < PROCESS_TTL_MS) {
      return cache.list
    }

    const result = await deps.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_SCRIPT],
      EXEC_TIMEOUT_MS
    )

    if (result.code !== 0) {
      throw new Error('could not read the process list')
    }

    cache = { at: now(), list: parseProcessList(result.stdout) }

    return cache.list
  }

  return {
    async sample(): Promise<RadarSample> {
      const at = now()
      const tunnelAddresses = (deps.interfaces()[deps.tunnelInterface()] ?? []).map(entry =>
        entry.address.toLowerCase().replace(/%\w+$/, '')
      )

      try {
        const [netstat, list] = await Promise.all([
          deps.exec('netstat.exe', ['-ano', '-p', 'tcp'], EXEC_TIMEOUT_MS),
          processes()
        ])

        if (netstat.code !== 0) {
          throw new Error('netstat failed')
        }

        const pids = descendants(list, deps.roots())
        const connections = judgeConnections(parseNetstat(netstat.stdout), pids, list, new Set(tunnelAddresses))

        return { at, connections, error: null, tunnelAddresses }
      } catch (error) {
        return { at, connections: [], error: error instanceof Error ? error.message : String(error), tunnelAddresses }
      }
    }
  }
}

export type Radar = ReturnType<typeof createRadar>
