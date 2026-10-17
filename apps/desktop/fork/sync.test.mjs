/**
 * Tests for fork/sync.mjs on throw-away repositories: a fake "official" repo that moves on, and
 * a shallow clone of it carrying a fork stack shaped like the real one (gate commit, tooling
 * commit, brand commit). No network, no build.
 *
 *   node --test fork/sync.test.mjs
 *
 * Needs git, and Python with Pillow + numpy (the brand regeneration is part of what is tested).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

import { parseMergeTree } from './sync.mjs'

const FORK_DIR = import.meta.dirname

const HAS_PYTHON = spawnSync('python', ['-c', 'import PIL, numpy'], { windowsHide: true }).status === 0

// The identity of the Hermoso fork, as it is checked in: the test follows the file, not a copy of it.
const HERMOSO = JSON.parse(fs.readFileSync(path.join(FORK_DIR, 'identity.json'), 'utf8'))

// ── tiny PNG writer (RGBA) ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

function crc32(buf) {
  let c = 0xffffffff

  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  }

  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])

  length.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(body))

  return Buffer.concat([length, body, crc])
}

function png(width, height, pixel) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      const o = y * stride + 1 + x * 4

      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }

  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Black left half, white right half, one transparent corner: grey-scale art with real black in it.
const LOGO_LIGHT = png(32, 32, (x, y) => (x < 2 && y < 2 ? [0, 0, 0, 0] : x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
// The upstream "dark" variant: a very dark blue-grey ground with white line work.
const LOGO_DARK = png(32, 32, (x, y) => (x % 4 === 0 ? [255, 255, 255, 255] : [13, 17, 23, 255]))
// Something colourful: must never be touched.
const KNIGHT = png(32, 32, (x, y) => [200, (x * 8) % 256, (y * 8) % 256, 255])

// ── a world: the official repo, and the fork cloned from it ───────────────────────────────

const MAIN_V1 = [
  '// main process',
  "import { app } from 'electron'",
  "import { other } from './other'",
  '',
  'export function startBackend() {',
  '  const plan = makePlan()',
  '  return spawnBackend(plan)',
  '}',
  '',
  'export function quit() {',
  '  app.quit()',
  '}',
  ''
].join('\n')

const MAIN_FORK = MAIN_V1.replace('startBackend() {\n', 'startBackend() {\n  await vpn.assertReady()\n')

const HOOKS = JSON.stringify({
  'electron/main.ts': [{ min: 1, text: 'await vpn.assertReady()', why: 'the gate holds the backend start' }]
})

// A stand-in for upstream's generated i18n key catalog: a script derives locales/_keys.json from
// src/items.txt. Upstream rewrites that file constantly, so the fork never merges it: it keeps a
// "generated:" commit and lets the tool run the script again after every replay.
const GEN_SCRIPT = [
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  '',
  'const here = import.meta.dirname',
  // autocrlf checkouts on Windows hand the script CRLF files
  "const items = fs.readFileSync(path.join(here, '..', 'src', 'items.txt'), 'utf8').split(/\\r?\\n/).filter(Boolean).sort()",
  "const out = path.join(here, '..', '..', '..', 'locales', '_keys.json')",
  '',
  'fs.mkdirSync(path.dirname(out), { recursive: true })',
  "fs.writeFileSync(out, JSON.stringify({ keys: items }, null, 2) + '\\n')",
  ''
].join('\n')

const GENERATED = JSON.stringify({
  steps: [{ cwd: 'apps/desktop', name: 'key catalog', paths: ['locales/_keys.json'], run: ['node', 'scripts/gen-keys.mjs'] }]
})

const generate = cwd => {
  const r = spawnSync(process.execPath, ['scripts/gen-keys.mjs'], {
    cwd: path.join(cwd, 'apps', 'desktop'),
    encoding: 'utf8',
    windowsHide: true
  })

  assert.equal(r.status, 0, r.stdout + r.stderr)
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)

  return r.stdout.trim()
}

function put(root, rel, content) {
  const full = path.join(root, rel)

  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

function commit(cwd, message, env = {}) {
  git(cwd, 'add', '-A')
  spawnSync('git', ['commit', '-q', '-m', message], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
}

function world({ identity = null } = {}) {
  const branch = identity?.branch ?? 'mullvad-vpn'
  const base = identity?.base ?? 'main'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-sync-test-'))
  const official = path.join(root, 'official')
  const fork = path.join(root, 'fork')
  const desktop = path.join(fork, 'apps', 'desktop')

  fs.mkdirSync(official)
  git(official, 'init', '-q', '-b', 'main')
  git(official, 'config', 'user.name', 'Official')
  git(official, 'config', 'user.email', 'official@example.com')
  put(official, 'apps/desktop/electron/main.ts', MAIN_V1)
  put(official, 'apps/desktop/assets/icon.png', LOGO_LIGHT)
  put(official, 'apps/desktop/public/nous-girl.png', LOGO_LIGHT)
  put(official, 'apps/desktop/public/sprite-sheet.png', KNIGHT)
  put(official, 'apps/desktop/package.json', '{}\n')
  put(official, 'apps/desktop/scripts/gen-keys.mjs', GEN_SCRIPT)
  put(official, 'apps/desktop/src/items.txt', 'common.cancel\ncommon.save\n')
  generate(official)
  commit(official, 'official v1')

  // The fork is a shallow clone, like the real one.
  git(root, 'clone', '-q', '--depth=1', pathToFileURL(official).href, 'fork')
  git(fork, 'config', 'user.name', 'Fork')
  git(fork, 'config', 'user.email', 'fork@example.com')
  if (base !== 'main') {
    git(fork, 'branch', base, 'main')
  }

  git(fork, 'switch', '-q', '-c', branch)

  put(fork, 'apps/desktop/electron/main.ts', MAIN_FORK)
  put(fork, 'apps/desktop/electron/vpn.ts', 'export const vpn = {}\n')
  put(fork, 'apps/desktop/src/items.txt', 'vpn.title\ncommon.cancel\ncommon.save\n')
  commit(fork, 'feat: vpn gate')

  fs.mkdirSync(path.join(desktop, 'fork', 'brand'), { recursive: true })
  fs.copyFileSync(path.join(FORK_DIR, 'sync.mjs'), path.join(desktop, 'fork', 'sync.mjs'))
  fs.copyFileSync(path.join(FORK_DIR, 'pack.mjs'), path.join(desktop, 'fork', 'pack.mjs'))
  fs.copyFileSync(path.join(FORK_DIR, 'identity.mjs'), path.join(desktop, 'fork', 'identity.mjs'))
  fs.copyFileSync(path.join(FORK_DIR, 'identity.cjs'), path.join(desktop, 'fork', 'identity.cjs'))
  fs.copyFileSync(path.join(FORK_DIR, 'brand', 'recolor.py'), path.join(desktop, 'fork', 'brand', 'recolor.py'))

  if (identity) {
    fs.mkdirSync(path.join(desktop, 'fork', 'brand', 'hermoso'), { recursive: true })
    fs.copyFileSync(path.join(FORK_DIR, 'brand', 'hermoso.py'), path.join(desktop, 'fork', 'brand', 'hermoso.py'))
    fs.copyFileSync(path.join(FORK_DIR, 'brand', 'hermoso', 'source.png'), path.join(desktop, 'fork', 'brand', 'hermoso', 'source.png'))
    put(fork, 'apps/desktop/fork/identity.json', JSON.stringify(identity))
  }

  put(fork, 'apps/desktop/fork/hooks.json', HOOKS)
  put(fork, 'apps/desktop/fork/generated.json', GENERATED)
  commit(fork, 'feat: fork tooling')

  const tint = spawnSync('python', [path.join('fork', ...(identity?.brand?.script ?? 'brand/recolor.py').split('/')), '--source', desktop], {
    cwd: desktop,
    encoding: 'utf8',
    windowsHide: true
  })

  assert.equal(tint.status, 0, tint.stdout + tint.stderr)
  commit(fork, `brand: ${identity?.brand?.commit ?? 'recolor the logo art'}`)

  generate(fork)
  commit(fork, 'generated: key catalog')

  return {
    base,
    branch,
    desktop,
    fork,
    official,
    root,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true })
  }
}

function sync(w, args) {
  return spawnSync(process.execPath, [path.join(w.desktop, 'fork', 'sync.mjs'), ...args], {
    cwd: w.fork,
    encoding: 'utf8',
    env: { ...process.env, HERMES_DESKTOP_HERMES_ROOT: w.official },
    windowsHide: true
  })
}

const output = r => `${r.stdout}\n${r.stderr}`

function state(w) {
  return {
    branch: git(w.fork, 'rev-parse', '--abbrev-ref', 'HEAD'),
    branches: git(w.fork, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(),
    main: git(w.fork, 'rev-parse', w.base),
    status: git(w.fork, 'status', '--porcelain'),
    tip: git(w.fork, 'rev-parse', w.branch)
  }
}

const read = (w, rel) => fs.readFileSync(path.join(w.desktop, rel))

/** Runs one scenario in a fresh world and always cleans up. */
function scenario(name, fn, options = {}) {
  test(name, { skip: !HAS_PYTHON && 'needs python with pillow + numpy' }, async () => {
    const w = world(options)

    try {
      await fn(w)
    } finally {
      w.cleanup()
    }
  })
}

