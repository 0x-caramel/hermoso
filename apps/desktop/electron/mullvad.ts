/**
 * Mullvad VPN client (main-process side, Electron-free).
 *
 * Hermes does not ship a VPN stack. It drives the official Mullvad app through
 * the `mullvad` CLI that installs beside it, which talks to the Mullvad daemon
 * (a system service). Everything here is a thin, defensive wrapper over that
 * CLI: locate it, run a subcommand with a hard timeout, and turn its text
 * output into typed facts.
 *
 * Kept standalone (no `import 'electron'`) so the parts that actually break a
 * user — CLI discovery, status/relay parsing across CLI versions, and mapping
 * a failed spawn to a reason the UI can explain — are unit-testable with
 * `vitest` without booting Electron. vpn-controller.ts owns the gate policy;
 * main.ts owns the settings file and the IPC wiring.
 *
 * Parsing is deliberately conservative. The CLI's human output has been
 * reworded across Mullvad releases, so we classify on the leading state word
 * (stable for years) and treat every richer field (location, relay host) as
 * best-effort display data that may be absent.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { hiddenWindowsChildOptions } from './windows-child-options'

export type MullvadTunnelState = 'blocked' | 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown'

export interface MullvadLocation {
  city: null | string
  country: null | string
}

export interface MullvadStatus {
  /** Text after `Blocked:` / `Error:` — why the daemon refused to connect. */
  detail: null | string
  location: MullvadLocation | null
  /** Relay host (e.g. `se-got-wg-001`) when the CLI reported one. */
  relay: null | string
  state: MullvadTunnelState
}

/** A read of the tunnel: the status, or why it could not be read. Exactly one is non-null. */
export interface MullvadStatusResult {
  failure: MullvadFailure | null
  status: MullvadStatus | null
}

export interface RelayCity {
  code: string
  name: string
}

export interface RelayCountry {
  cities: RelayCity[]
  code: string
  name: string
}

export interface CliResult {
  code: null | number
  /** Set when the process could not be spawned or timed out. */
  error?: 'missing' | 'timeout' | 'spawn'
  stderr: string
  stdout: string
}

export type CliRunner = (file: string, args: string[], options: { timeoutMs: number }) => Promise<CliResult>

/** Why a CLI call could not produce an answer. The controller maps these to UI copy. */
export type MullvadFailure = 'daemon-unreachable' | 'failed' | 'not-installed' | 'timeout'

const STATUS_TIMEOUT_MS = 6_000
const COMMAND_TIMEOUT_MS = 12_000
const RELAY_LIST_TIMEOUT_MS = 15_000
const MAX_BUFFER = 4 * 1024 * 1024

const STATE_LINE =
  /^(?:tunnel status:\s*)?(connected|connecting|disconnected|disconnecting|blocked|error)\b[:.\s]*(.*)$/i

function lines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
}

function firstNonEmpty(text: string): string {
  return (
    lines(text)
      .find(line => line.trim() !== '')
      ?.trim() ?? ''
  )
}

/**
 * Best-effort visible location out of either CLI dialect:
 *   old: `Connected to <relay> in Gothenburg, Sweden`   (city, country)
 *   new: `Visible location:  Sweden, Gothenburg. IPv4: …` (country, city)
 */
function parseLocation(text: string): MullvadLocation | null {
  const modern = /visible location:\s*([^,.\n]+?)(?:\s*,\s*([^.\n]+?))?\s*(?:\.|\n|$)/i.exec(text)

  if (modern?.[1]) {
    return { city: modern[2]?.trim() || null, country: modern[1].trim() }
  }

  const legacy = /\bin\s+([^,\n]+?)\s*,\s*([^\n.]+?)\s*(?:\.|\n|$)/.exec(text)

  if (legacy?.[1] && legacy[2]) {
    return { city: legacy[1].trim(), country: legacy[2].trim() }
  }

  return null
}

function parseRelayHost(text: string): null | string {
  return /\b([a-z]{2}-[a-z0-9]+-(?:wg|ovpn|br|bridge)-\d+)\b/i.exec(text)?.[1]?.toLowerCase() ?? null
}

/**
 * Turn `mullvad status` output into a typed status. Never throws.
 *
 * An EMPTY answer with a clean exit is a real thing the daemon does (observed on
 * mullvad-cli 2026.5): for the couple of seconds a relay change reconnects the
 * tunnel, `status` prints nothing at all, between `Connected` and `Connecting`. That
 * is a tunnel on its way up, so it reads as `connecting` — never as `unknown`, which
 * is reserved for text we do not recognise.
 */
