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
 * Prerequisite: see ./hermoso-launch.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { launchHermoso, say, waitForBackendReady } from './hermoso-launch'
import { NO_DONE, TELEPORT_NO, TELEPORT_YES, TOOLS_MISSING, YES_DONE } from './hermoso-mock-model'
import { expect, test } from './test'

test.describe('Hermoso Teleport through the real agent', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90 s budget is for warm specs.
    test.setTimeout(420_000)
  })

  test('the person decides: a yes moves the connection and the agent brings it home, a no moves nothing', async () => {
    const run = await launchHermoso()

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

      // The trip is on the aura: the chip appears in the status bar once there is something to count.
      await expect(page.getByRole('button', { name: 'Aura: Quiet · 10' })).toBeVisible()

      // ── a no ──
      const movesBefore = readState().log.filter(line => line.startsWith('relay set location')).length

      await say(page, `${TELEPORT_NO} please check the price from there`)
      await expect(dialog).toContainText('Teleport to France?', { timeout: 180_000 })
      await dialog.getByRole('button', { name: 'Deny' }).click()

      await expect(page.getByText(NO_DONE)).toBeVisible({ timeout: 180_000 })
      expect(readState().log.filter(line => line.startsWith('relay set location')).length).toBe(movesBefore)
      expect(readState().relay).toBe('country se')
      expect(mock.toolResults.some(result => result.includes('"error": "denied"'))).toBe(true)

      // A trip that was refused is not a trip: the aura is still worth the one that happened.
      await expect(page.getByRole('button', { name: 'Aura: Quiet · 10' })).toBeVisible()
    } finally {
      await run.cleanup()
    }
  })
})
