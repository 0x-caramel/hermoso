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

const DESKTOP = path.resolve(import.meta.dirname, '..')
const IS_WINDOWS = process.platform === 'win32'

/** The environment that makes write-build-stamp.mjs pin `sha` (an official commit). */
export function stampEnv(sha, branch = 'main') {
  return { GITHUB_REF_NAME: branch, GITHUB_SHA: sha }
}

/** The official commit the fork sits on: what branch `main` records. */
export function officialBase(cwd = DESKTOP) {
  const r = spawnSync('git', ['rev-parse', 'main'], { cwd, encoding: 'utf8', windowsHide: true })

  if (r.status !== 0) {
    throw new Error(`cannot resolve branch "main" (the official base commit): ${(r.stderr || '').trim()}`)
  }

  return r.stdout.trim()
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

  console.log('[fork-pack] done: release/win-unpacked/Hermes.exe (Start Menu: "Hermes (Mullvad)")')
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[fork-pack] failed: ${error.message}`)
    process.exitCode = 1
  }
}
