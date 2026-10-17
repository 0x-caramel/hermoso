/**
 * E2E for Hermoso's Shield through the REAL agent: the scripted Mullvad drops the tunnel under a running agent, and
 * the real Hermes backend, running Hermoso's plugin, must stand still until it is back.
 *
 * What it proves, end to end:
 *   - while the tunnel is up the agent works as usual (a question is answered, a file is written);
 *   - when it drops, the app says so (the status-bar chip) and a new question does NOT reach the model: the model's
 *     server sees no request at all for as long as the tunnel is down, and the answer arrives once it is back;
 *   - a tool the model decides to run just as the tunnel drops is refused, with the reason, and is NOT run (the
 *     file it would have written does not exist), and the request that carries the refusal is itself held;
 *   - the radar looks at the app's connections without an error and the proof report says what it saw and what it
 *     does not prove;
 *   - "Always require VPN" is switched from the Shield section and Mullvad (the scripted one) is really asked.
 *
 * Prerequisite: see ./hermoso-launch.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { askHermoso, launchHermoso, say, waitForBackendReady } from './hermoso-launch'
import {
  FROZEN_WORDS,
  SHIELD_PLAIN,
  SHIELD_PLAIN_DONE,
  SHIELD_REFUSED_DONE,
  SHIELD_WRITE,
  SHIELD_WRITE_DONE,
  SHIELD_WRITE_SLOW
} from './hermoso-mock-model'
import { expect, test } from './test'

const FROZEN_CHIP = 'The agent is frozen: the VPN tunnel is down'
const CALM_CHIP = 'Shield: the VPN tunnel is up and the agent is free to work'

test.describe('Hermoso Shield through the real agent', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90 s budget is for warm specs.
    test.setTimeout(600_000)
  })

  test('the agent stands still while the tunnel is down, and goes on when it is back', async () => {
    // The scripted model sits on 127.0.0.1, which the shield rightly does not hold: ask it to, for the test.
    const run = await launchHermoso({ HERMOSO_SHIELD_HOLD_LOCAL: '1' })

    try {
      const { mock, page, readState, sandbox, setTunnel } = run

      const verdict = () => askHermoso<{ frozen: boolean; required: boolean; tunnel: string }>(page, 'shield.state')

      await waitForBackendReady(page)

      // The gate brought the tunnel up and the person's settings require it: the shield is on duty and calm.
      expect(readState().tunnel).toBe('connected')
      expect(await verdict()).toMatchObject({ frozen: false, required: true, tunnel: 'connected' })
      await expect(page.getByRole('button', { name: CALM_CHIP })).toBeVisible({ timeout: 60_000 })

      // ── the tunnel is up: the agent works ──
      await say(page, `${SHIELD_PLAIN} first question`)
      await expect(page.getByText(SHIELD_PLAIN_DONE)).toHaveCount(1, { timeout: 120_000 })

      const okPath = path.join(sandbox.root, 'written-while-up.txt')

      await say(page, `${SHIELD_WRITE} ${okPath}`)
      await expect(page.getByText(SHIELD_WRITE_DONE)).toBeVisible({ timeout: 120_000 })
      expect(fs.readFileSync(okPath, 'utf8')).toBe('ran')

      // ── the tunnel drops: a new question is held, not sent ──
      setTunnel('disconnected')
      await expect
        .poll(async () => (await verdict()).frozen, { message: 'the shield never froze', timeout: 40_000 })
        .toBe(true)
      await expect(page.getByRole('button', { name: FROZEN_CHIP })).toContainText('Frozen')

      const requestsBefore = mock.arrivals.length

      await say(page, `${SHIELD_PLAIN} second question`)
      await page.waitForTimeout(8_000)
      expect(
        mock.arrivals.length,
        `a request reached the model while the tunnel was down: ${JSON.stringify(mock.requests.slice(requestsBefore))}`
      ).toBe(requestsBefore)
      await expect(page.getByText(SHIELD_PLAIN_DONE)).toHaveCount(1)

      // ── the tunnel is back: the held question goes through, once ──
      setTunnel('connected')
      await expect(page.getByText(SHIELD_PLAIN_DONE)).toHaveCount(2, { timeout: 60_000 })
      expect(mock.arrivals.length).toBe(requestsBefore + 1)
      await expect(page.getByRole('button', { name: CALM_CHIP })).toBeVisible()
      expect((await verdict()).frozen).toBe(false)

      // ── a tool decided on just as the tunnel drops is refused, and is not run ──
      const refusedPath = path.join(sandbox.root, 'must-not-exist.txt')
      const before = mock.arrivals.length

      await say(page, `${SHIELD_WRITE_SLOW} ${refusedPath}`)
      await expect.poll(() => mock.arrivals.length, { timeout: 60_000 }).toBe(before + 1)
      setTunnel('disconnected')

      // The model "thinks" for a few seconds, then asks for the write; the plugin waits for the tunnel (at most
      // twenty seconds) and then refuses. The request that carries the refusal is held like any other.
      await expect.poll(async () => (await verdict()).frozen, { timeout: 40_000 }).toBe(true)
      await page.waitForTimeout(32_000)
      expect(fs.existsSync(refusedPath), 'the file was written although the tunnel was down').toBe(false)
      expect(mock.arrivals.length, 'the refusal reached the model while the tunnel was down').toBe(before + 1)

      setTunnel('connected')
      await expect(page.getByText(SHIELD_REFUSED_DONE)).toBeVisible({ timeout: 90_000 })
      expect(mock.toolResults.some(result => result.includes(FROZEN_WORDS))).toBe(true)
      expect(fs.existsSync(refusedPath)).toBe(false)

      // ── the radar and the proof report ──
      const radar = await askHermoso<any>(page, 'shield.radar')

      expect(radar.sample.error).toBeNull()
      expect(Array.isArray(radar.sample.connections)).toBe(true)
      expect(radar.summary.samples).toBeGreaterThan(0)
      expect(radar.summary.frozenSeconds, 'the freeze was not counted').toBeGreaterThanOrEqual(10)

      const report = await askHermoso<string>(page, 'shield.report')

      expect(report).toContain('# Hermoso shield report')
      expect(report).toContain('Time the agent stood frozen because the tunnel was down')
      expect(report).toContain('not "no packet ever left"')
      expect(report).toContain('Tunnel exit: Sweden')

      // ── "Always require VPN", from the Shield section of the page ──
      await page.getByRole('button', { name: 'Hermoso' }).first().click()
      await expect(page.getByTestId('shield-headline')).toHaveText('Protected')

      const always = page.getByRole('switch', { name: 'Always require VPN' })

      await expect(always).toHaveAttribute('aria-checked', 'false')
      await always.click()
      await expect(always).toHaveAttribute('aria-checked', 'true')
      expect(readState().lockdown).toBe(true)
      expect(readState().log).toContain('lockdown-mode set on')
      await always.click()
      await expect(always).toHaveAttribute('aria-checked', 'false')
      expect(readState().lockdown).toBe(false)
    } finally {
      await run.cleanup()
    }
  })
})
