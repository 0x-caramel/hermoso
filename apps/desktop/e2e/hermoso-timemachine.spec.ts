/**
 * E2E for Hermoso's Time Machine through the REAL agent: the real Hermes backend (started with the one variable that
 * asks it to snapshot) writes files in a project folder at the model's request, and the Hermoso page rewinds them.
 *
 * What it proves, end to end:
 *   - Hermes takes a snapshot just before the agent first changes a file in each turn (two turns, two snapshots), and
 *     the Hermoso page lists them for the open chat;
 *   - "See changes" asks Hermes what changed since a snapshot;
 *   - "Rewind to here" asks first, and then really puts the project folder back: what the agent wrote after that
 *     point is gone, what was there before is untouched.
 *
 * Prerequisite: see ./hermoso-launch.ts.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { launchHermoso, say, waitForBackendReady } from './hermoso-launch'
import { TM_DONE, TM_WRITE } from './hermoso-mock-model'
import { expect, test } from './test'

test.describe('Hermoso Time Machine through the real agent', () => {
  test.beforeEach(() => {
    // Each launch boots a real backend; the default 90 s budget is for warm specs.
    test.setTimeout(420_000)
  })

  test('snapshots before the agent changes files, and a rewind puts the project folder back', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-tm-project-'))

    fs.writeFileSync(path.join(project, 'seed.txt'), 'seed')

    const run = await launchHermoso({ HERMES_DESKTOP_CWD: project })

    try {
      const { page } = run

      await waitForBackendReady(page)

      // ── two turns, each changing a file ──
      await say(page, `${TM_WRITE} a.txt`)
      await expect(page.getByText(TM_DONE)).toHaveCount(1, { timeout: 180_000 })
      expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('agent')

      await say(page, `${TM_WRITE} b.txt`)
      await expect(page.getByText(TM_DONE)).toHaveCount(2, { timeout: 120_000 })
      expect(fs.existsSync(path.join(project, 'b.txt'))).toBe(true)

      // ── the Hermoso page lists the snapshots of this chat ──
      await page.getByRole('button', { name: 'Hermoso' }).first().click()

      const list = page.getByTestId('timemachine-list')

      await expect(list.getByRole('listitem')).toHaveCount(2, { timeout: 60_000 })

      // ── what changed since the oldest snapshot ──
      const oldest = list.getByRole('listitem').nth(1)

      await oldest.getByRole('button', { name: 'See changes' }).click()
      await expect(oldest.getByTestId('timemachine-diff')).toContainText('a.txt', { timeout: 30_000 })

      // ── rewind to it: asked first, then really done ──
      await oldest.getByRole('button', { name: 'Rewind to here' }).click()
      await expect(oldest.getByTestId('timemachine-confirm')).toContainText(
        'Everything the agent changed after that is undone'
      )
      expect(fs.existsSync(path.join(project, 'a.txt')), 'rewound before the person confirmed').toBe(true)

      await oldest.getByRole('button', { name: 'Rewind', exact: true }).click()
      await expect(page.getByTestId('timemachine-note')).toContainText('Rewound', { timeout: 60_000 })

      expect(fs.existsSync(path.join(project, 'a.txt')), 'a.txt is still there after the rewind').toBe(false)
      expect(fs.existsSync(path.join(project, 'b.txt')), 'b.txt is still there after the rewind').toBe(false)
      expect(fs.readFileSync(path.join(project, 'seed.txt'), 'utf8')).toBe('seed')
    } finally {
      await run.cleanup()
      fs.rmSync(project, { force: true, recursive: true })
    }
  })
})
