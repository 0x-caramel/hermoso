#!/usr/bin/env node
/**
 * fork/installer/build.mjs — the installer you give to someone: Hermes-Mullvad-Setup-<version>.exe.
 *
 *   node fork/installer/build.mjs                  wrap release/win-unpacked (built by fork/pack.mjs) in a setup
 *   node fork/installer/build.mjs --version 2026.10.1   name the build yourself (default: today, YYYY.M.D)
 *   node fork/installer/build.mjs --out <dir>      where the setup goes (default: apps/desktop/release/installer)
 *
 * It never rebuilds the app. It packages exactly the tree fork/pack.mjs produced, so what the other
 * person installs is what was tested here. Run fork/pack.mjs first after every change or alignment.
 *
 * What the person gets (see FORK.md, "Giving it to someone"): a per-user install (no administrator
 * prompt) with a Start Menu and Desktop shortcut "Hermes (Mullvad)" carrying the magenta icon and the
 * fork's own AppUserModelID, and an entry in Apps & features to remove it. Their data is never part
 * of it and never removed by it. The app they get has no "Update now" (electron/fork-update.ts,
 * `updateMechanism`): they get a new installer from you after each alignment, and installing it over
 * the old one keeps everything.
 *
 * The setup is not signed (that needs a publisher certificate): Windows SmartScreen shows "Unknown
 * publisher" once, "More info" then "Run anyway".
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DESKTOP = path.resolve(import.meta.dirname, '..', '..')
const REPO = path.resolve(DESKTOP, '..', '..')
const UNPACKED = path.join(DESKTOP, 'release', 'win-unpacked')
const CONFIG = path.join(import.meta.dirname, 'electron-builder.nsis.cjs')

const NOTE = `Hermes (Mullvad)
================

Hermes Desktop (Nous Research, MIT licence) with two additions, in a build that is NOT official:

  - Mullvad VPN: when it starts, the app connects Mullvad and keeps Hermes waiting until the
    tunnel is up. You need Mullvad VPN installed and an account logged in (https://mullvad.net).
  - a magenta logo.

The first time it starts it installs Hermes itself (a few minutes, it needs the internet).
It does not carry anyone's chats, keys or settings: you start from zero.

Updates are not done from inside the app: whoever gave you this sends a new installer, and installing
it over this one keeps your data. To remove it: Settings > Apps > Hermes (Mullvad). Your data stays
(%LOCALAPPDATA%\\hermes); delete that folder by hand if you want it gone too.
`

function fail(message) {
  console.error(`[fork-installer] ${message}`)
  process.exit(1)
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true })

  return r.status === 0 ? r.stdout.trim() : null
}

export function today(date = new Date()) {
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`
}

export function parseArgs(argv) {
  const options = { out: path.join(DESKTOP, 'release', 'installer'), version: today() }

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') {
      options.version = argv[++i]
    } else if (argv[i] === '--out') {
      options.out = path.resolve(argv[++i])
    } else {
      throw new Error(`unknown option ${argv[i]}`)
    }
  }

  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(options.version ?? '')) {
    throw new Error(`the version must look like 2026.10.1, got "${options.version}"`)
  }

  return options
}

function main() {
  if (process.platform !== 'win32') {
    fail('the installer is built on Windows')
  }

  let options

  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
  }

  if (!fs.existsSync(path.join(UNPACKED, 'Hermes.exe'))) {
    fail(`${UNPACKED} has no Hermes.exe: run "node fork/pack.mjs" first`)
  }

  // The app must be the one the fork's current official base asks for.
  const stamp = JSON.parse(fs.readFileSync(path.join(UNPACKED, 'resources', 'install-stamp.json'), 'utf8').replace(/^﻿/, ''))
  const base = git(['rev-parse', 'main'])

  if (base && stamp.commit !== base) {
    fail(`the built app is stamped ${String(stamp.commit).slice(0, 8)}, the fork sits on ${base.slice(0, 8)}: run "node fork/pack.mjs"`)
  }

  const dirty = git(['status', '--porcelain'])

  if (dirty) {
    console.warn('[fork-installer] WARNING: the working tree has uncommitted changes; the app may not match HEAD')
  }

  // A staging copy: the license and a note go in, the deployed build stays as it is.
  const staging = path.join(DESKTOP, 'release', 'installer-staging')
  const app = path.join(staging, 'win-unpacked')

  fs.rmSync(staging, { force: true, recursive: true })
  fs.mkdirSync(staging, { recursive: true })
  console.log('[fork-installer] copying the built app ...')

  const robocopy = spawnSync('robocopy', [UNPACKED, app, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16'], { windowsHide: true })

  if (robocopy.status === null || robocopy.status >= 8) {
    fail(`robocopy failed (exit ${robocopy.status})`)
  }

  fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(app, 'LICENSE.hermes.txt'))
  fs.writeFileSync(path.join(app, 'LEGGIMI.txt'), NOTE.replace(/\n/g, '\r\n'), 'utf8')

  fs.mkdirSync(options.out, { recursive: true })

  const builderRoot = path.join(REPO, 'node_modules', 'electron-builder')
  const bin = JSON.parse(fs.readFileSync(path.join(builderRoot, 'package.json'), 'utf8')).bin['electron-builder']

  console.log(`[fork-installer] building the setup ${options.version} (the first run downloads NSIS) ...`)

  const built = spawnSync(
    process.execPath,
    [path.join(builderRoot, bin), '--win', 'nsis', '--x64', '--prepackaged', app, '--config', CONFIG, '--publish', 'never'],
    {
      cwd: DESKTOP,
      env: { ...process.env, HERMES_MULLVAD_INSTALLER_OUT: options.out, HERMES_MULLVAD_INSTALLER_VERSION: options.version },
      stdio: 'inherit',
      windowsHide: true
    }
  )

  fs.rmSync(staging, { force: true, recursive: true })

  if (built.status !== 0) {
    fail(`electron-builder failed (exit ${built.status})`)
  }

  const setup = path.join(options.out, `Hermes-Mullvad-Setup-${options.version}.exe`)

  if (!fs.existsSync(setup)) {
    fail(`electron-builder finished but ${setup} is not there`)
  }

  const sha = crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex')
  const mb = (fs.statSync(setup).size / 1024 / 1024).toFixed(0)

  console.log(`\n[fork-installer] done: ${setup}\n  ${mb} MB, SHA-256 ${sha}\n  official base ${String(stamp.commit).slice(0, 8)}, built ${stamp.builtAt}`)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  main()
}
