// ES-module face of fork/identity.cjs, for the scripts of fork/ (pack, sync, installer).
import { createRequire } from 'node:module'

const identity = createRequire(import.meta.url)('./identity.cjs')

export const { DEFAULT, DESKTOP, identityEnv, identityFile, readIdentity } = identity
