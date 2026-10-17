// fork/identity-override.cjs — lets product-identity.cjs (upstream's one source of names) carry a fork's names.
//
// Active only when HERMES_FORK_IDENTITY names a fork/identity.json (the fork's scripts set it for every
// build). Then the product name, the executable and the app id are the fork's; everything else stays
// upstream's, notably `appNamePascal`: it names the userData folder and the single-instance lock, which
// the fork keeps shared with Hermes on purpose. Without the variable (tests, `npm run dev`, a plain
// `npm run pack`) this is the identity function and upstream's tests see upstream's names.
'use strict'

const fs = require('node:fs')

module.exports = function applyForkIdentity(identity) {
  const file = process.env.HERMES_FORK_IDENTITY

  if (!file) {
    return identity
  }

  let fork

  try {
    fork = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return identity
  }

  const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

  return Object.freeze({
    ...identity,
    appId: text(fork.appId) ?? identity.appId,
    displayName: text(fork.displayName) ?? identity.displayName,
    windowsExecutableName: text(fork.executable) ?? identity.windowsExecutableName
  })
}