// ── scenarios ─────────────────────────────────────────────────────────────────────────────

scenario('an upstream update that does not touch the fork is adopted: replayed, art regenerated, refs moved', w => {
  const before = state(w)

  put(w.official, 'apps/desktop/electron/main.ts', MAIN_V1.replace('// main process', '// main process (v2)'))
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official v2')

  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 0, output(r))

  const after = state(w)

  assert.notEqual(after.tip, before.tip)
  assert.equal(after.main, git(w.official, 'rev-parse', 'HEAD'), 'main records the new official commit')
  assert.equal(after.branch, 'mullvad-vpn')
  assert.equal(after.status, '', 'the working tree is clean')
  assert.ok(after.branches.some(b => b.startsWith('backup/mullvad-vpn-')), 'the old tip is kept as a backup branch')
  assert.ok(!after.branches.some(b => b.startsWith('fork-sync/')), 'no scratch branch is left behind')

  const text = read(w, 'electron/main.ts').toString('utf8')

  assert.match(text, /main process \(v2\)/, 'the upstream change is there')
  assert.match(text, /await vpn\.assertReady\(\)/, 'and so is the fork hook')
  assert.ok(fs.existsSync(path.join(w.desktop, 'electron', 'new-thing.ts')))

  assert.deepEqual(git(w.fork, 'log', '--format=%s', 'main..mullvad-vpn').split('\n').map(s => s.split(' (')[0].split(':')[0]), [
    'generated',
    'brand',
    'feat',
    'feat'
  ])

  // the regenerated art is the same tint as before (the official art did not change)
  assert.deepEqual(read(w, 'assets/icon.png'), Buffer.from(spawnSync('git', ['show', `${before.tip}:apps/desktop/assets/icon.png`], { cwd: w.fork }).stdout))
})

