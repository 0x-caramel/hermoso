/**
 * E2E for the Mullvad VPN gate: the app holds its start until the tunnel is up.
 *
 * Launches the real Electron app (dev mode, built dist/) with a scripted
 * stand-in for the `mullvad` CLI (./fake-mullvad.mjs, wired through
 * HERMES_MULLVAD_CLI) and a mock inference backend, so the full chain is
 * exercised: gate → hermes serve → renderer. The VPN is opted back in here;
 * every other spec runs with HERMES_DESKTOP_VPN=off.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists. The backend runs
 * from the repo root unless HERMES_E2E_HERMES_ROOT points at a Hermes checkout or
 * runtime that has its Python environment installed (a fork without one can point it
 * at %LOCALAPPDATA%\Hermes\hermes-agent; the sandboxed HERMES_HOME keeps it isolated).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../tests-js/scripts/mock-server'
import { buildAppEnv, createSandbox, launchDesktop, type MockBackendFixture, waitForAppReady } from './fixtures'
import { allowErrorBanners, expect, test } from './test'
import type { Page } from '@playwright/test'

const FAKE_CLI = path.resolve(import.meta.dirname, 'fake-mullvad.mjs')

interface FakeState {
  account?: boolean
  connectDelayMs?: number
  failConnect?: boolean
  log?: string[]
  stuck?: boolean
  tunnel?: 'blocked' | 'connected' | 'connecting' | 'disconnected'
}

async function launchWithVpn(scenario: FakeState & { cli?: string; vpnSettings?: Record<string, unknown> }) {
  const mock = await startMockServer()
  const sandbox = createSandbox('vpn')
  const statePath = path.join(sandbox.root, 'fake-mullvad.json')

  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  fs.writeFileSync(statePath, JSON.stringify({ account: true, connectDelayMs: 1200, tunnel: 'disconnected', ...scenario }))

  if (scenario.vpnSettings) {
    fs.writeFileSync(path.join(sandbox.userDataDir, 'vpn.json'), JSON.stringify(scenario.vpnSettings))
  }

  const env = buildAppEnv(sandbox, {
    FAKE_MULLVAD_STATE: statePath,
    // A fresh sandbox HERMES_HOME is "not current" to a runtime that manages its own Python
    // environment: its backend would first install a whole toolchain (hundreds of MB, minutes)
    // before it listens. These specs test the gate, not the installer; the runtime's existing
    // environment is what they want.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_DESKTOP_HERMES_ROOT: process.env.HERMES_E2E_HERMES_ROOT ?? buildAppEnv(sandbox).HERMES_DESKTOP_HERMES_ROOT,
    HERMES_DESKTOP_VPN: 'on',
    HERMES_MULLVAD_CLI: scenario.cli ?? FAKE_CLI
  })

  const { app, page } = await launchDesktop(env)

  const fixture: MockBackendFixture = {
    app,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    },
    mock,
    mockUrl: mock.url,
    page,
    sandbox
  }

  return {
    fixture,
    readState: (): Required<Pick<FakeState, 'log'>> & FakeState => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    writeState: (patch: FakeState) =>
      fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, 'utf8')), ...patch }))
  }
}

// `waitForAppReady` only proves a composer exists behind whatever is on screen. What these
// specs need is main's own word that the backend came up: its boot phase reaches
// `backend.ready` only after the HTTP and WebSocket probes pass. Polled from the test side
// with `page.evaluate` — `page.waitForFunction` does not await an async predicate.
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

// Main owns the boot phase. While the gate holds the start, the backend has not even
// been resolved: the phase is still the idle one it was born with.
async function expectBackendNotStarted(page: Page) {
  const phase = await page.evaluate(async () => {
    const desktop = (window as unknown as { hermesDesktop: { getBootProgress: () => Promise<{ phase: string }> } })
      .hermesDesktop

    return (await desktop.getBootProgress()).phase
  })

  expect(phase).toBe('idle')
}

test.describe('Mullvad VPN gate', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90s budget is for warm specs.
    test.setTimeout(240_000)

    // The blocked surface is an alert by design; it is not a failure here.
    allowErrorBanners()
  })

  test('starts no backend while the tunnel is coming up, and starts it the moment it is up', async () => {
    const run = await launchWithVpn({ stuck: true, tunnel: 'disconnected' })

    try {
      const page = run.fixture.page

      // The daemon accepted `connect` but the tunnel never completes.
      await expect(page.getByText('Connecting to Mullvad')).toBeVisible({ timeout: 60_000 })
      await page.waitForTimeout(4_000)
      await expectBackendNotStarted(page)

      run.writeState({ stuck: false, tunnel: 'connected' })

      await waitForBackendReady(page)
      await expect(page.getByText('Connecting to Mullvad')).toHaveCount(0)
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('holds every outbound request of the app’s own network stack until the tunnel is up', async () => {
    const run = await launchWithVpn({ stuck: true, tunnel: 'disconnected' })

    try {
      const { app, page } = run.fixture

      // A request event fires when the renderer ASKS; it says nothing about the wire. What a
      // leak looks like is an external request that SETTLES (finishes or fails) while gated.
      const settledExternal: string[] = []
      const isExternal = (url: string) => /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)

      const noteSettled = (request: { url: () => string }) => {
        if (isExternal(request.url())) {
          settledExternal.push(request.url())
        }
      }

      page.on('requestfinished', noteSettled)
      page.on('requestfailed', noteSettled)

      await expect(page.getByText('Connecting to Mullvad')).toBeVisible({ timeout: 60_000 })

      // A host that can never resolve: what matters is WHEN the attempt is made, not whether it succeeds.
      const probe = 'https://hermes-egress-probe.invalid/'
      const settled = { main: false, renderer: false }

      const fromRenderer = page
        .evaluate(url => fetch(url).then(() => 'reached', () => 'failed'), probe)
        .finally(() => (settled.renderer = true))

      const fromMain = app
        .evaluate(({ net }, url) => net.fetch(url).then(() => 'reached', () => 'failed'), probe)
        .finally(() => (settled.main = true))

      // The renderer's own theme-font requests are held as well.
      await page.waitForTimeout(5_000)

      expect(settled).toEqual({ main: false, renderer: false })
      expect(settledExternal).toEqual([])

      run.writeState({ stuck: false, tunnel: 'connected' })

      // Released with the gate: both attempts now go out (and fail, the host is fake).
      await expect(Promise.all([fromRenderer, fromMain])).resolves.toEqual(['failed', 'failed'])
      expect(settledExternal).toContain(probe)
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('connects a disconnected tunnel before the app starts', async () => {
    const run = await launchWithVpn({ connectDelayMs: 1500, tunnel: 'disconnected' })

    try {
      await waitForBackendReady(run.fixture.page)
      await waitForAppReady(run.fixture, 120_000)

      const commands = run.readState().log.map(line => line.split(' ')[0])
      expect(commands).toContain('connect')
      expect(commands.filter(command => command === 'connect')).toHaveLength(1)

      // The statusbar chip names the country once the tunnel is up.
      await expect(run.fixture.page.getByText('Sweden').first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('does not touch a tunnel that is already up', async () => {
    const run = await launchWithVpn({ tunnel: 'connected' })

    try {
      await waitForBackendReady(run.fixture.page)
      await waitForAppReady(run.fixture, 120_000)

      expect(run.readState().log.map(line => line.split(' ')[0])).not.toContain('connect')
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('holds the start and explains when Mullvad is not signed in, then continues after a retry', async () => {
    const run = await launchWithVpn({ account: false, tunnel: 'disconnected' })

    try {
      const page = run.fixture.page

      await expect(page.getByText('Hermes is waiting for your VPN')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText('Mullvad is not signed in to an account.')).toBeVisible()

      // Nothing behind the gate started, and no connect was attempted.
      await expectBackendNotStarted(page)
      expect(run.readState().log.map(line => line.split(' ')[0])).not.toContain('connect')

      run.writeState({ account: true })
      await page.getByRole('button', { name: 'Try again' }).click()

      await waitForBackendReady(page)
      await waitForAppReady(run.fixture, 120_000)
      await expect(page.getByText('Hermes is waiting for your VPN')).toHaveCount(0)
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('holds the start when Mullvad is not installed, and can be waived for this launch only', async () => {
    const run = await launchWithVpn({ cli: path.join(path.dirname(FAKE_CLI), 'no-such-mullvad') })

    try {
      const page = run.fixture.page

      await expect(page.getByText('Mullvad VPN is not installed on this computer.')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('button', { name: 'Get Mullvad' })).toBeVisible()
      await expectBackendNotStarted(page)

      await page.getByRole('button', { name: 'Continue without VPN' }).click()

      await waitForBackendReady(page)
      await waitForAppReady(run.fixture, 120_000)

      // The waiver is this launch's, not a saved preference: nothing was written, so the next
      // launch gates again. (Turning the requirement off for good is a toggle in Settings → VPN.)
      expect(fs.existsSync(path.join(run.fixture.sandbox.userDataDir, 'vpn.json'))).toBe(false)

      const vpn = await page.evaluate(() =>
        (window as unknown as { hermesDesktop: { vpn: { getState: () => Promise<Record<string, unknown>> } } }).hermesDesktop.vpn.getState()
      )

      expect(vpn).toMatchObject({ settings: { block: true, enabled: true }, waived: true })
    } finally {
      await run.fixture.cleanup()
    }
  })

  test('does not wait for the tunnel when the requirement is off', async () => {
    const run = await launchWithVpn({
      cli: path.join(path.dirname(FAKE_CLI), 'no-such-mullvad'),
      vpnSettings: { block: false, enabled: true }
    })

    try {
      await waitForBackendReady(run.fixture.page)
      await waitForAppReady(run.fixture, 120_000)
      await expect(run.fixture.page.getByText('Hermes is waiting for your VPN')).toHaveCount(0)
    } finally {
      await run.fixture.cleanup()
    }
  })
})
