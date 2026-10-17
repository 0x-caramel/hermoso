import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createFileSettingsStore, createSettings, DEFAULT_SETTINGS, sanitizeSettings } from './settings'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-settings-'))

  dirs.push(dir)

  return dir
}

const ON = { guardian: true, timeMachine: true }

describe('the settings', () => {
  it('start from the defaults: the guardian and the time machine are on', () => {
    expect(DEFAULT_SETTINGS).toEqual(ON)

    for (const raw of [null, undefined, 'x', 7, [], {}, { guardian: 'no' }, { guardian: 0, timeMachine: 'off' }]) {
      expect(sanitizeSettings(raw), JSON.stringify(raw)).toEqual(ON)
    }

    expect(sanitizeSettings({ guardian: false })).toEqual({ ...ON, guardian: false })
    expect(sanitizeSettings({ timeMachine: false })).toEqual({ ...ON, timeMachine: false })
  })

  it('keep what the person chose, in a file, across launches', () => {
    const file = path.join(temp(), 'hermoso', 'settings.json')

    expect(createSettings(createFileSettingsStore(file)).set({ guardian: false })).toEqual({ ...ON, guardian: false })
    expect(createSettings(createFileSettingsStore(file)).set({ timeMachine: false })).toEqual({
      guardian: false,
      timeMachine: false
    })
    expect(createSettings(createFileSettingsStore(file)).get()).toEqual({ guardian: false, timeMachine: false })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ guardian: false, timeMachine: false, version: 1 })
  })

  it('ignore keys they do not know and values of the wrong kind', () => {
    const settings = createSettings({ read: () => null, write: () => {} })

    expect(settings.set({ guardian: 'off', other: true, timeMachine: 0 })).toEqual(ON)
    expect(settings.set(null)).toEqual(ON)
    expect(settings.set({ guardian: false })).toEqual({ ...ON, guardian: false })
    expect(settings.set({ nonsense: 1 })).toEqual({ ...ON, guardian: false })
  })

  it('hand out copies', () => {
    const settings = createSettings({ read: () => null, write: () => {} })

    settings.get().guardian = false
    expect(settings.get().guardian).toBe(true)
  })

  it('a damaged file reads as the defaults', () => {
    const file = path.join(temp(), 'settings.json')

    fs.writeFileSync(file, '{ not json')
    expect(createSettings(createFileSettingsStore(file)).get()).toEqual(ON)
  })
})
