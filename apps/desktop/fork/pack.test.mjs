/**
 * `officialBase` finds the official commit the fork sits on, also in a fresh clone (where the base branch exists only
 * as `origin/hermoso-base`), and says what to do when it cannot.
 *
 *   node --test fork/pack.test.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { readIdentity } from './identity.mjs'
import { officialBase } from './pack.mjs'

const BASE = readIdentity(path.resolve(import.meta.dirname, '..')).base

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })

  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)

  return r.stdout.trim()
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-pack-test-'))
}

/** A repository like the published one: the base branch on the official commit, the fork branch two commits ahead. */
function published() {
  const dir = tempDir()

  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'official')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'official')

  const official = git(dir, 'rev-parse', 'HEAD')

  git(dir, 'branch', BASE)
  git(dir, 'switch', '-q', '-c', 'hermoso')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'fork')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'fork')

  return { dir, official }
}

test('finds the base branch where it is a local branch', () => {
  const { dir, official } = published()

  assert.equal(officialBase(dir), official)
})

test('finds it in a fresh clone, where only origin/<base> exists', () => {
  const { dir, official } = published()
  const clone = path.join(tempDir(), 'clone')

  git(dir, 'switch', '-q', 'hermoso')
  git(path.dirname(clone), 'clone', '-q', dir, clone)

  // a clone has the fork branch checked out and no local branch named like the base
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', BASE], { cwd: clone }).status, 1)
  assert.equal(officialBase(clone), official)
})

test('says how to get the base branch when a clone has only one branch', () => {
  const { dir } = published()
  const clone = path.join(tempDir(), 'single')

  git(dir, 'switch', '-q', 'hermoso')
  git(path.dirname(clone), 'clone', '-q', '--single-branch', '--branch', 'hermoso', dir, clone)

  assert.throws(
    () => officialBase(clone),
    error => error.message.includes(`git fetch origin ${BASE}:refs/remotes/origin/${BASE}`)
  )
})
