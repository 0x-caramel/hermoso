/**
 * Not a test of behaviour: it takes the pictures the README shows, in the same environment as the other Hermoso specs
 * (the real app, a real Hermes backend, a scripted model and a scripted `mullvad`), so every state can be reproduced.
 * They are real states of the real window, reached the way a person reaches them. It only runs on request:
 *
 *   HERMOSO_SCREENSHOTS=1 HERMES_E2E_HERMES_ROOT=<runtime> npx playwright test e2e/hermoso-screenshots.spec.ts
 *
 * The pictures go to docs/hermoso/screenshots/. Two things are kept out of them on purpose: the project is a folder
 * with a neutral name (no user name in a path), and the Shield's connection list is cropped away (with a scripted
 * Mullvad there is no tunnel interface, so the radar would call every connection "outside"; the real radar was
 * checked against the real Mullvad).
 *
 * Prerequisite: see ./hermoso-launch.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { Browser, Locator, Page } from '@playwright/test'

import {
  askHermoso,
  connectToGhost,
  ghostFolders,
  killGhosts,
  launchHermoso,
  say,
  waitForBackendReady
} from './hermoso-launch'
import {
  GUARD_BLOCKED_DONE,
  GUARD_DENIED_DONE,
  GUARD_WRITE,
  GUARD_WRITTEN_DONE,
  TELEPORT_TRIP,
  TM_DONE,
  TM_WRITE,
  YES_DONE
} from './hermoso-mock-model'
import { expect, test } from './test'

const OUT = path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'hermoso', 'screenshots')
const PORT = 9400 + Math.floor(Math.random() * 400)

// A project with a neutral name, outside the temporary folder (whose path carries the user's name).
const DEMO_ROOT = 'C:\\Projects\\sample-projects'
const PROJECT = path.join(DEMO_ROOT, 'my-app')

test.skip(!process.env.HERMOSO_SCREENSHOTS, 'takes the README pictures; run it on request (see the file header)')

const section = (page: Page, has: Locator) => page.locator('section').filter({ has })

/**
 * The Shield's connection list is folded away for the pictures (see the header: with a scripted Mullvad the radar
 * would call every connection "outside"). Its title row sits inside the block that holds the whole radar.
 */
const hideRadar = (page: Page) =>
  page
    .getByText('What this app is connected to')
    .locator('xpath=../..')
    .evaluate(element => {
      element.style.display = 'none'
    })

/**
 * A picture of one element of a window that is only reached over the debugging port (the ghost's): the element's own
 * picture comes out shifted there, so the whole window is taken and the element is cut out of it, on a canvas of the
 * main window (nothing else is needed to crop a picture).
 */
