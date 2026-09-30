#!/usr/bin/env node
/**
 * fork/update.mjs — what runs after Hermes (Mullvad) has quit, to update itself.
 *
 * Started (hidden) by electron/fork-update.ts when the official Hermes under this build moved on.
 * It waits for the app and for the official update script to be done, makes sure the Mullvad
 * tunnel is up when the app requires it, runs fork/sync.mjs (replay the fork on the new official
 * code, verify, rebuild) and relaunches Hermes (Mullvad): the new build when it worked, the
 * previous one untouched when it did not. Every path ends with the app reopening.
 * The outcome goes to the state file the app reads at its next start (fork-update.json); what it
 * says goes to the log file, which fork/tail.mjs shows in a window the user may close at any time:
 * nothing here depends on a console, because closing one must never stop a rebuild half way.
 *
 *   node fork/update.mjs --pid <app pid> --exe <Hermes.exe> --repo <fork checkout> --runtime <official checkout>
 *        --target <runtime commit> --state <fork-update.json> --marker <.hermes-update-in-progress>
 *        [--log <fork-update.log>] [--vpn required|off] [--lang it|en] [--sync <script>] [--no-relaunch]
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const PID_WAIT_MS = 120_000
export const MARKER_WAIT_MS = 300_000
export const VPN_WAIT_MS = 90_000
export const HEARTBEAT_MS = 15_000

const WORDS = {
  en: {
    closed: 'Hermes (Mullvad) is closed.',
    conflictReason: n => `The fork does not apply cleanly on the new official code: ${n} file(s) conflict:`,
    done: 'Done. Reopening Hermes (Mullvad).',
    failed: reason => `The update did not go through: ${reason}`,
    noClose: 'Hermes (Mullvad) did not close in time',
    noMarker: 'the official update is still running',
    reopening: 'Reopening Hermes (Mullvad) as it was. Ask Claude to "align the fork".',
    syncing: 'Updating the fork on the new official code (about 8 minutes).',
    vpnDeferred: 'The VPN is not connected: the update waits for the next launch. Reopening Hermes (Mullvad) as it was.',
    vpnWait: 'Waiting for the Mullvad tunnel...',
    waitApp: 'Waiting for Hermes (Mullvad) to close...',
    waitOfficial: 'Waiting for the official update to finish...'
  },
  it: {
    closed: 'Hermes (Mullvad) è chiuso.',
    conflictReason: n => `Il fork non si applica pulito sul codice ufficiale nuovo: ${n} file in conflitto:`,
    done: 'Fatto. Riapro Hermes (Mullvad).',
    failed: reason => `L'aggiornamento non è riuscito: ${reason}`,
    noClose: 'Hermes (Mullvad) non si è chiuso in tempo',
    noMarker: "l'aggiornamento ufficiale è ancora in corso",
    reopening: 'Riapro Hermes (Mullvad) com\'era. Scrivi a Claude: "allinea il fork".',
    syncing: 'Aggiorno il fork sul codice ufficiale nuovo (circa 8 minuti).',
    vpnDeferred: 'La VPN non è connessa: l\'aggiornamento aspetta il prossimo avvio. Riapro Hermes (Mullvad) com\'era.',
    vpnWait: 'Aspetto il tunnel Mullvad...',
    waitApp: 'Aspetto che Hermes (Mullvad) si chiuda...',
    waitOfficial: "Aspetto che l'aggiornamento ufficiale finisca..."
  }
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { lang: 'it', noRelaunch: false, vpn: 'off' }
  const value = i => argv[i + 1]

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--pid':
        options.pid = Number.parseInt(value(i), 10)
        i++
        break
      case '--exe':
      case '--repo':
      case '--runtime':
      case '--target':
      case '--state':
      case '--log':
      case '--marker':
      case '--sync':
      case '--lang':
      case '--vpn':
        options[argv[i].slice(2)] = value(i)
        i++
        break
      case '--no-relaunch':
        options.noRelaunch = true
        break
      default:
        throw new Error(`unknown option ${argv[i]}`)
    }
  }

  for (const required of ['pid', 'exe', 'repo', 'runtime', 'target', 'state', 'marker']) {
    if (options[required] === undefined || Number.isNaN(options[required])) {
      throw new Error(`--${required} is required`)
    }
  }

  options.sync ||= path.join(options.repo, 'apps', 'desktop', 'fork', 'sync.mjs')
  options.log ||= path.join(path.dirname(options.state), 'fork-update.log')

  return options
}

/** What `fork/sync.mjs` said about how it ended: the reason, and the files that conflict. */
export function parseSyncOutput(lines) {
  const text = lines.map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
  const ended = [...text].reverse().find(line => /\[fork-sync\] (?:failed|refused):/.test(line))
  const conflict = text.findIndex(line => /does NOT apply cleanly/.test(line))
  const conflicts = []

  if (conflict !== -1) {
    for (const line of text.slice(conflict + 1)) {
      const m = /^\s+(apps\/desktop\/\S+)\s+\(/.exec(line)

      if (m) {
        conflicts.push(m[1])
      } else if (line.trim() === '') {
        break
      }
    }
  }

  const reason = conflict !== -1
    ? text[conflict].replace(/^\[fork-sync\]\s*/, '')
    : ended?.replace(/^.*\[fork-sync\] (?:failed|refused):\s*/, '') ?? 'fork-sync stopped without saying why'

  return { conflicts, reason }
}

// ── the run ─────────────────────────────────────────────────────────────────────────────

/**
 * @param options parsed arguments
 * @param edges everything with side effects, injected so the flow is testable:
 *   now, sleep, every, pidAlive, markerLive, mullvadStatus, runSync, relaunch, writeState, print
 */
export async function runUpdate(options, edges) {
  const t = WORDS[options.lang] ?? WORDS.it
  const say = line => edges.print(line)
  let lastBeat = -Infinity

  const write = patch => edges.writeState({ at: edges.now(), head: options.target, status: 'running', ...patch })

  const waitUntil = async (done, timeoutMs) => {
    const started = edges.now()

    for (;;) {
      if (edges.now() - lastBeat >= HEARTBEAT_MS) {
        lastBeat = edges.now()
        write({})
      }

      if (done()) {
        return true
      }

      if (edges.now() - started >= timeoutMs) {
        return false
      }

      await edges.sleep(1000)
    }
  }

  let outcome

  try {
    say(t.waitApp)

    if (!(await waitUntil(() => !edges.pidAlive(options.pid), PID_WAIT_MS))) {
      throw new Error(t.noClose)
    }

    say(t.closed)
    say(t.waitOfficial)

    if (!(await waitUntil(() => !edges.markerLive(options.marker), MARKER_WAIT_MS))) {
      throw new Error(t.noMarker)
    }

    if (options.vpn === 'required') {
      say(t.vpnWait)

      if (!(await waitUntil(() => /^connected/i.test(String(edges.mullvadStatus()).trim()), VPN_WAIT_MS))) {
        outcome = { status: 'deferred' }
        say(t.vpnDeferred)
      }
    }

    if (!outcome) {
      say(t.syncing)

      // The sync reports through its exit code: 0 adopted, 1 does not apply / a check failed (the
      // previous build is untouched), 2 refused to start. It can be silent for minutes (installing,
      // building), so the heartbeat that tells the app "an update is running" is a timer, not output.
      const stopBeating = edges.every(HEARTBEAT_MS, () => write({}))
      let result

      try {
        result = await edges.runSync({ options })
      } finally {
        stopBeating()
      }

      outcome = result.code === 0 ? { status: 'done' } : { status: 'failed', ...parseSyncOutput(result.tail ?? []) }
    }
  } catch (error) {
    outcome = { reason: error.message, status: 'failed' }
  }

  edges.writeState({
    at: edges.now(),
    head: options.target,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.conflicts?.length ? { conflicts: outcome.conflicts } : {}),
    status: outcome.status
  })

  if (outcome.status === 'done') {
    say(t.done)
  } else if (outcome.status === 'failed') {
    say(t.failed(outcome.conflicts?.length ? t.conflictReason(outcome.conflicts.length) : outcome.reason))

    for (const file of outcome.conflicts ?? []) {
      say(`  ${file}`)
    }

    say(t.reopening)
  }

  if (!options.noRelaunch) {
    await edges.relaunch(options.exe)
  }

  return outcome
}

