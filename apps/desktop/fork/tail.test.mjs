/**
 * Tests for fork/tail.mjs: the progress window of a fork update, with the clock, the log and the state
 * file replaced by fakes (and real temporary files for the part that reads bytes).
 *
 *   node --test fork/tail.test.mjs
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  DEAD_AFTER_MS,
  FAILURE_PAUSE_MS,
  follow,
  parseArgs,
  POLL_MS,
  prettyLines,
  QUIET_MS,
  readNewFrom
} from './tail.mjs'

const TARGET = 'a'.repeat(40)

/** A fake world: a log that grows and a state file that changes as the (fake) clock advances. */
function world({ log = [], state = () => null, lang = 'en' } = {}) {
  let clock = 0
  let offset = 0
  const written = []
  const slept = []

  const lines = () => log.filter(([at]) => at <= clock).map(([, text]) => `${text}\n`).join('')

  const edges = {
    now: () => clock,
    readNew: (from, flush) => {
      const all = lines()

      // the fake log is plain text: byte offsets equal string offsets
      const text = all.slice(from)

      offset = all.length

      return { next: flush ? all.length : from + text.length, text }
    },
    readState: () => state(clock),
    sleep: async ms => {
      slept.push(ms)
      clock += ms
    },
    write: text => written.push(text)
  }

  return { clock: () => clock, edges, offset: () => offset, options: { lang, target: TARGET }, slept, written }
}

const out = w => w.written.join('')

test('it shows the log as it grows and leaves shortly after the update is done', async () => {
  const w = world({
    log: [
      [0, 'first'],
      [3_000, 'second'],
      [6_000, 'Done.']
    ],
    state: clock => ({ at: clock, head: TARGET, status: clock >= 6_000 ? 'done' : 'running' })
  })

  assert.equal(await follow(w.options, w.edges), 'done')

  const shown = out(w)

  assert.ok(shown.indexOf('first') < shown.indexOf('second') && shown.indexOf('second') < shown.indexOf('Done.'))
  assert.ok(w.clock() >= 6_000 + QUIET_MS, 'it waited for the last lines')
  assert.ok(w.clock() < 6_000 + QUIET_MS + 2 * POLL_MS + 1, 'and left without a pause when it worked')
  assert.ok(!w.slept.includes(FAILURE_PAUSE_MS))
})

test('it tells the user closing the window is safe, in their language', async () => {
  const english = world({ state: () => ({ at: 0, head: TARGET, status: 'done' }) })

  await follow(english.options, english.edges)
  assert.match(out(english), /You can close this window: the update goes on by itself\./)

  const italian = world({ lang: 'it', state: () => ({ at: 0, head: TARGET, status: 'done' }) })

  await follow(italian.options, italian.edges)
  assert.match(out(italian), /Puoi chiudere questa finestra/)
})

test('after a failure the window stays long enough to read the reason', async () => {
  const w = world({
    log: [
      [0, 'the fork does NOT apply cleanly'],
      [1_000, '  apps/desktop/electron/main.ts']
    ],
    state: clock => ({ at: clock, head: TARGET, status: clock >= 1_000 ? 'failed' : 'running' })
  })

  assert.equal(await follow(w.options, w.edges), 'failed')
  assert.match(out(w), /apps\/desktop\/electron\/main\.ts/)
  assert.match(out(w), /closes by itself in 30 s/)
  assert.ok(w.slept.includes(FAILURE_PAUSE_MS))
})

test('a postponed update is treated like a failure: the reason stays on screen', async () => {
  const w = world({ state: () => ({ at: 0, head: TARGET, status: 'deferred' }) })

  assert.equal(await follow(w.options, w.edges), 'deferred')
  assert.ok(w.slept.includes(FAILURE_PAUSE_MS))
})

test('it ignores a state file that belongs to another update', async () => {
  const w = world({
    state: clock => ({ at: clock, head: 'b'.repeat(40), status: 'done' })
  })

  assert.equal(await follow(w.options, w.edges), 'dead', 'only its own target ends it, or the silence does')
  assert.ok(w.clock() >= DEAD_AFTER_MS)
})

test('it gives up when the updater stops beating, and says so', async () => {
  const w = world({
    log: [[0, 'Updating the fork...']],
    state: clock => ({ at: Math.min(clock, 20_000), head: TARGET, status: 'running' })
  })

  assert.equal(await follow(w.options, w.edges), 'dead')
  assert.match(out(w), /does not answer any more/)
  assert.ok(w.clock() >= 20_000 + DEAD_AFTER_MS)
  assert.ok(w.clock() < 20_000 + DEAD_AFTER_MS + 2 * POLL_MS + FAILURE_PAUSE_MS + 1, 'it noticed within a poll, then paused')
  assert.ok(w.slept.includes(FAILURE_PAUSE_MS), 'and left the message on screen long enough to read')
})

