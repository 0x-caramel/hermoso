#!/usr/bin/env node
/**
 * fork/pack.mjs — rebuild the fork exactly like `npm run pack`, with one difference that matters:
 * the bundle is stamped with the OFFICIAL commit the fork sits on, not with the fork's own commit.
 *
 * The stamp (build/install-stamp.json, shipped as resources/install-stamp.json) says which official
 * commit this desktop belongs to. Two things read it:
 *   - the bundle-skew banner: after an official update moved the runtime ahead of the desktop, the
 *     app says so. An unknown commit (the fork's own) silences that check for good, and it is the
 *     signal that tells you to run fork/sync.mjs;
 *   - the first-launch bootstrap, which pins the runtime it installs to that commit, so the commit
 *     must exist upstream.
 * write-build-stamp.mjs takes the commit from GITHUB_SHA / GITHUB_REF_NAME when they are set (its CI
 * path), so no upstream file has to change.
 *
 *   node fork/pack.mjs                build, pack, refresh the Start Menu shortcut
 *   node fork/pack.mjs --no-shortcut  leave the shortcut alone
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { identityEnv, readIdentity } from './identity.mjs'

const DESKTOP = path.resolve(import.meta.dirname, '..')
const IS_WINDOWS = process.platform === 'win32'

// Who this fork is (fork/identity.json; the Mullvad fork has none and keeps its defaults).
const IDENTITY = readIdentity(DESKTOP)

/** The environment that makes write-build-stamp.mjs pin `sha` (an official commit). */
export function stampEnv(sha, branch = 'main') {
  // HERMES_FORK_IDENTITY: the fork's names reach product-identity.cjs and vite.config.ts (see identity-override.cjs)
  return { GITHUB_REF_NAME: branch, GITHUB_SHA: sha, ...identityEnv(DESKTOP) }
}

/**
 * The official commit the fork sits on: what its base branch (`main`, or `hermoso-base`) records. A fresh clone has no
 * local branch of that name, only `origin/<base>`, so the remote-tracking one counts too.
 */
export function officialBase(cwd = DESKTOP) {
  const git = args => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  const commit = ref => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])

  let found = commit(IDENTITY.base)

  if (found.status !== 0) {
    const tracking = git(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${IDENTITY.base}`])
      .stdout.split(/\r?\n/)
      .find(Boolean)

    if (tracking) {
      found = commit(tracking)
    }
  }

  if (found.status !== 0) {
    throw new Error(
      `cannot find the branch "${IDENTITY.base}" (it records the official Hermes commit this fork sits on). ` +
        `A normal clone has it as origin/${IDENTITY.base}; if you cloned a single branch, run: ` +
        `git fetch origin ${IDENTITY.base}:refs/remotes/origin/${IDENTITY.base}`
    )
  }

  return found.stdout.trim()
}

export function readStamp(file = path.join(DESKTOP, 'build', 'install-stamp.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function run(command, args, env = {}) {
  // npm/npx are .cmd shims on Windows; they need a shell, and one command string avoids Node's
  // "args with shell: true" deprecation.
  const useShell = IS_WINDOWS && /^(npm|npx)$/.test(command)
  const r = useShell
    ? spawnSync([command, ...args].join(' '), { cwd: DESKTOP, env: { ...process.env, ...env }, shell: true, stdio: 'inherit', windowsHide: true })
    : spawnSync(command, args, { cwd: DESKTOP, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true })

  if (r.error) {
    throw r.error
  }

  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${r.status})`)
  }
}

function assertStamped(file, sha, label) {
  const stamp = readStamp(file)

  if (stamp.commit !== sha) {
    throw new Error(`${label} is stamped ${String(stamp.commit).slice(0, 12)}, expected the official ${sha.slice(0, 12)}`)
  }

  console.log(`[fork-pack] ${label}: stamped with official ${sha.slice(0, 12)} (${stamp.branch})`)
}

function main(argv) {
  const base = officialBase()
  const env = stampEnv(base)

  run('npm', ['run', 'build'], env)
  assertStamped(path.join(DESKTOP, 'build', 'install-stamp.json'), base, 'build stamp')

  run('npm', ['run', 'builder', '--', '--dir', '--publish', 'never'], env)
  assertStamped(path.join(DESKTOP, 'release', 'win-unpacked', 'resources', 'install-stamp.json'), base, 'packed stamp')

  if (IS_WINDOWS && !argv.includes('--no-shortcut')) {
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join('fork', 'install-shortcut.ps1')])
  }

  console.log(`[fork-pack] done: release/win-unpacked/${IDENTITY.executable}.exe (Start Menu: "${IDENTITY.shortcutName}")`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[fork-pack] failed: ${error.message}`)
    process.exitCode = 1
  }
}
