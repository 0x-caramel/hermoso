import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BRIDGE_FILE, bridgeFilePath, removeBridgeFile, writeBridgeFile } from './bridge-file'

const dirs: string[] = []

const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-bridge-file-'))

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe('publishing the bridge address for the plugin', () => {
  it('writes it next to the plugin, in the Hermes home', () => {
    const dir = home()
    const file = writeBridgeFile(dir, { token: 'secret', url: 'http://127.0.0.1:5555' }, () => 42)

    expect(file).toBe(bridgeFilePath(dir))
    expect(path.basename(file)).toBe(BRIDGE_FILE)
    expect(path.basename(path.dirname(file))).toBe('hermoso')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      pid: process.pid,
      startedAt: 42,
      token: 'secret',
      url: 'http://127.0.0.1:5555'
    })
  })

  it('replaces the file of a previous run, leaving nothing half-written beside it', () => {
    const dir = home()

    writeBridgeFile(dir, { token: 'old', url: 'http://127.0.0.1:1' })
    writeBridgeFile(dir, { token: 'new', url: 'http://127.0.0.1:2' })

    expect(JSON.parse(fs.readFileSync(bridgeFilePath(dir), 'utf8')).token).toBe('new')
    expect(fs.readdirSync(path.dirname(bridgeFilePath(dir)))).toEqual([BRIDGE_FILE])
  })

  it('takes the address back on the way out, but only the one this process wrote', () => {
    const dir = home()

    writeBridgeFile(dir, { token: 't', url: 'http://127.0.0.1:1' })
    removeBridgeFile(dir)
    expect(fs.existsSync(bridgeFilePath(dir))).toBe(false)

    // another Hermoso (another process) published its own: not ours to remove
    fs.mkdirSync(path.dirname(bridgeFilePath(dir)), { recursive: true })
    fs.writeFileSync(
      bridgeFilePath(dir),
      JSON.stringify({ pid: process.pid + 1, token: 't', url: 'http://127.0.0.1:1' })
    )
    removeBridgeFile(dir)
    expect(fs.existsSync(bridgeFilePath(dir))).toBe(true)
  })

  it('removing what is not there, or is not readable, is not an error', () => {
    const dir = home()

    expect(() => removeBridgeFile(dir)).not.toThrow()
    fs.mkdirSync(path.dirname(bridgeFilePath(dir)), { recursive: true })
    fs.writeFileSync(bridgeFilePath(dir), '{ not json')
    expect(() => removeBridgeFile(dir)).not.toThrow()
  })
})
