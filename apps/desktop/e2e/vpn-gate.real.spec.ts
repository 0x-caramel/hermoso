/**
 * OPT-IN e2e: the VPN gate against the REAL Mullvad app installed on this machine.
 *
 *   HERMES_E2E_REAL_MULLVAD=1 HERMES_E2E_HERMES_ROOT=<runtime with a Python env> \
 *     npx playwright test e2e/vpn-gate.real.spec.ts
 *
 * It really connects your VPN (and restores the state it found: a tunnel that was
 * disconnected is disconnected again afterwards). It never logs in, never touches
 * account or relay settings, and skips itself unless Mullvad is installed, logged in
 * and `HERMES_E2E_REAL_MULLVAD=1` is set. The scripted-CLI suite (vpn-gate.spec.ts)
 * covers the same behaviour without touching your network and is what CI runs.
 *
 * What only the real daemon can prove: our CLI discovery and output parsing match the
 * installed Mullvad, `connect` really brings the tunnel up before the backend starts,
 * loopback to the local backend works under the tunnel, and the app's own network
 * traffic leaves through Mullvad (am.i.mullvad.net reports a Mullvad exit).
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Page } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../tests-js/scripts/mock-server'
import { buildAppEnv, createSandbox, launchDesktop, waitForAppReady } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

function findMullvad(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Mullvad VPN', 'resources', 'mullvad.exe')]
      : ['/usr/bin/mullvad', '/usr/local/bin/mullvad', '/Applications/Mullvad VPN.app/Contents/Resources/mullvad']

  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

const MULLVAD = findMullvad()

function mullvad(...args: string[]): string {
  return execFileSync(MULLVAD!, args, { encoding: 'utf8', timeout: 20_000 })
}

function tunnelState(): string {
  try {
    return mullvad('status').split(/\r?\n/)[0].trim() || 'Connecting'
  } catch (error) {
    return `unreadable (${String(error)})`
  }
}

function loggedIn(): boolean {
  try {
    return /Mullvad account\s*:/i.test(mullvad('account', 'get'))
  } catch {
    return false
  }
}

async function waitForTunnel(state: RegExp, timeoutMs = 30_000) {
  await expect.poll(tunnelState, { intervals: [500], timeout: timeoutMs }).toMatch(state)
}

async function waitForBackendReady(page: Page, timeoutMs = 120_000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const desktop = (
            window as unknown as { hermesDesktop: { getBootProgress: () => Promise<{ phase: string }> } }
          ).hermesDesktop

          return (await desktop.getBootProgress()).phase
        }),
      { intervals: [500], message: 'main never reported the backend as ready', timeout: timeoutMs }
    )
    .toBe('backend.ready')
}

async function launchReal() {
  const mock = await startMockServer()
  const sandbox = createSandbox('real-mullvad')

  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)

  const env = buildAppEnv(sandbox, {
    // See vpn-gate.spec.ts: a fresh sandbox home must not make the backend install a toolchain first.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_DESKTOP_HERMES_ROOT: process.env.HERMES_E2E_HERMES_ROOT ?? buildAppEnv(sandbox).HERMES_DESKTOP_HERMES_ROOT,
    HERMES_DESKTOP_VPN: 'on'
  })

  // Discovery must find the real install on its own.
  delete (env as Record<string, string | undefined>).HERMES_MULLVAD_CLI

  const { app, page } = await launchDesktop(env)

  return {
    app,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    },
    page,
    sandbox
  }
}

test.describe('Mullvad VPN gate — real daemon', () => {
  test.describe.configure({ mode: 'serial' })

  let initial = 'unknown'

  test.beforeAll(() => {
    initial = MULLVAD ? tunnelState() : 'unknown'
  })

  test.beforeEach(() => {
    test.setTimeout(300_000)
    allowErrorBanners()

    test.skip(process.env.HERMES_E2E_REAL_MULLVAD !== '1', 'set HERMES_E2E_REAL_MULLVAD=1 to run against the real Mullvad')
    test.skip(!MULLVAD, 'Mullvad VPN is not installed')
    test.skip(!loggedIn(), 'Mullvad is not signed in to an account')
  })

  // Whatever a test did, leave the tunnel the way it was found.
  test.afterAll(async () => {
    if (MULLVAD && /^Disconnected/.test(initial) && !/^Disconnected/.test(tunnelState())) {
      mullvad('disconnect')
      await waitForTunnel(/^Disconnected/)
    }
  })

  test('connects the real tunnel before the backend starts, and the app’s traffic leaves through Mullvad', async () => {
    test.skip(!/^Disconnected/.test(initial), `the tunnel is "${initial}"; this scenario needs it disconnected`)

    const run = await launchReal()

    try {
      // Asked of main's own network stack (net.fetch) from the very start. The egress gate holds it
      // until the tunnel is up, so whenever it is answered it must already be a Mullvad exit.
      const early = run.app.evaluate(async ({ net }) => {
        const response = await net.fetch('https://am.i.mullvad.net/json')

        return (await response.json()) as { mullvad_exit_ip?: boolean }
      })

      await waitForBackendReady(run.page)
      await waitForAppReady(run, 120_000)

      expect((await early).mullvad_exit_ip).toBe(true)
      expect(tunnelState()).toMatch(/^Connected/)

      const vpn = await run.page.evaluate(() =>
        (
          window as unknown as { hermesDesktop: { vpn: { getState: () => Promise<Record<string, unknown>> } } }
        ).hermesDesktop.vpn.getState()
      )

      expect(vpn).toMatchObject({ cliFound: true, gate: 'ready', tunnel: 'connected' })
      expect(vpn.relay).toMatch(/^[a-z]{2}-[a-z0-9]+-wg-\d+$/)
      expect((vpn.location as { country?: string } | null)?.country).toBeTruthy()

      // The statusbar chip is there.
      await expect(run.page.getByText('VPN', { exact: false }).first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await run.cleanup()
    }
  })

  test('leaves a tunnel that is already up alone', async () => {
    test.skip(!/^Connected/.test(initial), `the tunnel is "${initial}"; this scenario needs it connected`)

    const run = await launchReal()

    try {
      await waitForBackendReady(run.page)
      expect(tunnelState()).toMatch(/^Connected/)
    } finally {
      await run.cleanup()
    }
  })
})