scenario('a generated file is regenerated after the replay, never merged', w => {
  // Upstream adds a string AND regenerates the catalog: its copy of _keys.json would conflict with
  // the fork's own. The catalog is derived data, so the fork's "generated:" commit is not replayed.
  put(w.official, 'apps/desktop/src/items.txt', 'common.cancel\ncommon.save\nzzz.new\n')
  generate(w.official)
  commit(w.official, 'official: a new string and a regenerated catalog')

  const check = sync(w, ['--check'])

  assert.equal(check.status, 0, output(check))
  assert.match(output(check), /replays cleanly/)

  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 0, output(r))
  assert.match(git(w.fork, 'log', '-1', '--format=%s'), /^generated: key catalog/)

  // both sides' strings are in the regenerated catalog
  assert.deepEqual(JSON.parse(read(w, '../../locales/_keys.json')).keys, ['common.cancel', 'common.save', 'vpn.title', 'zzz.new'])
  assert.equal(git(w.fork, 'status', '--porcelain'), '')
})

scenario('upstream reshuffles its art: new files are tinted, removed ones are gone, colourful art is left alone', w => {
  put(w.official, 'apps/desktop/assets/icon.png', LOGO_DARK)
  put(w.official, 'apps/desktop/assets/icon-dark.png', LOGO_DARK)
  fs.rmSync(path.join(w.official, 'apps/desktop/public/nous-girl.png'))
  put(w.official, 'apps/desktop/public/nous-girl-v2.png', LOGO_LIGHT)
  put(w.official, 'apps/desktop/public/sprite-sheet.png', KNIGHT)
  commit(w.official, 'official: new logo set')

  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 0, output(r))
  assert.match(git(w.fork, 'log', '-2', '--format=%s'), /^generated: .*\nbrand: /)
  assert.ok(!fs.existsSync(path.join(w.desktop, 'public', 'nous-girl.png')), 'the removed file is gone')
  assert.ok(fs.existsSync(path.join(w.desktop, 'assets', 'icon-dark.png')), 'the new file is there')

  // nothing black-and-white is left anywhere ...
  const check = spawnSync('python', [path.join('fork', 'brand', 'recolor.py'), '--check'], { cwd: w.desktop, encoding: 'utf8' })

  assert.equal(check.status, 0, output(check))

  // ... and the colourful art is byte-identical to upstream's
  assert.deepEqual(read(w, 'public/sprite-sheet.png'), KNIGHT)
})

