/**
 * E2E for Hermoso's Teleport through the REAL agent: a scripted model decides to teleport, the real Hermes backend
 * runs Hermoso's plugin, the plugin reaches the app through the bridge file, the app asks the person in its own
 * window, and a scripted `mullvad` CLI (./fake-mullvad.mjs) shows what actually moved.
 *
 * What it proves, end to end:
 *   - the plugin is installed into the (sandbox) Hermes home, loaded by the real backend, and its tools are offered
 *     to the model because a Hermoso is running (the mock says so loudly when they are not);
 *   - nothing moves until the person says yes, in Hermoso's dialog;
 *   - "Allow once" moves the connection, the agent's own `hermoso_return_home` brings it back with no question;
 *   - "Deny" is final: the agent is told, and the Mullvad CLI was never asked to move.
 *
 * Prerequisite: `npm run build` (dist/ exists). The backend runs from HERMES_E2E_HERMES_ROOT (a Hermes checkout or
 * runtime with its Python environment installed; a fork without one points it at %LOCALAPPDATA%\Hermes\hermes-agent).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Page } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { NO_DONE, startHermosoMock, TELEPORT_NO, TELEPORT_YES, TOOLS_MISSING, YES_DONE } from './hermoso-mock-model'
import { expect, test } from './test'

const FAKE_CLI = path.resolve(import.meta.dirname, 'fake-mullvad.mjs')

interface FakeState {
  log: string[]
  relay: string
  tunnel: string
}

async function launch() {
  const mock = await startHermosoMock()
  const sandbox = createSandbox('hermoso')
  const statePath = path.join(sandbox.root, 'fake-mullvad.json')

  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  fs.writeFileSync(
    statePath,
    JSON.stringify({ account: true, connectDelayMs: 800, relay: 'country se', tunnel: 'disconnected' })
  )

  const env = buildAppEnv(sandbox, {
    FAKE_MULLVAD_STATE: statePath,
    // A fresh sandbox HERMES_HOME would first install a whole toolchain before the backend listens.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_DESKTOP_HERMES_ROOT: process.env.HERMES_E2E_HERMES_ROOT ?? buildAppEnv(sandbox).HERMES_DESKTOP_HERMES_ROOT,
    HERMES_DESKTOP_VPN: 'on',
    HERMES_MULLVAD_CLI: FAKE_CLI
  })

  const { app, page } = await launchDesktop(env)

  return {
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()

      // HERMOSO_E2E_KEEP=1 keeps the sandbox (logs, config, plugin folder) to look at after a failure.
      if (process.env.HERMOSO_E2E_KEEP) {
        console.log(`[hermoso-e2e] sandbox kept at ${sandbox.root}`)

        return
      }

      sandbox.cleanup()
    },
    mock,
    page,
    readState: (): FakeState => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    sandbox
  }
}

// Main's own word that the backend came up (its boot phase reaches `backend.ready` only after the HTTP and
// WebSocket probes pass). Polled with page.evaluate: page.waitForFunction does not await an async predicate.
async function waitForBackendReady(page: Page, timeoutMs = 180_000) {
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

async function say(page: Page, text: string) {
  const composer = page.locator('[contenteditable="true"]').first()

  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  await composer.click()
  await composer.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Hermoso Teleport through the real agent', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90 s budget is for warm specs.
    test.setTimeout(420_000)
  })

  test('the person decides: a yes moves the connection and the agent brings it home, a no moves nothing', async () => {
    const run = await launch()

    try {
      const { mock, page, readState, sandbox } = run

      await waitForBackendReady(page)

      // The plugin is in the (sandbox) Hermes home, listed as enabled, and the app has told it where it is.
      const pluginDir = path.join(sandbox.hermesHome, 'plugins', 'hermoso')

      expect(fs.existsSync(path.join(pluginDir, '__init__.py'))).toBe(true)
      expect(fs.readFileSync(path.join(sandbox.hermesHome, 'config.yaml'), 'utf8')).toMatch(/enabled:[\s\S]*hermoso/)
      expect(fs.existsSync(path.join(pluginDir, '.bridge.json'))).toBe(true)

      // The gate brought the tunnel up at the "home" location of the scripted CLI.
      expect(readState().tunnel).toBe('connected')
      expect(readState().relay).toBe('country se')

      // ── a yes ──
      await say(page, `${TELEPORT_YES} please check the price from there`)

      const dialog = page.getByRole('dialog').filter({ hasText: /Teleport to/ })

      // A backend that never offers the tool would otherwise cost the whole wait: name what it did offer.
      await expect
        .poll(() => mock.offered.length > 0, { message: 'the model was never asked anything', timeout: 120_000 })
        .toBe(true)
      expect(
        mock.reachable.some(Boolean),
        `hermoso_teleport was neither offered nor listed; the model was offered: ${JSON.stringify(mock.offered)}`
      ).toBe(true)

      await expect(dialog).toContainText('Teleport to Germany?', { timeout: 180_000 })
      await expect(dialog).toContainText('compare prices')

      // Nothing moves while the person has not answered.
      await page.waitForTimeout(1_500)
      expect(readState().relay).toBe('country se')
      expect(readState().log.some(line => line.startsWith('relay set location'))).toBe(false)

      await dialog.getByRole('button', { name: 'Allow once' }).click()

      // The jump happened (the scripted CLI was asked for Germany) and the agent's own return home undid it.
      await expect
        .poll(() => readState().log.some(line => line === 'relay set location de'), {
          message: 'the CLI was never asked to move to Germany',
          timeout: 120_000
        })
        .toBe(true)

      await expect(page.getByText(YES_DONE)).toBeVisible({ timeout: 180_000 })
      expect(readState().relay).toBe('country se')
      expect(fs.existsSync(path.join(sandbox.userDataDir, 'hermoso', 'teleport.json'))).toBe(false)
      expect(mock.toolResults.join('\n')).not.toContain(TOOLS_MISSING)
      expect(mock.toolResults.some(result => result.includes('"ok": true'))).toBe(true)

      // ── a no ──
      const movesBefore = readState().log.filter(line => line.startsWith('relay set location')).length

      await say(page, `${TELEPORT_NO} please check the price from there`)
      await expect(dialog).toContainText('Teleport to France?', { timeout: 180_000 })
      await dialog.getByRole('button', { name: 'Deny' }).click()

      await expect(page.getByText(NO_DONE)).toBeVisible({ timeout: 180_000 })
      expect(readState().log.filter(line => line.startsWith('relay set location')).length).toBe(movesBefore)
      expect(readState().relay).toBe('country se')
      expect(mock.toolResults.some(result => result.includes('"error": "denied"'))).toBe(true)
    } finally {
      await run.cleanup()
    }
  })
})