async function pictureOfElement(carrier: Page, other: Page, element: Locator, file: string) {
  const box = await element.boundingBox()

  if (!box) {
    throw new Error(`could not measure the picture for ${file}`)
  }

  const ratio = await other.evaluate(() => window.devicePixelRatio)
  const whole = (await other.screenshot()).toString('base64')

  const cut = await carrier.evaluate(
    async ([data, x, y, width, height]) => {
      const bytes = Uint8Array.from(atob(data as string), char => char.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = document.createElement('canvas')

      canvas.width = width as number
      canvas.height = height as number
      canvas
        .getContext('2d')!
        .drawImage(
          bitmap,
          x as number,
          y as number,
          width as number,
          height as number,
          0,
          0,
          canvas.width,
          canvas.height
        )

      return canvas.toDataURL('image/png').split(',')[1]
    },
    [
      whole,
      Math.round(box.x * ratio),
      Math.round(box.y * ratio),
      Math.round(box.width * ratio),
      Math.round(box.height * ratio)
    ] as const
  )

  fs.writeFileSync(file, Buffer.from(cut, 'base64'))
}

test.describe('The README pictures', () => {
  test('a tour of the real window, one picture per protection', async () => {
    test.setTimeout(1_500_000)

    expect(fs.existsSync(DEMO_ROOT), `${DEMO_ROOT} already exists: it is not mine to use`).toBe(false)
    fs.mkdirSync(PROJECT, { recursive: true })
    fs.writeFileSync(path.join(PROJECT, 'README.md'), '# my-app\n')
    fs.mkdirSync(OUT, { recursive: true })

    const before = new Set(ghostFolders())

    const run = await launchHermoso({
      HERMES_DESKTOP_CWD: PROJECT,
      HERMOSO_GHOST_DEBUG_PORT: String(PORT),
      HERMOSO_SHIELD_HOLD_LOCAL: '1'
    })

    let ghost: Browser | null = null

    try {
      const { page, sandbox, setTunnel } = run
      const shot = (name: string) => path.join(OUT, `${name}.png`)
      const openHermoso = () => page.getByRole('button', { name: 'Hermoso' }).first().click()

      const newSession = () =>
        page
          .getByRole('button', { name: /^New session/ })
          .first()
          .click()

      await waitForBackendReady(page)

      // ── Time Machine: two turns that change files, then the question before a rewind ──
      await say(page, `${TM_WRITE} report.txt`)
      await expect(page.getByText(TM_DONE)).toHaveCount(1, { timeout: 180_000 })
      await say(page, `${TM_WRITE} summary.txt`)
      await expect(page.getByText(TM_DONE)).toHaveCount(2, { timeout: 120_000 })

      await openHermoso()

      const list = page.getByTestId('timemachine-list')

      await expect(list.getByRole('listitem')).toHaveCount(2, { timeout: 60_000 })

      const oldest = list.getByRole('listitem').nth(1)

      await oldest.getByRole('button', { name: 'See changes' }).click()
      await expect(oldest.getByTestId('timemachine-diff')).toContainText('report.txt', { timeout: 30_000 })
      await oldest.getByRole('button', { name: 'Rewind to here' }).click()
      await expect(oldest.getByTestId('timemachine-confirm')).toBeVisible()
      await page.waitForTimeout(400)
      await section(page, list).screenshot({ path: shot('time-machine') })

      await oldest.getByRole('button', { name: 'Rewind', exact: true }).click()
      await expect(page.getByTestId('timemachine-note')).toContainText('Rewound', { timeout: 60_000 })
      expect(fs.existsSync(path.join(PROJECT, 'report.txt'))).toBe(false)

      // ── Guardian: the question, a no, a yes, and one thing that is never allowed ──
      await newSession()

      const hooks = path.join(PROJECT, '.git', 'hooks')

      fs.mkdirSync(hooks, { recursive: true })
      const dialog = page.getByRole('dialog').filter({ hasText: /Writing files that run by themselves/ })

      await say(page, `${GUARD_WRITE} ${path.join(hooks, 'pre-commit')}`)
      await expect(dialog).toContainText('Writing files that run by themselves?', { timeout: 180_000 })
      await expect(page.getByTestId('consent-code')).toContainText(path.join('.git', 'hooks', 'pre-commit'))
      await page.waitForTimeout(500)
      await dialog.screenshot({ path: shot('guardian-ask') })
      await dialog.getByRole('button', { name: 'Deny' }).click()
      await expect(page.getByText(GUARD_DENIED_DONE)).toBeVisible({ timeout: 120_000 })

      await say(page, `${GUARD_WRITE} ${path.join(hooks, 'pre-push')}`)
      await expect(dialog).toContainText('Writing files that run by themselves?', { timeout: 120_000 })
      await dialog.getByRole('button', { name: 'Allow once' }).click()
      await expect(page.getByText(GUARD_WRITTEN_DONE)).toBeVisible({ timeout: 120_000 })

      await say(page, `${GUARD_WRITE} ${path.join(sandbox.userDataDir, 'hermoso', 'forged.json')}`)
      await expect(page.getByText(GUARD_BLOCKED_DONE)).toBeVisible({ timeout: 120_000 })

      // ── Teleport: the person's own trip, with the way home already written down ──
      await askHermoso(page, 'teleport.jump', { country: 'de', minutes: 10 })
      await openHermoso()

      const trip = page.locator('section').filter({ hasText: /Exiting from/ })

      await expect(trip).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(500)
      await trip.screenshot({ path: shot('teleport') })
      await askHermoso(page, 'teleport.home')
      await expect(page.locator('section').filter({ hasText: /Exiting from/ })).toHaveCount(0, { timeout: 60_000 })

      // ── Shield: the tunnel drops under a running agent ──
      const frozen = async () => (await askHermoso<{ frozen: boolean }>(page, 'shield.state')).frozen

      setTunnel('disconnected')
      await expect.poll(frozen, { message: 'the shield never froze', timeout: 40_000 }).toBe(true)
      await expect(page.getByTestId('shield-headline')).toContainText('frozen', { timeout: 30_000 })

      // The drop lasts a few seconds (a blink is not counted for the aura), and the app's own "VPN disconnected"
      // notice is put away so it does not cover the picture.
      await page.waitForTimeout(4_000)
      await page
        .getByRole('button', { name: /dismiss/i })
        .first()
        .click({ timeout: 3_000 })
        .catch(() => undefined)
      await hideRadar(page)
      await section(page, page.getByTestId('shield-headline')).screenshot({ path: shot('shield-frozen') })

      setTunnel('connected')
      await expect.poll(frozen, { timeout: 60_000 }).toBe(false)
      await expect(page.getByTestId('shield-headline')).toHaveText('Protected', { timeout: 30_000 })

      // ── Ghost: a second window that keeps nothing ──
      await page.getByRole('button', { name: 'Open a ghost window' }).click()
      await expect(page.getByTestId('ghost-opened')).toBeVisible({ timeout: 30_000 })

      const connected = await connectToGhost(PORT)

      ghost = connected.browser

      await waitForBackendReady(connected.page)
      await connected.page.getByRole('button', { name: 'Hermoso' }).first().click()
      await expect(connected.page.getByTestId('ghost-banner')).toBeVisible()
      await section(connected.page, connected.page.getByTestId('ghost-banner')).evaluate(element =>
        element.scrollIntoView({ block: 'center' })
      )
      await connected.page.waitForTimeout(800)
      await pictureOfElement(
        page,
        connected.page,
        section(connected.page, connected.page.getByTestId('ghost-banner')),
        shot('ghost')
      )

      const gone = new Promise<void>(resolve => ghost!.on('disconnected', () => resolve()))

      await connected.page.getByTestId('panic').click()
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 30_000))])

      // ── The page: Aura first, then the Shield, calm again ──
      await expect
        .poll(async () => (await askHermoso<{ points: number }>(page, 'aura.get')).points, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(100)
      await page.waitForTimeout(500)

      // The top of the page: the portrait, the Aura, and the Shield without its connection list.
      await hideRadar(page)
      await page.locator('section').evaluateAll(sections => {
        sections.slice(2).forEach(element => {
          ;(element as HTMLElement).style.display = 'none'
        })
      })

      const header = page.locator('header').filter({ hasText: 'The brother who protects.' })

      // The column starts a little lower, so the window's own toolbar buttons (top right) are not in the picture.
      const column = header.locator('xpath=..')

      await column.evaluate(element => {
        element.style.marginTop = '56px'
      })
      await column.evaluate(element => element.closest('.overflow-y-auto')?.scrollTo(0, 0))
      await page.waitForTimeout(500)
      await column.screenshot({ path: shot('page') })

      // ── Teleport, asked by the agent: the question comes before anything moves (the README's flights and hotels) ──
      await newSession()
      await say(page, `${TELEPORT_TRIP} find me the cheapest flight and a hotel`)

      const ask = page.getByRole('dialog').filter({ hasText: /Teleport to/ })

      await expect(ask).toContainText('Teleport to Germany?', { timeout: 180_000 })
      await expect(ask).toContainText('Compare flight and hotel prices from Germany')
      await page.waitForTimeout(500)
      await ask.screenshot({ path: shot('teleport-ask') })
      await ask.getByRole('button', { name: 'Allow once' }).click()
      await expect(page.getByText(YES_DONE)).toBeVisible({ timeout: 180_000 })
    } finally {
      await ghost?.close().catch(() => undefined)
      killGhosts()
      await run.cleanup()

      for (const folder of ghostFolders().filter(candidate => !before.has(candidate))) {
        fs.rmSync(folder, { force: true, recursive: true })
      }

      fs.rmSync(DEMO_ROOT, { force: true, recursive: true })
    }
  })
})