export function parseMullvadStatus(output: string): MullvadStatus {
  const text = lines(output).join('\n')

  if (text.trim() === '') {
    return { detail: null, location: null, relay: null, state: 'connecting' }
  }

  const match = STATE_LINE.exec(firstNonEmpty(text))

  if (!match) {
    return { detail: null, location: null, relay: null, state: 'unknown' }
  }

  const word = match[1].toLowerCase()
  const rest = match[2]?.trim() || null

  if (word === 'blocked' || word === 'error') {
    return { detail: rest, location: null, relay: null, state: 'blocked' }
  }

  return {
    detail: null,
    location: parseLocation(text),
    relay: parseRelayHost(text),
    state: word as MullvadTunnelState
  }
}

/**
 * `mullvad account get` → whether a device is logged in. `null` when the
 * output says neither way, so a reworded CLI never blocks a working setup.
 * The account number in the output is never returned. A revoked device counts
 * as logged out: the remedy (sign in again) is the same.
 */
export function parseAccountLoggedIn(output: string): boolean | null {
  const text = String(output ?? '')

  if (/not logged in|no account|device has been revoked/i.test(text)) {
    return false
  }

  if (/mullvad account\s*:/i.test(text)) {
    return true
  }

  return null
}

/**
 * When the account runs out: `Expires at:         2026-10-31 04:31:42 +01:00` (older
 * releases print `… UTC`). `null` when the line is absent or unreadable — a reworded CLI
 * must never read as an expired account.
 */
export function parseAccountExpiry(output: string): Date | null {
  const match = /expires at\s*:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(Z|UTC|[+-]\d{2}:?\d{2})?/i.exec(
    String(output ?? '')
  )

  if (!match) {
    return null
  }

  const zone = (match[3] ?? 'Z').toUpperCase()
  const offset = zone === 'UTC' || zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
  const parsed = new Date(`${match[1]}T${match[2]}${offset}`)

  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export interface MullvadAccount {
  /** When the account's time runs out, if the CLI said. */
  expiresAt: Date | null
  /** Whether this device is logged in; null when the CLI answered neither way. */
  loggedIn: boolean | null
}

const COUNTRY_LINE = /^(\S.*?)\s+\(([a-z]{2})\)\s*$/i
// City rows are indented and carry a short code; relay rows ("se-got-wg-001 (1.2.3.4, …) - WireGuard")
// never match because their parenthesis holds an address and is followed by more text.
const CITY_LINE = /^\s+([^()]+?)\s+\(([a-z0-9]{2,5})\)(?:\s+@.*)?\s*$/i

/** Turn `mullvad relay list` into countries → cities. Unknown shapes yield []. */
export function parseRelayList(output: string): RelayCountry[] {
  const countries: RelayCountry[] = []
  let current: null | RelayCountry = null

  for (const raw of lines(output)) {
    if (!raw.trim()) {
      continue
    }

    if (!/^\s/.test(raw)) {
      const country = COUNTRY_LINE.exec(raw)

      current = country ? { cities: [], code: country[2].toLowerCase(), name: country[1].trim() } : null

      if (current) {
        countries.push(current)
      }

      continue
    }

    const city = current ? CITY_LINE.exec(raw) : null

    if (current && city) {
      current.cities.push({ code: city[2].toLowerCase(), name: city[1].trim() })
    }
  }

  return countries.filter(country => country.cities.length > 0)
}

/** Classify why a CLI call failed, from its spawn error and stderr. */
export function classifyCliFailure(result: CliResult): MullvadFailure {
  if (result.error === 'missing') {
    return 'not-installed'
  }

  if (result.error === 'timeout') {
    return 'timeout'
  }

  if (/daemon|management interface|rpc|connection refused|pipe/i.test(result.stderr)) {
    return 'daemon-unreachable'
  }

  return 'failed'
}

// A JS file can only reach us through the HERMES_MULLVAD_CLI override (real installs are
// always a native `mullvad` binary), so it is a scripted stand-in: run it with this
// process's own Node/Electron runtime, which works on every platform without a shell.
const SCRIPT_CLI = /\.(?:c|m)?js$/i

export const defaultCliRunner: CliRunner = (file, args, { timeoutMs }) =>
  new Promise(resolve => {
    const scripted = SCRIPT_CLI.test(file)

    try {
      execFile(
        scripted ? process.execPath : file,
        scripted ? [file, ...args] : args,
        hiddenWindowsChildOptions({
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER,
          timeout: timeoutMs,
          ...(scripted ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {})
        }),
        (error: any, stdout: unknown, stderr: unknown) => {
          const out = String(stdout ?? '')
          const err = String(stderr ?? '')

          if (!error) {
            return resolve({ code: 0, stderr: err, stdout: out })
          }

          if (error.code === 'ENOENT') {
            return resolve({ code: null, error: 'missing', stderr: err, stdout: out })
          }

          if (error.killed || error.signal === 'SIGTERM') {
            return resolve({ code: null, error: 'timeout', stderr: err, stdout: out })
          }

          resolve({
            code: typeof error.code === 'number' ? error.code : null,
            ...(typeof error.code === 'number' ? {} : { error: 'spawn' as const }),
            stderr: err || String(error.message ?? ''),
            stdout: out
          })
        }
      )
    } catch (error: any) {
      resolve({ code: null, error: 'spawn', stderr: String(error?.message ?? error), stdout: '' })
    }
  })

export interface MullvadClientDeps {
  env?: NodeJS.ProcessEnv
  exists?: (candidate: string) => boolean
  platform?: NodeJS.Platform
  run?: CliRunner
}

function programFiles(env: NodeJS.ProcessEnv): string[] {
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(
    (value): value is string => Boolean(value)
  )
}

/**
 * Ordered CLI candidates: PATH → the installer's own locations. An explicit
 * `HERMES_MULLVAD_CLI` is the ONLY candidate when set — an override that
 * quietly fell through to a real install on this machine would make scripted
 * launches (tests, CI) depend on what happens to be installed.
 */
export function mullvadCliCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (env.HERMES_MULLVAD_CLI) {
    return [env.HERMES_MULLVAD_CLI]
  }

  const exe = platform === 'win32' ? 'mullvad.exe' : 'mullvad'
  const candidates: string[] = []

  for (const dir of String(env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)) {
    candidates.push(path.join(dir, exe))
  }

  if (platform === 'win32') {
    for (const root of programFiles(env)) {
      candidates.push(path.join(root, 'Mullvad VPN', 'resources', exe))
    }

    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Mullvad VPN', 'resources', exe))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Mullvad VPN.app/Contents/Resources/mullvad', '/usr/local/bin/mullvad')
  } else {
    candidates.push('/usr/bin/mullvad', '/usr/local/bin/mullvad', '/opt/Mullvad VPN/resources/mullvad')
  }

  return [...new Set(candidates)]
}

