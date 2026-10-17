// fork/identity.cjs — who this fork is, in one place.
//
// The fork's names (what it is called, its AppUserModelID, its installer, which branch it lives on,
// which script draws its logo) are data in fork/identity.json. The Mullvad fork that Hermoso grew
// from has no such file: its names are DEFAULT below, so every script behaves as it always did
// there. CommonJS on purpose: the installer config (.cjs), product-identity.cjs and the ES modules
// of fork/ (through createRequire, see identity.mjs) all read it.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT = Object.freeze({
  id: 'mullvad',
  branch: 'mullvad-vpn',
  /** The branch that records the official commit this fork sits on. */
  base: 'main',
  displayName: 'Hermes (Mullvad)',
  /** The .exe inside release/win-unpacked, without the extension. */
  executable: 'Hermes',
  /** Also the AppUserModelID: the taskbar button, the icon and the notifications are its. */
  appId: 'com.nousresearch.hermes.mullvad',
  shortcutName: 'Hermes (Mullvad)',
  wordmark: null,
  installer: Object.freeze({
    packageName: 'hermes-mullvad',
    artifact: 'Hermes-Mullvad-Setup',
    publisher: 'Hermes (Mullvad), unofficial fork of Hermes'
  }),
  brand: Object.freeze({
    script: 'brand/recolor.py',
    label: 'the recolored logo art',
    /** The subject of the derived "brand:" commit sync.mjs writes after every replay. */
    commit: 'recolor the logo art to #E100FF'
  })
})

/** apps/desktop of the checkout this file sits in. */
const DESKTOP = path.resolve(__dirname, '..')

function identityFile(desktop = DESKTOP) {
  return path.join(desktop, 'fork', 'identity.json')
}

/** DEFAULT overlaid with fork/identity.json (the nested installer/brand objects merge field by field). */
function readIdentity(desktop = DESKTOP) {
  let raw = {}

  try {
    raw = JSON.parse(fs.readFileSync(identityFile(desktop), 'utf8').replace(/^﻿/, ''))
  } catch {
    raw = {}
  }

  // `_` is the file's own comment line
  // eslint-disable-next-line no-unused-vars
  const { _, ...rest } = raw

  return {
    ...DEFAULT,
    ...rest,
    installer: { ...DEFAULT.installer, ...(rest.installer ?? {}) },
    brand: { ...DEFAULT.brand, ...(rest.brand ?? {}) }
  }
}

/** The variable that tells the build (product-identity.cjs, vite.config.ts) to use fork/identity.json. */
function identityEnv(desktop = DESKTOP) {
  const file = identityFile(desktop)

  return fs.existsSync(file) ? { HERMES_FORK_IDENTITY: file } : {}
}

module.exports = { DEFAULT, DESKTOP, identityEnv, identityFile, readIdentity }
