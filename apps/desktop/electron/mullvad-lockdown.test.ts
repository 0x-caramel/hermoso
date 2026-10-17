import { describe, expect, it, vi } from 'vitest'

import { type CliResult, createMullvadClient, parseLockdown } from './mullvad'

describe('parseLockdown (real `mullvad lockdown-mode get`, mullvad-cli 2026.5)', () => {
  it('reads on and off', () => {
    expect(parseLockdown('Block traffic when the VPN is disconnected: off')).toBe(false)
    expect(parseLockdown('Block traffic when the VPN is disconnected: on\r\n')).toBe(true)
    expect(parseLockdown('block traffic when the vpn is disconnected:   ON')).toBe(true)
  })

  it('anything else is unknown, never a guess', () => {
    expect(parseLockdown('')).toBeNull()
    expect(parseLockdown('Error: daemon not running')).toBeNull()
    expect(parseLockdown('Block traffic when the VPN is disconnected: maybe')).toBeNull()
  })
})

describe('the client and lockdown mode', () => {
  const cli = 'C:\\mullvad.exe'

  const make = (run: (file: string, args: string[]) => Promise<CliResult>) =>
    createMullvadClient({
      env: { HERMES_MULLVAD_CLI: cli },
      exists: candidate => candidate === cli,
      platform: 'win32',
      run
    })

  it('reads it, and sets it on or off with the exact arguments', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => ({
      code: 0,
      stderr: '',
      stdout:
        args[0] === 'lockdown-mode' && args[1] === 'get' ? 'Block traffic when the VPN is disconnected: off\n' : ''
    }))

    const client = make(run)

    expect(await client.lockdownGet()).toBe(false)
    await client.lockdownSet(true)
    await client.lockdownSet(false)

    expect(run.mock.calls.map(call => call[1])).toEqual([
      ['lockdown-mode', 'get'],
      ['lockdown-mode', 'set', 'on'],
      ['lockdown-mode', 'set', 'off']
    ])
  })

  it('a failing read is unknown', async () => {
    expect(
      await make(async () => ({ code: 1, stderr: 'Error: Failed to connect to daemon', stdout: '' })).lockdownGet()
    ).toBeNull()
  })
})
