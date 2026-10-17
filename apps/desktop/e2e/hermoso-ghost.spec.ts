/**
 * E2E for Hermoso's Ghost through the REAL agent: the main window opens a ghost (a second Hermoso with a Hermes home
 * and app data of its own in a temporary folder), the ghost talks to the real Hermes backend, and then the ghost is
 * wiped, by the panic button and by an ordinary close.
 *
 * What it proves, end to end:
 *   - the ghost is a different app with a different home: the question asked in it, and its answer, are in ITS folder
 *     and nowhere in the main window's Hermes home, and the main window's chat list does not show it;
 *   - the ghost knows it is one (banner, panic button) and the main window cannot open a ghost from inside a ghost;
 *   - the panic button closes the ghost at once and its whole folder is deleted;
 *   - closing a ghost the ordinary way deletes its folder too;
 *   - the main window is untouched and still works.
 *
 * The ghost's window is driven through a debugging port that only a test asks for (HERMOSO_GHOST_DEBUG_PORT).
 *
 * Prerequisite: see ./hermoso-launch.ts.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { type Browser, chromium, type Page } from '@playwright/test'

import { launchHermoso, say, waitForBackendReady } from './hermoso-launch'
import { SHIELD_PLAIN, SHIELD_PLAIN_DONE } from './hermoso-mock-model'
import { expect, test } from './test'

const PORT = 9400 + Math.floor(Math.random() * 400)
const SECRET = 'ghost-secret-marker-7f3a'

const ghostFolders = () =>
  fs
    .readdirSync(os.tmpdir())
    .filter(name => /^hermoso-ghost-[0-9a-f]{12}$/.test(name))
    .map(name => path.join(os.tmpdir(), name))

/** Every file under a folder that holds this text (a chat in a database is in its bytes). */
function filesHolding(dir: string, text: string): string[] {
  const found: string[] = []
  const needle = Buffer.from(text)

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)

      try {
        if (entry.isDirectory()) {
          walk(full)
        } else if (
          entry.isFile() &&
          fs.statSync(full).size < 64 * 1024 * 1024 &&
          fs.readFileSync(full).includes(needle)
        ) {
          found.push(full)
        }
      } catch {
        // a file that is locked or gone while it is read is not a hit
      }
    }
  }

  walk(dir)

  return found
}

const killGhosts = () =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--hermoso-ghost' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ],
    { windowsHide: true }
  )

async function connectToGhost(): Promise<{ browser: Browser; page: Page }> {
  let last: unknown = null
  let seen = ''

  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)

      // The app's own window is the one that has the desktop bridge; the process may show others first.
      const pages = browser.contexts().flatMap(context => context.pages())

      seen = pages.map(page => page.url()).join(' | ') || '(no pages)'

      for (const page of pages) {
        const isApp = await page
          .evaluate(() => Boolean((window as unknown as { hermesDesktop?: unknown }).hermesDesktop))
          .catch(() => false)

        if (isApp) {
          return { browser, page }
        }
      }

      await browser.close().catch(() => undefined)
    } catch (error) {
      last = error
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  throw new Error(`the ghost window never answered on port ${PORT}: ${String(last)}; pages: ${seen}`)
}

test.describe('Hermoso Ghost through the real agent', () => {
  test.beforeEach(() => {
    // Two real backends, one after the other.
    test.setTimeout(600_000)
  })

  test('a ghost keeps nothing: its chat lives in its own folder, and the folder goes on panic and on close', async () => {
    const before = new Set(ghostFolders())
    const run = await launchHermoso({ HERMOSO_GHOST_DEBUG_PORT: String(PORT) })
    let ghost: Browser | null = null

    try {
      const { page, sandbox } = run

      await waitForBackendReady(page)

      // ── the main window opens a ghost, from the page ──
      await page.getByRole('button', { name: 'Hermoso' }).first().click()
      await expect(page.getByTestId('ghost-banner')).toHaveCount(0)
      await page.getByRole('button', { name: 'Open a ghost window' }).click()
      await expect(page.getByTestId('ghost-opened')).toBeVisible({ timeout: 30_000 })

      const connected = await connectToGhost()

      ghost = connected.browser

      const ghostPage = connected.page
      const folders = ghostFolders().filter(folder => !before.has(folder))

      expect(folders, 'one ghost folder was made').toHaveLength(1)

      const folder = folders[0]

      // the setup was copied in, the history was not
      expect(fs.existsSync(path.join(folder, 'hermes-home', 'config.yaml'))).toBe(true)
      expect(fs.existsSync(path.join(folder, 'hermes-home', '.env'))).toBe(true)

      await waitForBackendReady(ghostPage)

      // ── the ghost knows it is one, and cannot open another ──
      await ghostPage.getByRole('button', { name: 'Hermoso' }).first().click()
      await expect(ghostPage.getByTestId('ghost-banner')).toHaveText('This is a ghost window: nothing is kept.')
      await expect(ghostPage.getByRole('button', { name: 'Open a ghost window' })).toHaveCount(0)
      await expect(ghostPage.getByTestId('panic')).toBeVisible()
      await ghostPage
        .getByRole('button', { name: /^New session/ })
        .first()
        .click()

      // ── a question asked in the ghost stays in the ghost ──
      await say(ghostPage, `${SHIELD_PLAIN} ${SECRET}`)
      await expect(ghostPage.getByText(SHIELD_PLAIN_DONE)).toBeVisible({ timeout: 180_000 })
      await expect
        .poll(() => filesHolding(path.join(folder, 'hermes-home'), SECRET).length, {
          message: 'the chat never reached the ghost’s own home',
          timeout: 60_000
        })
        .toBeGreaterThan(0)
      expect(filesHolding(sandbox.hermesHome, SECRET), 'the ghost’s chat leaked into the main window’s home').toEqual(
        []
      )
      expect(filesHolding(sandbox.userDataDir, SECRET), 'the ghost’s chat leaked into the main window’s data').toEqual(
        []
      )
      await expect(page.getByText(SECRET)).toHaveCount(0)

      // ── panic: the ghost is gone at once and so is everything it kept ──
      const gone = new Promise<void>(resolve => ghost!.on('disconnected', () => resolve()))

      await ghostPage.getByRole('button', { name: 'Ghost window: nothing is kept' }).click()
      await ghostPage.getByTestId('panic').click()
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 30_000))])
      await expect
        .poll(() => fs.existsSync(folder), { message: 'the ghost folder was not deleted', timeout: 90_000 })
        .toBe(false)

      // ── the main window is untouched ──
      await expect(page.getByTestId('ghost-banner')).toHaveCount(0)
      expect(fs.existsSync(path.join(sandbox.hermesHome, 'config.yaml'))).toBe(true)

      // ── a second ghost, closed the ordinary way ──
      await page.getByRole('button', { name: 'Open a ghost window' }).click()

      const second = await connectToGhost()

      ghost = second.browser

      const secondFolder = ghostFolders().filter(candidate => !before.has(candidate) && candidate !== folder)[0]

      expect(secondFolder).toBeTruthy()
      await waitForBackendReady(second.page)
      await second.page.close()
      await expect
        .poll(() => fs.existsSync(secondFolder), { message: 'the folder survived an ordinary close', timeout: 120_000 })
        .toBe(false)
    } finally {
      await ghost?.close().catch(() => undefined)
      killGhosts()
      await run.cleanup()

      for (const folder of ghostFolders().filter(candidate => !before.has(candidate))) {
        fs.rmSync(folder, { force: true, recursive: true })
      }
    }
  })
})
