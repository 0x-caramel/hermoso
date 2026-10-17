/**
 * Hermoso, wired together (main process, Electron-free).
 *
 * One object the app creates once. It owns:
 *   - Teleport (the Mullvad exit country, for a while) and its trip file;
 *   - the bridge the agent's plugin talks to, and the environment that lets a backend find it;
 *   - the plugin's installation into each Hermes home, before that home's backend starts;
 *   - one call surface (`call`) for the app's own windows, so a new feature never needs a new IPC channel.
 *
 * main.ts reaches it in a handful of places (see fork/hooks.json): create it, let it recover before the VPN gate,
 * `prepare` a Hermes home and take `backendEnv()` before every backend spawn, answer `hermoso:call`, wait for the
 * way home on quit.
 */

import path from 'node:path'

import type { MullvadClient } from '../mullvad'
import type { VpnController } from '../vpn-controller'

import { createBridge } from './bridge'
import { createPluginInstaller, type PluginInstallDeps } from './plugin-install'
import { createFileTeleportStore, createTeleport, resolveDestination, type TeleportRequest } from './teleport'

export interface HermosoDeps {
  /** Send an event to every window. */
  broadcast: (channel: string, payload: unknown) => void
  /** The app's data folder: Hermoso keeps its own files under `<dataDir>/hermoso`. */
  dataDir: string
  log: (message: string) => void
  mullvad: Pick<
    MullvadClient,
    'connect' | 'disconnect' | 'listRelays' | 'relayGet' | 'setRelayLocation' | 'statusDetails'
  >
  /** Where the plugin's files are inside the app. */
  pluginSource: string
  runHermes: PluginInstallDeps['runHermes']
  /** Waiting between tunnel polls; tests pass a fake one. */
  sleep?: (ms: number) => Promise<void>
  vpn: Pick<VpnController, 'holdTransition' | 'refresh'>
}

export const EVENT_CHANNEL = 'hermoso:event'

const QUIT_WAIT_MS = 8_000

const text = (value: unknown): null | string => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** A jump request out of untrusted JSON (the agent's, through the bridge; or the window's). */
function parseJump(raw: unknown, by: TeleportRequest['by']): TeleportRequest {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const minutes = typeof body.minutes === 'number' ? body.minutes : Number(body.minutes)

  return {
    by,
    city: text(body.city),
    country: text(body.country) ?? '',
    minutes: Number.isFinite(minutes) ? minutes : undefined,
    reason: text(body.reason)
  }
}

export function createHermoso(deps: HermosoDeps) {
  const { log } = deps

  const teleport = createTeleport({
    client: deps.mullvad,
    hold: () => deps.vpn.holdTransition(),
    log,
    onChanged: () => void deps.vpn.refresh().catch(() => {}),
    onState: state => deps.broadcast(EVENT_CHANNEL, { state, type: 'teleport' }),
    sleep: deps.sleep,
    store: createFileTeleportStore(path.join(deps.dataDir, 'hermoso', 'teleport.json'))
  })

  const installer = createPluginInstaller(deps.pluginSource, { log, runHermes: deps.runHermes })
  const bridge = createBridge({ log })

  // ── what the agent can ask (through the plugin) ──

  // The agent is never the user: whatever `by` it sends, a request that comes through the bridge is the agent's.
  bridge.route('POST', '/v1/teleport/jump', ({ body }) => teleport.jump(parseJump(body, 'agent')))
  bridge.route('POST', '/v1/teleport/home', () => teleport.home('agent'))
  bridge.route('GET', '/v1/teleport/state', () => ({ ok: true, state: teleport.getState() }))

  bridge.route('GET', '/v1/teleport/destinations', async () => ({ countries: await teleport.destinations(), ok: true }))

  bridge.route('GET', '/v1/teleport/resolve', async ({ query }) => {
    const resolved = resolveDestination(await teleport.destinations(), query.get('country'), query.get('city'))

    if ('message' in resolved) {
      return { code: 'unknown-destination', message: resolved.message, ok: false }
    }

    return {
      city: resolved.city && { code: resolved.city.code, name: resolved.city.name },
      country: { code: resolved.country.code, name: resolved.country.name },
      ok: true
    }
  })

  // ── what the app's own windows can ask ──

  const methods: Record<string, (params: unknown) => Promise<unknown> | unknown> = {
    'teleport.destinations': () => teleport.destinations(),
    'teleport.home': () => teleport.home('user'),
    'teleport.jump': params => teleport.jump(parseJump(params, 'user')),
    'teleport.state': () => teleport.getState()
  }

  return {
    /** The environment a backend needs to find the bridge (empty until `prepare` has started it). */
    backendEnv: (): Record<string, string> => bridge.env(),

    /** On the way out: bring the machine home, but never hold the quit for more than a few seconds. */
    async beforeQuit(): Promise<void> {
      if (!teleport.needsQuitWait()) {
        return
      }

      await Promise.race([
        teleport.home('quit').catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, QUIT_WAIT_MS).unref?.())
      ])
    },

    async call(method: string, params?: unknown): Promise<unknown> {
      const handler = methods[method]

      if (!handler) {
        return { code: 'unknown-method', message: `unknown Hermoso method "${method}"`, ok: false }
      }

      return handler(params)
    },

    async dispose(): Promise<void> {
      teleport.dispose()
      await bridge.stop()
    },

    needsQuitWait: (): boolean => teleport.needsQuitWait(),

    /**
     * Before a backend starts for this Hermes home: the bridge is up and the plugin is installed and enabled.
     * Never throws and never blocks the start for longer than a failed command's timeout: a backend without the
     * plugin is a backend without Hermoso's tools, not a broken backend.
     */
    async prepare(hermesHome: string): Promise<void> {
      try {
        await bridge.start()
      } catch (error) {
        log(`[hermoso] the bridge did not start: ${error instanceof Error ? error.message : String(error)}`)
      }

      await installer.prepare(hermesHome)
    },

    /** At launch, before the VPN gate connects anything: a trip left open by a crash is brought home. */
    recover: (): Promise<void> => teleport.recover(),

    teleport
  }
}

export type Hermoso = ReturnType<typeof createHermoso>
