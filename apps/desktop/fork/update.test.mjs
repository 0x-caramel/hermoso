/**
 * Tests for fork/update.mjs: the flow that updates the fork after the app has quit, with every
 * side effect (processes, clock, the sync, the relaunch) replaced by a fake.
 *
 *   node --test fork/update.test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { MARKER_WAIT_MS, PID_WAIT_MS, parseArgs, parseSyncOutput, runUpdate, VPN_WAIT_MS } from './update.mjs'

const OPTIONS = {
  exe: 'C:\\repo\\apps\\desktop\\release\\win-unpacked\\Hermes.exe',
  lang: 'en',
  marker: 'marker',
  noRelaunch: false,
  pid: 4242,
  repo: 'C:\\repo',
  runtime: 'C:\\runtime',
  state: 'state.json',
  sync: 'sync.mjs',
  target: 'a'.repeat(40),
  vpn: 'off'
}

function harness(overrides = {}) {
  let clock = 0
  const calls = []
  const states = []
  const printed = []

  const edges = {
    every: () => {
      calls.push('beat-start')

      return () => calls.push('beat-stop')
    },
    markerLive: () => false,
    mullvadStatus: () => 'Connected\n    Relay: se-got-wg-001',
    now: () => clock,
    pidAlive: () => false,
    print: line => printed.push(line),
    relaunch: async exe => {
      calls.push(`relaunch ${exe}`)
    },
    runSync: async () => {
      calls.push('sync')

      return { code: 0, tail: [] }
    },
    sleep: async ms => {
      clock += ms
    },
    writeState: state => states.push(state),
    ...overrides
  }

  return { calls, clock: () => clock, edges, printed, states }
}

test('a clean update: waits for the app, runs the sync, records "done" and reopens the app', async () => {
  const h = harness()
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'done')
  assert.deepEqual(h.calls, ['beat-start', 'sync', 'beat-stop', `relaunch ${OPTIONS.exe}`])
  assert.deepEqual(h.states.at(-1), { at: h.clock(), head: OPTIONS.target, status: 'done' })
})

test('it does not start before the app has quit, and says so when the app never does', async () => {
  const h = harness({ pidAlive: () => true })
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.reason, /did not close/)
  assert.ok(!h.calls.includes('sync'), 'nothing was built under a running app')
  assert.ok(h.calls.includes(`relaunch ${OPTIONS.exe}`), 'the app is still reopened')
  assert.ok(h.clock() >= PID_WAIT_MS)
})

test('it waits for the official update script to let go of the marker', async () => {
  let live = 20

  const h = harness({
    markerLive: () => live-- > 0
  })
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'done')
  assert.ok(h.clock() >= 19_000, 'it polled until the marker went')
  assert.ok(h.calls.indexOf('sync') > -1)
})

test('a marker that never clears fails the update instead of building under the official one', async () => {
  const h = harness({ markerLive: () => true })
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.reason, /official update is still running/)
  assert.ok(!h.calls.includes('sync'))
  assert.ok(h.clock() >= MARKER_WAIT_MS)
})

test('a failed sync records why and which files conflict, and still reopens the previous build', async () => {
  const h = harness({
    runSync: async () => ({
      code: 1,
      tail: [
        '[fork-sync] fork:    mullvad-vpn  (2 commit(s) to replay)',
        '[fork-sync] the fork does NOT apply cleanly: 2 file(s) conflict',
        '             apps/desktop/electron/main.ts  (content, 9 hunks)',
        '             apps/desktop/DESIGN.md  (content, 1 hunk)',
        '',
        '[fork-sync] Nothing was changed. Resolve the conflicts once.'
      ]
    })
  })
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'failed')
  assert.deepEqual(outcome.conflicts, ['apps/desktop/electron/main.ts', 'apps/desktop/DESIGN.md'])
  assert.match(outcome.reason, /does NOT apply cleanly/)
  assert.deepEqual(h.states.at(-1).conflicts, outcome.conflicts)
  assert.equal(h.states.at(-1).status, 'failed')
  assert.ok(h.calls.includes(`relaunch ${OPTIONS.exe}`))
  assert.ok(h.clock() < 30_000, 'it does not wait around after a failure: it has no window to keep open')

  const verdict = h.printed.findIndex(line => /did not go through/.test(line))

  assert.match(h.printed[verdict], /2 file\(s\) conflict/)
  assert.deepEqual(h.printed.slice(verdict + 1, verdict + 3), ['  apps/desktop/electron/main.ts', '  apps/desktop/DESIGN.md'])
  assert.match(h.printed[verdict + 3], /Reopening Hermes \(Mullvad\) as it was/, 'the files come before what happens next')
})

test('the console speaks Italian when asked to', async () => {
  const h = harness({ runSync: async () => ({ code: 1, tail: ['[fork-sync] failed: boom'] }) })

  await runUpdate({ ...OPTIONS, lang: 'it' }, h.edges)
  assert.ok(h.printed.some(line => /L'aggiornamento non è riuscito: boom/.test(line)))
  assert.ok(h.printed.some(line => /allinea il fork/.test(line)))
})

test('a sync that dies without a verdict still gives a reason', async () => {
  const h = harness({ runSync: async () => ({ code: 1, tail: ['[fork-sync] failed: e2e/vpn-gate.spec.ts failed (exit 1)'] }) })
  const outcome = await runUpdate(OPTIONS, h.edges)

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'e2e/vpn-gate.spec.ts failed (exit 1)')
})

test('with the VPN required, it builds only once the tunnel is up', async () => {
  let polls = 0

  const h = harness({ mullvadStatus: () => (++polls > 4 ? 'Connected' : 'Connecting...') })
  const outcome = await runUpdate({ ...OPTIONS, vpn: 'required' }, h.edges)

  assert.equal(outcome.status, 'done')
  assert.ok(polls > 4)
  assert.ok(h.calls.includes('sync'))
})

test('with the VPN required and never connected, the update is postponed, not run on the real IP', async () => {
  const h = harness({ mullvadStatus: () => 'Disconnected' })
  const outcome = await runUpdate({ ...OPTIONS, vpn: 'required' }, h.edges)

  assert.equal(outcome.status, 'deferred')
  assert.ok(!h.calls.includes('sync'))
  assert.ok(h.calls.includes(`relaunch ${OPTIONS.exe}`))
  assert.equal(h.states.at(-1).status, 'deferred')
  assert.ok(h.clock() >= VPN_WAIT_MS)
})

test('with the VPN not required it never asks Mullvad', async () => {
  const h = harness({
    mullvadStatus: () => {
      throw new Error('must not be called')
    }
  })

  assert.equal((await runUpdate(OPTIONS, h.edges)).status, 'done')
})

test('--no-relaunch leaves the app closed (for tests)', async () => {
  const h = harness()

  await runUpdate({ ...OPTIONS, noRelaunch: true }, h.edges)
  assert.ok(!h.calls.some(call => call.startsWith('relaunch')))
})

test('while it works, it keeps telling the app an update is running', async () => {
  const h = harness({ markerLive: () => h.clock() < 40_000 })

  await runUpdate(OPTIONS, h.edges)

  const beats = h.states.filter(state => state.status === 'running')

  assert.ok(beats.length >= 3, `expected a heartbeat every 15 s while waiting, got ${beats.length}`)
  assert.ok(beats.every(state => state.head === OPTIONS.target))
})

test('parseArgs reads what the app passes, and refuses a call that is missing something', () => {
  const parsed = parseArgs([
    '--pid', '12', '--exe', 'C:\\a\\Hermes.exe', '--repo', 'C:\\a', '--runtime', 'C:\\rt', '--target', 'abc',
    '--state', 's.json', '--marker', 'm', '--vpn', 'required', '--lang', 'it', '--no-relaunch'
  ])

  assert.equal(parsed.pid, 12)
  assert.equal(parsed.vpn, 'required')
  assert.equal(parsed.noRelaunch, true)
  assert.match(parsed.sync, /fork[\\/]sync\.mjs$/, 'the sync defaults to the fork checkout')
  assert.equal(path.basename(parsed.log), 'fork-update.log', 'the log defaults to the one next to the state file')

  const withLog = parseArgs([
    '--pid', '1', '--exe', 'e', '--repo', 'r', '--runtime', 'x', '--target', 't', '--state', 's.json', '--marker', 'm',
    '--log', 'my.log'
  ])

  assert.equal(withLog.log, 'my.log')
  assert.throws(() => parseArgs(['--pid', '12']), /--exe is required/)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
})

test('parseSyncOutput ignores colour codes and stops the file list at the blank line', () => {
  const parsed = parseSyncOutput([
    '\x1b[31m[fork-sync] the fork does NOT apply cleanly: 1 file(s) conflict\x1b[0m',
    '             apps/desktop/src/app/settings/index.tsx  (content, 2 hunks)',
    '',
    '             apps/desktop/not-a-conflict.ts  (content)'
  ])

  assert.deepEqual(parsed.conflicts, ['apps/desktop/src/app/settings/index.tsx'])
})
