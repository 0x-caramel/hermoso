// The installer of this fork (Hermes (Mullvad), Hermoso: fork/identity.json): an NSIS setup built around the app that fork/pack.mjs already built
// and tested. It is not the official packaging (MSIX needs the publisher's signing certificate); it only
// wraps the unpacked app, so the bytes the installer installs are the bytes that were verified.
//
// Used by fork/installer/build.mjs through `--prepackaged`, never through the repo's own builder wrapper
// (that one admits MSIX only). Per-user install, no administrator prompt, no auto-update feed: the owner
// sends a new installer after each alignment with the official Hermes.
// @ts-check
'use strict'

const path = require('node:path')
const { readIdentity } = require('../identity.cjs')

const identity = readIdentity(path.resolve(__dirname, '..', '..'))
const version = process.env.HERMES_FORK_INSTALLER_VERSION || '0.0.0'
const NAME = identity.displayName

/** @satisfies {import("app-builder-lib").Configuration} */
module.exports = {
  // The same AppUserModelID the app sets at runtime (electron/main.ts): the Start Menu shortcut, the taskbar
  // button and the app's windows are then ONE thing, with the magenta icon.
  appId: identity.appId,
  productName: NAME,
  executableName: identity.executable,
  artifactName: `${identity.installer.artifact}-\${version}.\${ext}`,
  copyright: `Hermes is MIT licensed, (c) Nous Research. ${identity.displayName} is an unofficial fork.`,
  icon: 'assets/icon.ico',
  publish: null,
  directories: { output: process.env.HERMES_FORK_INSTALLER_OUT || 'release/installer' },
  extraMetadata: {
    // The per-user install folder is named after this ("Programs\<packageName>"): not "Programs\hermes",
    // which would read as the official Hermes.
    name: identity.installer.packageName,
    version,
    author: { name: identity.installer.publisher }
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon.ico'
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: identity.shortcutName,
    uninstallDisplayName: NAME,
    // Everything that is the person's (chats, keys, the Hermes install under %LOCALAPPDATA%\hermes) stays
    // when the app is removed: uninstalling must never cost them their data.
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    differentialPackage: false
  }
}