/** Where the Mullvad GUI lives, so "Open Mullvad" can launch it. */
export function mullvadAppCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return programFiles(env).map(root => path.join(root, 'Mullvad VPN', 'Mullvad VPN.exe'))
  }

  if (platform === 'darwin') {
    return ['/Applications/Mullvad VPN.app']
  }

  return ['/usr/bin/mullvad-gui', '/opt/Mullvad VPN/mullvad-gui']
}

export type MullvadClient = ReturnType<typeof createMullvadClient>

export function createMullvadClient({
  env = process.env,
  exists = fs.existsSync,
  platform = process.platform,
  run = defaultCliRunner
}: MullvadClientDeps = {}) {
  let cachedCli: null | string = null

  const findCli = (): null | string => {
    if (cachedCli && exists(cachedCli)) {
      return cachedCli
    }

    cachedCli = mullvadCliCandidates(env, platform).find(candidate => exists(candidate)) ?? null

    return cachedCli
  }

  const findApp = (): null | string => mullvadAppCandidates(env, platform).find(candidate => exists(candidate)) ?? null

  const exec = async (args: string[], timeoutMs: number): Promise<CliResult> => {
    const cli = findCli()

    if (!cli) {
      return { code: null, error: 'missing', stderr: '', stdout: '' }
    }

    return run(cli, args, { timeoutMs })
  }

  return {
    /** Login state and expiry from `mullvad account get`. The account number is never read out. */
    async account(): Promise<MullvadAccount> {
      const result = await exec(['account', 'get'], STATUS_TIMEOUT_MS)
      const text = [result.stdout, result.stderr].join('\n')
      const parsed = parseAccountLoggedIn(text)

      return {
        // A clean exit is needed for anything but the negative: "Not logged in on any
        // account" is an answer whatever the exit code, but a failing call never reads as a
        // logged-in (or unexpired) account.
        expiresAt: result.code === 0 ? parseAccountExpiry(text) : null,
        loggedIn: parsed === false ? false : result.code === 0 ? parsed : null
      }
    },

    connect: () => exec(['connect'], COMMAND_TIMEOUT_MS),
    disconnect: () => exec(['disconnect'], COMMAND_TIMEOUT_MS),
    findApp,
    findCli,

    async listRelays(): Promise<RelayCountry[]> {
      const result = await exec(['relay', 'list'], RELAY_LIST_TIMEOUT_MS)

      return result.code === 0 ? parseRelayList(result.stdout) : []
    },

    /** Country/city codes as `mullvad relay list` prints them; null country = leave Mullvad's choice alone. */
    setLocation(country: string, city: null | string): Promise<CliResult> {
      return exec(['relay', 'set', 'location', country, ...(city ? [city] : [])], COMMAND_TIMEOUT_MS)
    },

    /** Current tunnel state, or the failure that prevented reading it. Exactly one is non-null. */
    async status(): Promise<MullvadStatusResult> {
      const result = await exec(['status'], STATUS_TIMEOUT_MS)

      if (result.code !== 0) {
        return { failure: classifyCliFailure(result), status: null }
      }

      return { failure: null, status: parseMullvadStatus(result.stdout) }
    }
  }
}