test('a missing state file is not the end', async () => {
  const w = world({
    log: [[0, 'still going']],
    state: clock => (clock < 10_000 ? null : { at: clock, head: TARGET, status: 'done' })
  })

  assert.equal(await follow(w.options, w.edges), 'done')
  assert.ok(w.clock() >= 10_000)
})

test('the window shows the clock instead of the log\'s UTC date, and leaves other lines alone', () => {
  const shown = prettyLines('2026-10-01T00:42:37.484Z Aspetto che Hermes si chiuda...\nplain line\n2026-10-01T00:42:40Z second\n')

  assert.match(shown, /^\d\d:\d\d:\d\d {2}Aspetto che Hermes si chiuda\.\.\.\nplain line\n\d\d:\d\d:\d\d {2}second\n$/)
  assert.equal(prettyLines('2026-13-45T99:99:99Z not a date\n'), '2026-13-45T99:99:99Z not a date\n')
})

test('run for real as a process: it shows the log of an update and exits 0 once it is done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-tail-run-'))
  const log = path.join(dir, 'fork-update.log')
  const state = path.join(dir, 'fork-update.json')
  const script = path.join(import.meta.dirname, 'tail.mjs')

  try {
    fs.writeFileSync(state, JSON.stringify({ at: Date.now(), head: TARGET, status: 'running' }))

    const child = spawn(process.execPath, [script, '--log', log, '--state', state, '--target', TARGET, '--lang', 'en'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''

    child.stdout.on('data', chunk => (stdout += chunk))

    const exited = new Promise(resolve => child.on('close', code => resolve(code)))

    await new Promise(resolve => setTimeout(resolve, 700))
    fs.appendFileSync(log, '2026-10-01T00:42:40.000Z Updating the fork on the new official code\n')
    await new Promise(resolve => setTimeout(resolve, 900))
    fs.appendFileSync(log, '2026-10-01T00:49:00.000Z Done. Reopening Hermes (Mullvad).\n')
    fs.writeFileSync(state, JSON.stringify({ at: Date.now(), head: TARGET, status: 'done' }))

    assert.equal(await exited, 0)
    assert.match(stdout, /Waiting for the updater/)
    assert.match(stdout, /Updating the fork on the new official code/)
    assert.match(stdout, /Done\. Reopening Hermes \(Mullvad\)\./)
    assert.ok(!/2026-10-01T/.test(stdout), 'the clock replaces the UTC date')
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

test('run for real with a missing argument: it says what is missing and exits 2', () => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'tail.mjs'), '--log', 'x'], { encoding: 'utf8' })

  assert.equal(r.status, 2)
  assert.match(r.stderr, /--state is required/)
})

test('parseArgs reads what the app passes, and refuses a call that is missing something', () => {
  const parsed = parseArgs(['--log', 'l.log', '--state', 's.json', '--target', 'abc', '--lang', 'en'])

  assert.deepEqual(parsed, { lang: 'en', log: 'l.log', state: 's.json', target: 'abc' })
  assert.equal(parseArgs(['--log', 'l', '--state', 's', '--target', 't']).lang, 'it')
  assert.throws(() => parseArgs(['--log', 'l']), /--state is required/)
  assert.throws(() => parseArgs(['--nope']), /unknown option/)
})

test('readNewFrom returns whole lines only, and follows the file as it grows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-tail-'))
  const file = path.join(dir, 'fork-update.log')

  try {
    assert.deepEqual(readNewFrom(file, 0), { next: 0, text: '' }, 'a log that does not exist yet reads as empty')

    fs.writeFileSync(file, 'one\ntwo\npart')

    const first = readNewFrom(file, 0)

    assert.equal(first.text, 'one\ntwo\n', 'the line still being written waits')
    assert.equal(first.next, 8)

    fs.appendFileSync(file, 'ial\nthree\n')

    const second = readNewFrom(file, first.next)

    assert.equal(second.text, 'partial\nthree\n')
    assert.equal(readNewFrom(file, second.next).text, '')

    fs.appendFileSync(file, 'no newline at the end')
    assert.equal(readNewFrom(file, second.next).text, '', 'held back ...')
    assert.equal(readNewFrom(file, second.next, true).text, 'no newline at the end', '... until the end is flushed')

    // multi-byte characters survive: the cut is at a newline, never inside a character
    fs.writeFileSync(file, "L'aggiornamento è finito\nRiapro Hermes\n")
    assert.equal(readNewFrom(file, 0).text, "L'aggiornamento è finito\nRiapro Hermes\n")

    // a log replaced by a shorter one is read again from its start
    fs.writeFileSync(file, 'new\n')
    assert.deepEqual(readNewFrom(file, 500), { next: 4, text: 'new\n' })
  } finally {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})
