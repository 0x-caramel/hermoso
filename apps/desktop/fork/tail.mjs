#!/usr/bin/env node
/**
 * fork/tail.mjs — the progress window of a fork update.
 *
 * The update itself (fork/update.mjs) runs hidden, so that closing a window can never stop a rebuild
 * half way: this is only a viewer. It shows fork-update.log as it grows and leaves once the update has
 * ended: at once when it worked, after a pause long enough to read when it did not. Closing it early
 * changes nothing; the update goes on and the app reopens by itself.
 *
 *   node fork/tail.mjs --log <fork-update.log> --state <fork-update.json> --target <runtime commit> [--lang it|en]
 */

import fs from 'node:fs'

export const POLL_MS = 500
/** After the update has ended: how long the log must stay quiet before the window leaves. */
export const QUIET_MS = 1_500
/** An update that has not beaten for this long (the updater beats every 15 s) is gone. */
export const DEAD_AFTER_MS = 120_000
export const FAILURE_PAUSE_MS = 30_000

const WORDS = {
  en: {
    closeIsSafe: 'You can close this window: the update goes on by itself.',
    dead: 'The updater does not answer any more.',
    waiting: 'Waiting for the updater...',
    windowCloses: n => `This window closes by itself in ${n} s.`
  },
  it: {
    closeIsSafe: "Puoi chiudere questa finestra: l'aggiornamento va avanti da solo.",
    dead: "L'aggiornamento non risponde più.",
    waiting: "Aspetto l'aggiornamento...",
    windowCloses: n => `Questa finestra si chiude da sola tra ${n} s.`
  }
}

export function parseArgs(argv) {
  const options = { lang: 'it' }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--log':
      case '--state':
      case '--target':
      case '--lang':
        options[argv[i].slice(2)] = argv[++i]
        break
      default:
        throw new Error(`unknown option ${argv[i]}`)
    }
  }

  for (const required of ['log', 'state', 'target']) {
    if (!options[required]) {
      throw new Error(`--${required} is required`)
    }
  }

  return options
}

/** The log keeps full UTC timestamps for whoever debugs it; the window shows the local clock. */
export function prettyLines(text) {
  return text.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /gm, (whole, iso) => {
    const at = new Date(iso)

    if (Number.isNaN(at.getTime())) {
      return whole
    }

    const two = n => String(n).padStart(2, '0')

    return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}  `
  })
}

/**
 * What was appended to `file` after byte `offset`. Only whole lines are returned (a line still being
 * written waits for its end), unless `flush`. `next` is where to continue from.
 */
export function readNewFrom(file, offset, flush = false) {
  let fd

  try {
    fd = fs.openSync(file, 'r')

    const size = fs.fstatSync(fd).size
    const from = size < offset ? 0 : offset // the file was replaced by a shorter one: start over

    if (size === from) {
      return { next: from, text: '' }
    }

    const buffer = Buffer.alloc(size - from)

    fs.readSync(fd, buffer, 0, buffer.length, from)

    const cut = flush ? buffer.length : buffer.lastIndexOf(0x0a) + 1

    return { next: from + cut, text: buffer.subarray(0, cut).toString('utf8') }
  } catch {
    return { next: offset, text: '' }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

/**
 * @param options parsed arguments
 * @param edges everything with side effects, injected so the flow is testable: now, sleep, write,
 *   readNew(offset, flush) -> { text, next }, readState() -> the state file's object or null
 * @returns how it ended: 'done' | 'failed' | 'deferred' | 'dead'
 */
export async function follow(options, edges) {
  const t = WORDS[options.lang] ?? WORDS.it
  const line = text => edges.write(`${text}\n`)
  const startedAt = edges.now()
  let offset = 0
  let quietSince = startedAt
  let lastBeat = startedAt
  let ended = null

  line(t.waiting)
  line(t.closeIsSafe)

  for (;;) {
    const { next, text } = edges.readNew(offset, ended !== null)

    if (text) {
      edges.write(prettyLines(text))
      quietSince = edges.now()
    }

    offset = next

    const state = edges.readState()
    const mine = state && state.head === options.target ? state : null

    if (mine) {
      lastBeat = Math.max(lastBeat, Number(mine.at) || 0)

      if (ended === null && mine.status !== 'running') {
        ended = mine.status
        quietSince = edges.now()
      }
    }

    if (ended !== null) {
      if (edges.now() - quietSince >= QUIET_MS) {
        break
      }
    } else if (edges.now() - lastBeat >= DEAD_AFTER_MS) {
      ended = 'dead'
      line(t.dead)

      break
    }

    await edges.sleep(POLL_MS)
  }

  if (ended !== 'done') {
    line(t.windowCloses(Math.round(FAILURE_PAUSE_MS / 1000)))
    await edges.sleep(FAILURE_PAUSE_MS)
  }

  return ended
}

function realEdges(options) {
  return {
    now: () => Date.now(),
    readNew: (offset, flush) => readNewFrom(options.log, offset, flush),
    readState: () => {
      try {
        const raw = fs.readFileSync(options.state, 'utf8')

        return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
      } catch {
        return null
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    write: text => process.stdout.write(text)
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

  const outcome = await follow(options, realEdges(options))

  process.exitCode = outcome === 'done' ? 0 : 1
}
