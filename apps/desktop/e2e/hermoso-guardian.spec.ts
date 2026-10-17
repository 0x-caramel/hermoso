/**
 * E2E for Hermoso's Guardian through the REAL agent: a scripted model asks the real Hermes backend to write files
 * where it matters, and Hermoso's plugin must put the person in between.
 *
 * What it proves, end to end:
 *   - a risky write (a git hook: it runs by itself) opens Hermoso's own dialog with the exact path; a "no" leaves the
 *     file unwritten and the model is told so; "Allow once" writes it;
 *   - "Always allow" is remembered for that KIND of thing: the next such write asks nobody, another kind still asks;
 *   - what is never allowed (Hermoso's own answers file) is refused with no dialog at all, and the file is untouched;
 *   - the Hermoso page lists what was decided;
 *   - switched off from the page, nothing else is asked, but what is never allowed is still refused.
 *
 * Prerequisite: see ./hermoso-launch.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { launchHermoso, say, waitForBackendReady } from './hermoso-launch'
import { GUARD_BLOCKED_DONE, GUARD_DENIED_DONE, GUARD_WRITE, GUARD_WRITTEN_DONE } from './hermoso-mock-model'
import { expect, test } from './test'

test.describe('Hermoso Guardian through the real agent', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90 s budget is for warm specs.
    test.setTimeout(420_000)
  })

  test('a person decides what the agent may write where it matters, and what is never allowed is never written', async () => {
    const run = await launchHermoso()

    try {
      const { page, sandbox } = run
      const hooks = path.join(sandbox.root, 'project', '.git', 'hooks')
      const dialog = page.getByRole('dialog').filter({ hasText: /Writing files that run by themselves/ })

      await waitForBackendReady(page)

      // ── a no: the file is not written, and the model is told ──
      const denied = path.join(hooks, 'pre-commit')

      await say(page, `${GUARD_WRITE} ${denied}`)
      await expect(dialog).toContainText('Writing files that run by themselves?', { timeout: 180_000 })
      await expect(dialog).toContainText('The agent wants to write this file.')
      await expect(page.getByTestId('consent-code')).toContainText(path.join('.git', 'hooks', 'pre-commit'))
      expect(fs.existsSync(denied), 'written before the person answered').toBe(false)

      await dialog.getByRole('button', { name: 'Deny' }).click()
      await expect(page.getByText(GUARD_DENIED_DONE)).toBeVisible({ timeout: 120_000 })
      expect(fs.existsSync(denied)).toBe(false)

      // ── allow once: it is written ──
      const once = path.join(hooks, 'pre-push')

      await say(page, `${GUARD_WRITE} ${once}`)
      await expect(dialog).toContainText('Writing files that run by themselves?', { timeout: 120_000 })
      await dialog.getByRole('button', { name: 'Allow once' }).click()
      await expect
        .poll(() => fs.existsSync(once), { message: 'the file was never written', timeout: 120_000 })
        .toBe(true)
      expect(fs.readFileSync(once, 'utf8')).toBe('guarded')

      // ── always allow this kind: the next one of the same kind asks nobody ──
      const always = path.join(hooks, 'post-commit')

      await say(page, `${GUARD_WRITE} ${always}`)
      await expect(dialog).toContainText('Writing files that run by themselves?', { timeout: 120_000 })
      await dialog.getByRole('button', { name: 'Always allow writing files that run by themselves' }).click()
      await expect.poll(() => fs.existsSync(always), { timeout: 120_000 }).toBe(true)

      const same = path.join(hooks, 'post-merge')

      await say(page, `${GUARD_WRITE} ${same}`)
      await expect
        .poll(() => fs.existsSync(same), { message: 'a remembered kind still asked', timeout: 120_000 })
        .toBe(true)
      await expect(dialog).toHaveCount(0)

      // another kind is still asked
      const ssh = path.join(sandbox.root, 'project', '.ssh', 'config')
      const sshDialog = page.getByRole('dialog').filter({ hasText: /Writing into the SSH folder/ })

      await say(page, `${GUARD_WRITE} ${ssh}`)
      await expect(sshDialog).toContainText('Writing into the SSH folder?', { timeout: 120_000 })
      await sshDialog.getByRole('button', { name: 'Deny' }).click()
      await expect(page.getByText(GUARD_DENIED_DONE)).toHaveCount(2, { timeout: 120_000 })
      expect(fs.existsSync(ssh)).toBe(false)

      // ── what is never allowed: no dialog, no file ──
      const tamper = path.join(sandbox.userDataDir, 'hermoso', 'forged.json')

      await say(page, `${GUARD_WRITE} ${tamper}`)
      await expect(page.getByText(GUARD_BLOCKED_DONE)).toBeVisible({ timeout: 120_000 })
      expect(fs.existsSync(tamper), 'the agent wrote into Hermoso’s own folder').toBe(false)
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // ── the page lists what was decided ──
      await page.getByRole('button', { name: 'Hermoso' }).first().click()

      const journal = page.getByTestId('guardian-journal')

      await expect(journal).toContainText('Refused')
      await expect(journal).toContainText('Always allowed')
      await expect(journal).toContainText('Allowed once')
      await expect(journal).toContainText('Denied')
      await expect(page.getByTestId('guardian-totals')).toContainText('refused outright')

      // ── switched off: nothing is asked, but what is never allowed is still refused ──
      const review = page.getByRole('switch', { name: 'Review risky commands' })

      await expect(review).toHaveAttribute('aria-checked', 'true')
      await review.click()
      await expect(review).toHaveAttribute('aria-checked', 'false')
      await expect(page.getByTestId('guardian-off-note')).toBeVisible()

      await page
        .getByRole('button', { name: /^New session/ })
        .first()
        .click()

      const unasked = path.join(sandbox.root, 'project', '.ssh', 'authorized_keys')

      await say(page, `${GUARD_WRITE} ${unasked}`)
      await expect
        .poll(() => fs.existsSync(unasked), { message: 'switched off, it still asked', timeout: 120_000 })
        .toBe(true)
      await expect(page.getByRole('dialog')).toHaveCount(0)

      const tamperAgain = path.join(sandbox.userDataDir, 'hermoso', 'forged-again.json')

      await say(page, `${GUARD_WRITE} ${tamperAgain}`)
      await expect(page.getByText(GUARD_BLOCKED_DONE)).toBeVisible({ timeout: 120_000 })
      expect(fs.existsSync(tamperAgain)).toBe(false)
      expect(fs.readFileSync(unasked, 'utf8')).toBe('guarded')
      await expect(page.getByText(GUARD_WRITTEN_DONE).first()).toBeVisible()
    } finally {
      await run.cleanup()
    }
  })
})