scenario('a conflicting upstream change is reported, and the fork is left exactly as it was', w => {
  put(w.official, 'apps/desktop/electron/main.ts', MAIN_V1.replace('makePlan()', 'makePlanV2()'))
  commit(w.official, 'official: touches the line next to the hook')

  const before = state(w)

  const check = sync(w, ['--check'])

  assert.equal(check.status, 1, output(check))
  assert.match(output(check), /does NOT apply cleanly/)
  assert.match(output(check), /electron\/main\.ts/)
  assert.match(output(check), /1 hunk/)

  const adopt = sync(w, ['--no-verify', '--no-build'])

  assert.equal(adopt.status, 1, output(adopt))
  assert.deepEqual(state(w), before, 'branches, refs and the working tree are untouched')
})

scenario('--check writes nothing, even when the update applies', w => {
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official v2')

  const before = state(w)
  const r = sync(w, ['--check'])

  assert.equal(r.status, 0, output(r))
  assert.match(output(r), /replays cleanly/)
  assert.deepEqual(state(w), before)
})

scenario('already on the official version: nothing to do', w => {
  const before = state(w)
  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 0, output(r))
  assert.match(output(r), /already on this official version/)
  assert.deepEqual(state(w), before)
})

scenario('a merge that is textually clean but loses a hook is caught and rolled back', w => {
  // upstream renames the file the fork hooks into: git carries the hook along, fork/hooks.json no longer finds it
  git(w.official, 'mv', 'apps/desktop/electron/main.ts', 'apps/desktop/electron/app-main.ts')
  commit(w.official, 'official: rename main.ts')

  const before = state(w)
  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 1, output(r))
  assert.match(output(r), /the file is gone/)
  assert.match(output(r), /rolling back/)
  assert.deepEqual(state(w), before, 'the fork is back exactly where it was')
  assert.ok(fs.existsSync(path.join(w.desktop, 'electron', 'main.ts')), 'and so is the working tree')
})

scenario('--rehearse does the whole replay and then keeps nothing', w => {
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official v2')

  const before = state(w)
  const r = sync(w, ['--rehearse', '--no-verify', '--no-build'])

  assert.equal(r.status, 0, output(r))
  assert.match(output(r), /Rehearsal passed/)
  assert.deepEqual(state(w), before)
  assert.ok(!fs.existsSync(path.join(w.desktop, 'electron', 'new-thing.ts')), 'the working tree is the fork as it was')
})

scenario('refuses to start on a dirty tree', w => {
  put(w.fork, 'apps/desktop/electron/vpn.ts', 'export const vpn = { edited: true }\n')
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official v2')

  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 2, output(r))
  assert.match(output(r), /uncommitted changes/)
})

scenario('refuses a fork stack whose brand commit sits below a normal commit', w => {
  put(w.fork, 'apps/desktop/electron/later.ts', 'export const later = 1\n')
  commit(w.fork, 'feat: something after the brand commit')
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official v2')

  const r = sync(w, ['--check'])

  assert.equal(r.status, 2, output(r))
  assert.match(output(r), /brand/)
})

scenario('refuses to move to an OLDER official version unless forced', w => {
  put(w.official, 'apps/desktop/electron/new-thing.ts', 'export const x = 1\n')
  commit(w.official, 'official, long ago', {
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z'
  })

  const r = sync(w, ['--no-verify', '--no-build'])

  assert.equal(r.status, 2, output(r))
  assert.match(output(r), /OLDER/)
})

