/**
 * Hermoso's own settings, in a small file in the app's data folder (main process, Electron-free). Only what the
 * person switches on or off lives here; every key has a default and a reader that ignores anything it does not know.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface HermosoSettings {
  /** Review risky commands and ask before they run. A "block" rule is enforced whatever this says. */
  guardian: boolean
  /** Let Hermes snapshot the project folder before the agent first changes a file in a turn (read at launch). */
  timeMachine: boolean
}

export const DEFAULT_SETTINGS: HermosoSettings = { guardian: true, timeMachine: true }

export interface SettingsStore {
  read: () => unknown
  write: (value: HermosoSettings & { version: 1 }) => void
}

export function sanitizeSettings(raw: unknown): HermosoSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  return {
    guardian: typeof source.guardian === 'boolean' ? source.guardian : DEFAULT_SETTINGS.guardian,
    timeMachine: typeof source.timeMachine === 'boolean' ? source.timeMachine : DEFAULT_SETTINGS.timeMachine
  }
}

export function createFileSettingsStore(file: string): SettingsStore {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },

    write(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true })

      const temp = `${file}.${process.pid}.tmp`

      fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(temp, file)
    }
  }
}

export function createSettings(store: SettingsStore) {
  let current = sanitizeSettings(store.read())

  return {
    get: (): HermosoSettings => ({ ...current }),

    /** Change some settings: keys that are not known, or values of the wrong kind, are ignored. */
    set(patch: unknown): HermosoSettings {
      const source = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}

      current = sanitizeSettings({
        ...current,
        ...(typeof source.guardian === 'boolean' ? { guardian: source.guardian } : {}),
        ...(typeof source.timeMachine === 'boolean' ? { timeMachine: source.timeMachine } : {})
      })
      store.write({ ...current, version: 1 })

      return { ...current }
    }
  }
}

export type Settings = ReturnType<typeof createSettings>
