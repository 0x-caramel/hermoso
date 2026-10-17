/**
 * What the Hermoso e2e specs share: launching the app with a scripted model and a scripted `mullvad` CLI, waiting
 * for the real Hermes backend, and talking in the chat.
 *
 * Prerequisite: `npm run build` (dist/ exists). The backend runs from HERMES_E2E_HERMES_ROOT (a Hermes checkout or
 * runtime with its Python environment installed; a fork without one points it at %LOCALAPPDATA%\Hermes\hermes-agent).
 *
 * HERMOSO_E2E_PACKED=1 runs the very same specs against the packed `Hermoso.exe` (`node fork/pack.mjs` first) instead
 * of `electron .`: what a person installs, with the same scripted model and scripted Mullvad.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { _electron, type Browser, chromium, type ElectronApplication, type Page } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'

import { buildAppEnv, createSandbox, launchDesktop } from './fixtures'
import { type HermosoMock, startHermosoMock } from './hermoso-mock-model'
import { expect, installErrorBannerGuard } from './test'

const FAKE_CLI = path.resolve(import.meta.dirname, 'fake-mullvad.mjs')

/** What `fork/pack.mjs` makes: the app as a person installs it. */
const PACKED_EXE = path.resolve(import.meta.dirname, '..', 'release', 'win-unpacked', 'Hermoso.exe')

async function launchPacked(env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  if (!fs.existsSync(PACKED_EXE)) {
    throw new Error(`${PACKED_EXE} is not there: run \`node fork/pack.mjs\` first`)
  }

  // The packed app has its own renderer: nothing may point it at a dev server.
  const clean = { ...env }

  delete (clean as Record<string, string | undefined>).HERMES_DESKTOP_DEV_SERVER

  const app = await _electron.launch({
    args: ['--disable-gpu', '--no-sandbox'],
    env: clean,
    executablePath: PACKED_EXE
  })

  const page = await app.firstWindow()

  installErrorBannerGuard(page)

  return { app, page }
}

export interface FakeState {
  lockdown?: boolean
  log: string[]
  relay: string
  tunnel: string
}

export interface HermosoRun {
  cleanup: () => Promise<void>
  mock: HermosoMock
  page: Page
  readState: () => FakeState
  sandbox: ReturnType<typeof createSandbox>
  /** Change what the scripted Mullvad says the tunnel is doing (the way a real drop or recovery would). */
  setTunnel: (tunnel: 'blocked' | 'connected' | 'disconnected') => void
}

export async function launchHermoso(extraEnv: Record<string, string> = {}): Promise<HermosoRun> {
  const mock = await startHermosoMock()
  const sandbox = createSandbox('hermoso')
  const statePath = path.join(sandbox.root, 'fake-mullvad.json')

  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)
  fs.writeFileSync(
    statePath,
    JSON.stringify({ account: true, connectDelayMs: 800, lockdown: false, relay: 'country se', tunnel: 'disconnected' })
  )

  const env = buildAppEnv(sandbox, {
    FAKE_MULLVAD_STATE: statePath,
    // A fresh sandbox HERMES_HOME would first install a whole toolchain before the backend listens.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_DESKTOP_HERMES_ROOT: process.env.HERMES_E2E_HERMES_ROOT ?? buildAppEnv(sandbox).HERMES_DESKTOP_HERMES_ROOT,
    HERMES_DESKTOP_VPN: 'on',
    HERMES_MULLVAD_CLI: FAKE_CLI,
    ...extraEnv
  })

  const { app, page } = process.env.HERMOSO_E2E_PACKED === '1' ? await launchPacked(env) : await launchDesktop(env)

  return {
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()

      // HERMOSO_E2E_KEEP=1 copies the sandbox (logs, config, plugin folder) out of the temp folder, which the
      // test runner empties, to look at after a failure.
      if (process.env.HERMOSO_E2E_KEEP) {
        const kept = path.resolve(import.meta.dirname, '..', 'test-results', `kept-${path.basename(sandbox.root)}`)

        fs.cpSync(sandbox.root, kept, { force: true, recursive: true })
        console.log(`[hermoso-e2e] sandbox kept at ${kept}`)
      }

      sandbox.cleanup()
    },
    mock,
    page,
    readState: (): FakeState => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    sandbox,
    setTunnel: tunnel => {
      // The scripted CLI rewrites this file on every call: read it fresh and change only the tunnel.
      const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'))

      fresh.tunnel = tunnel
      fs.writeFileSync(statePath, JSON.stringify(fresh, null, 2))
    }
  }
}

// Main's own word that the backend came up (its boot phase reaches `backend.ready` only after the HTTP and
// WebSocket probes pass). Polled with page.evaluate: page.waitForFunction does not await an async predicate.
export async function waitForBackendReady(page: Page, timeoutMs = 180_000) {
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

export async function say(page: Page, text: string) {
  const composer = page.locator('[contenteditable="true"]').first()

  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  await composer.click()
  await composer.type(text)
  await page.keyboard.press('Enter')
}

/** Ask the app's Hermoso (main process) something, the way the window does. */
export function askHermoso<T = any>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      (
        window as unknown as {
          hermesDesktop: { hermoso: { call: (method: string, params?: unknown) => Promise<unknown> } }
        }
      ).hermesDesktop.hermoso.call(name as string, args),
    [method, params] as const
  ) as Promise<T>
}

/** Connect to a second Hermoso (a ghost) through the debugging port a test gave it, and find its app window. */
export async function connectToGhost(port: number): Promise<{ browser: Browser; page: Page }> {
  let last: unknown = null
  let seen = ''

  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)

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

  throw new Error(`the ghost window never answered on port ${port}: ${String(last)}; pages: ${seen}`)
}

/** The ghost folders that exist in the temporary folder right now. */
export const ghostFolders = () =>
  fs
    .readdirSync(os.tmpdir())
    .filter(name => /^hermoso-ghost-[0-9a-f]{12}$/.test(name))
    .map(name => path.join(os.tmpdir(), name))

/** Stop every ghost process (a test's safety net: a ghost that was not wiped must not outlive it). */
export const killGhosts = () =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--hermoso-ghost' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ],
    { windowsHide: true }
  )