scenario('--restack puts the derived commits back on top of normal work committed above them', w => {
  const before = state(w)

  // normal work, committed on top of the brand and generated commits (the order sync.mjs would refuse)
  put(w.fork, 'apps/desktop/electron/extra.ts', 'export const extra = 1\n')
  commit(w.fork, 'feat: extra')

  const refused = sync(w, ['--check'])

  assert.equal(refused.status, 2, output(refused))
  assert.match(output(refused), /derived/)

  const r = sync(w, ['--restack'])

  assert.equal(r.status, 0, output(r))

  const after = state(w)

  assert.equal(after.main, before.main, 'the official base does not move')
  assert.equal(after.status, '', 'the working tree is clean')
  assert.deepEqual(after.branches, before.branches, 'no backup or scratch branch is left behind')
  assert.ok(fs.existsSync(path.join(w.desktop, 'electron', 'extra.ts')), 'the normal commit is kept')

  assert.deepEqual(
    git(w.fork, 'log', '--format=%s', `${w.base}..${w.branch}`)
      .split('\n')
      .map(subject => subject.replace(/ \(regenerated on [0-9a-f]+\)$/, '')),
    ['generated: key catalog', 'brand: recolor the logo art to #E100FF', 'feat: extra', 'feat: fork tooling', 'feat: vpn gate']
  )

  // and it is a valid stack again: the ordinary check passes
  const check = sync(w, ['--check'])

  assert.equal(check.status, 0, output(check))
})

scenario(
  'a fork with its own identity (Hermoso) moves on its own branches, leaves the other fork alone and draws its own art',
  w => {
    assert.equal(w.branch, HERMOSO.branch)
    assert.equal(w.base, HERMOSO.base)

    const before = state(w)
    const otherForkBase = git(w.fork, 'rev-parse', 'main')

    // `main` is where the OTHER fork (Hermes (Mullvad)) records its official commit: it must stay put
    assert.equal(otherForkBase, before.main)

    put(w.official, 'apps/desktop/electron/main.ts', MAIN_V1.replace('// main process', '// main process (v2)'))
    commit(w.official, 'official v2')

    const r = sync(w, ['--no-verify', '--no-build'])

    assert.equal(r.status, 0, output(r))

    const after = state(w)

    assert.equal(after.branch, HERMOSO.branch)
    assert.notEqual(after.tip, before.tip)
    assert.equal(after.main, git(w.official, 'rev-parse', 'HEAD'), 'the base branch records the new official commit')
    assert.equal(git(w.fork, 'rev-parse', 'main'), otherForkBase, 'the other fork`s base branch is not touched')
    assert.equal(after.status, '', 'the working tree is clean')
    assert.ok(after.branches.some(b => b.startsWith(`backup/${HERMOSO.branch}-`)), 'the old tip is kept as a backup branch')

    assert.deepEqual(
      git(w.fork, 'log', '--format=%s', `${HERMOSO.base}..${HERMOSO.branch}`)
        .split('\n')
        .map(subject => subject.replace(/ \(regenerated on [0-9a-f]+\)$/, '')),
      ['generated: key catalog', `brand: ${HERMOSO.brand.commit}`, 'feat: fork tooling', 'feat: vpn gate']
    )

    // the art is Hermoso's (its signature is inside every image), not the Mullvad fork's tint
    assert.ok(read(w, 'assets/icon.png').includes('hermoso-art/1'), 'the icon is drawn by the Hermoso script')

    const check = spawnSync('python', [path.join('fork', 'brand', 'hermoso.py'), '--check'], {
      cwd: w.desktop,
      encoding: 'utf8',
      windowsHide: true
    })

    assert.equal(check.status, 0, check.stdout + check.stderr)
  },
  { identity: HERMOSO }
)

test('parseMergeTree reads the tree, the conflicted files and their kinds', () => {
  const parsed = parseMergeTree(
    [
      'dada0c27676924fa2672a444eff44674855f6db2',
      'apps/desktop/DESIGN.md',
      'apps/desktop/public/nous-badge.png',
      '',
      'Auto-merging apps/desktop/DESIGN.md',
      'CONFLICT (content): Merge conflict in apps/desktop/DESIGN.md',
      'CONFLICT (modify/delete): apps/desktop/public/nous-badge.png deleted in origin/main and modified in mullvad-vpn.'
    ].join('\n')
  )

  assert.equal(parsed.tree, 'dada0c27676924fa2672a444eff44674855f6db2')
  assert.deepEqual(parsed.files, [
    { file: 'apps/desktop/DESIGN.md', kind: 'content' },
    { file: 'apps/desktop/public/nous-badge.png', kind: 'modify/delete' }
  ])
})