// ── the real edges ──────────────────────────────────────────────────────────────────────

function realEdges(options) {
  const logFile = options.log
  const print = line => {
    console.log(line)

    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {
      void 0
    }
  }

  const pidAlive = pid => {
    try {
      process.kill(pid, 0)

      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }

  return {
    markerLive: file => {
      try {
        const pid = Number.parseInt(fs.readFileSync(file, 'utf8').split('\n')[0].trim(), 10)

        return Number.isInteger(pid) && pidAlive(pid)
      } catch {
        return false
      }
    },
    mullvadStatus: () => {
      const cli =
        process.env.HERMES_MULLVAD_CLI ||
        ['C:\\Program Files\\Mullvad VPN\\resources\\mullvad.exe'].find(candidate => fs.existsSync(candidate)) ||
        'mullvad'
      const r = spawnSync(cli, ['status'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })

      return r.stdout ?? ''
    },
    now: () => Date.now(),
    pidAlive,
    print,
    readState: () => {
      try {
        return JSON.parse(fs.readFileSync(options.state, 'utf8'))
      } catch {
        return null
      }
    },
    relaunch: async exe => {
      // Through explorer, like a normal launch: a GUI app started straight from this console would
      // attach to it (Chromium attaches to its parent's console) and die with it.
      const deadline = Date.now() + 60_000

      while (!fs.existsSync(exe) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore' }).unref()
    },
    every: (ms, fn) => {
      const id = setInterval(fn, ms)

      return () => clearInterval(id)
    },
    runSync: ({ options: o }) =>
      new Promise(resolve => {
        const tail = []
        const child = spawn(process.execPath, [o.sync, '--from', o.runtime], {
          cwd: o.repo,
          env: { ...process.env, HERMES_DESKTOP_HERMES_ROOT: o.runtime },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })

        let pending = ''
        const take = chunk => {
          pending += chunk.toString('utf8')
          const lines = pending.split(/\r?\n/)

          pending = lines.pop() ?? ''

          for (const line of lines) {
            print(line)
            tail.push(line)

            if (tail.length > 200) {
              tail.shift()
            }
          }
        }

        child.stdout.on('data', take)
        child.stderr.on('data', take)
        child.on('error', error => resolve({ code: 1, tail: [`[fork-sync] failed: ${error.message}`] }))
        child.on('close', code => {
          if (pending) {
            print(pending)
            tail.push(pending)
          }

          resolve({ code: code ?? 1, tail })
        })
      }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    writeState: state => {
      try {
        fs.mkdirSync(path.dirname(options.state), { recursive: true })
        fs.writeFileSync(options.state, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      } catch {
        void 0
      }
    }
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)

if (isMain) {
  let options

  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[fork-update] ${error.message}`)
    process.exit(2)
  }

  const outcome = await runUpdate(options, realEdges(options))

  process.exitCode = outcome.status === 'failed' ? 1 : 0
}
