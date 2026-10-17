/**
 * Hermoso, wired together (main process, Electron-free).
 *
 * One object the app creates once. It owns:
 *   - Teleport (the Mullvad exit country, for a while) and its trip file;
 *   - consent: the person's yes, asked in the app itself, for everything the agent asks that changes the computer;
 *   - the bridge the agent's plugin talks to, and the file that tells the plugin where it is;
 *   - the plugin's installation into each Hermes home, before that home's backend starts;
 *   - one call surface (`call`) for the app's own windows, so a new feature never needs a new IPC channel.
 *
 * main.ts reaches it in a handful of places (see fork/hooks.json): create it, let it recover before the VPN gate,
 * `prepare` a Hermes home before every backend spawn, answer `hermoso:call`, wait for the way home on quit.
 */

import os from 'node:os'
import path from 'node:path'

import type { MullvadClient } from '../mullvad'
import type { VpnController } from '../vpn-controller'

import { computeAura } from './aura'
import { createBridge } from './bridge'
import { removeBridgeFile, writeBridgeFile } from './bridge-file'
import { createConsent, createFileConsentStore } from './consent'
import { runCommand } from './exec'
import {
  claimGhost,
  GHOST_DEBUG_PORT_ENV,
  GHOST_ENV,
  isGhostDir,
  launchGhost,
  PANIC_KEY,
  pidAlive,
  type SpawnFn,
  sweepStale,
  wipeLater
} from './ghost'
import { createGuardian, type GuardianDecision, loadRuleTable, type RuleTable } from './guardian'
import { createLedger } from './ledger'
import { createNativeConsent, type NativeDialog } from './native-consent'
import { createPluginInstaller, type PluginInstallDeps } from './plugin-install'
import { createRadar, type RadarDeps, type RadarSample } from './radar'
import { createFileSettingsStore, createSettings } from './settings'
import { createShield } from './shield'
import { createFileStatsStore, createStats } from './stats'
import {
  clampTripMinutes,
  createFileTeleportStore,
  createTeleport,
  resolveDestination,
  type TeleportRequest
} from './teleport'

/** What Hermoso needs of an app window (structural: this file stays Electron-free). */
export interface HermosoWindow {
  focus: () => void
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
}

export interface HermosoDeps {
  /** Shown in the shield report. */
  appVersion?: string
  /** The app's data folder: Hermoso keeps its own files under `<dataDir>/hermoso`. */
  dataDir: string
  /** The environment the Hermes backends inherit (the app's own, unless a test passes one). */
  env?: NodeJS.ProcessEnv
  /** Ghost: what only the app itself knows. Without it there is no ghost to open (and none is one). */
  ghost?: {
    appPath: string
    execPath: string
    /** Quit at once, without the usual orderly goodbye (the panic key). */
    exit: () => void
    /** The command line of this app: a ghost keeps the flags that decide how a window is drawn. */
    flags?: readonly string[]
    isAlive?: (pid: number) => boolean
    packaged: boolean
    /** Bind a key that works whatever app is in front; false when the key is taken. */
    registerPanicKey?: (accelerator: string, handler: () => void) => boolean
    spawn?: SpawnFn
    tmpRoot?: string
  }
  /** For the native consent dialog, used only when no window shows a request in time. */
  dialog: NativeDialog
  /** Runs `netstat` and the process list for the radar. */
  exec?: RadarDeps['exec']
  /** `os.networkInterfaces()`. */
  interfaces?: RadarDeps['interfaces']
  log: (message: string) => void
  mullvad: Pick<
    MullvadClient,
    | 'connect'
    | 'disconnect'
    | 'listRelays'
    | 'lockdownGet'
    | 'lockdownSet'
    | 'relayGet'
    | 'setRelayLocation'
    | 'statusDetails'
  >
  /** Where the plugin's files are inside the app. */
  pluginSource: string
  runHermes: PluginInstallDeps['runHermes']
  /** Waiting between tunnel polls; tests pass a fake one. */
  sleep?: (ms: number) => Promise<void>
  vpn: Pick<VpnController, 'getState' | 'holdTransition' | 'refresh'>
  /** The app's open windows. */
  windows: () => HermosoWindow[]
}

export const EVENT_CHANNEL = 'hermoso:event'

const QUIT_WAIT_MS = 8_000
// How often the shield looks at the VPN controller, and the radar at the machine's connections.
const SHIELD_CHECK_MS = 1_000
const RADAR_SAMPLE_MS = 10_000
// The VPN controller polls Mullvad every few seconds; an agent about to act asks for a fresher look than that,
// but never more often than this (a frozen agent asks every second).
const FRESH_VERDICT_MS = 2_000
// A plugin that has not asked for this long is not talking to us any more.
const AGENT_STALE_MS = 60_000
// A freeze shorter than this is not a drop worth counting (a status read that failed once, a reconnect that blinked).
const MIN_FREEZE_MS = 3_000

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

/** Whether the agent's plugin has been in touch, and which version of it. */
export interface AgentLink {
  seenAt: null | number
  version: null | string
}

export function createHermoso(deps: HermosoDeps) {
  const { log } = deps
  const published = new Set<string>()
  let agent: AgentLink = { seenAt: null, version: null }

  const liveWindows = () => deps.windows().filter(win => !win.isDestroyed())

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of liveWindows()) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  /** Bring the app forward: a question that nobody sees is no question. */
  const reveal = (): void => {
    try {
      const win = liveWindows()[0]

      if (win) {
        if (win.isMinimized()) {
          win.restore()
        }

        win.show()
        win.focus()
      }
    } catch (error) {
      log(`[hermoso] could not bring the window forward: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const teleport = createTeleport({
    client: deps.mullvad,
    hold: () => deps.vpn.holdTransition(),
    log,
    onChanged: () => void deps.vpn.refresh().catch(() => {}),
    // A trip that really happened (the tunnel came up there) is one more for the aura; one that failed is not.
    onEvent: event => {
      if (event.type === 'jumped') {
        stats.bump('teleports')
      }
    },
    onState: state => broadcast(EVENT_CHANNEL, { state, type: 'teleport' }),
    sleep: deps.sleep,
    store: createFileTeleportStore(path.join(deps.dataDir, 'hermoso', 'teleport.json'))
  })

  // ── what Hermoso has done for the person, and what the person switched on or off ──

  // Aura is arithmetic over the counters, so it is never kept anywhere: it is worked out when it is asked for, and
  // pushed to the windows whenever the counters change and the result is different.
  let lastAura = ''

  const auraView = () => {
    const { counters, since } = stats.get()

    return { ...computeAura(counters), since }
  }

  const stats = createStats({
    log,
    onChange: () => {
      const aura = auraView()
      const signature = JSON.stringify(aura)

      if (signature !== lastAura) {
        lastAura = signature
        broadcast(EVENT_CHANNEL, { aura, type: 'aura' })
      }
    },
    store: createFileStatsStore(path.join(deps.dataDir, 'hermoso', 'stats.json'))
  })

  lastAura = JSON.stringify(auraView())
  const settings = createSettings(createFileSettingsStore(path.join(deps.dataDir, 'hermoso', 'settings.json')))

  // ── Time Machine: Hermes snapshots the project folder before the agent first changes a file in a turn ──

  // The desktop's backend turns that on from this variable (read once, when the backend starts), not from the
  // person's config file, so nothing of theirs is edited. A value the person set themselves is left alone.
  const env = deps.env ?? process.env

  if (settings.get().timeMachine && env.HERMES_TUI_CHECKPOINTS === undefined) {
    env.HERMES_TUI_CHECKPOINTS = '1'
  }

  const timeMachineActive = /^(?:1|true|yes|on)$/i.test(String(env.HERMES_TUI_CHECKPOINTS ?? '').trim())
  const timeMachineView = () => ({ active: timeMachineActive, enabled: settings.get().timeMachine })

  // ── Ghost: a window that keeps nothing ──

  const ghostTmp = deps.ghost?.tmpRoot ?? os.tmpdir()

  // A ghost is a process whose own folder (the variable its parent set) really is a ghost's folder: a path that
  // merely looks like one in the environment can never make this wipe anything else.
  const ghostDir =
    deps.ghost && env[GHOST_ENV] && isGhostDir(String(env[GHOST_ENV]), ghostTmp) ? String(env[GHOST_ENV]) : null

  let activeHome: null | string = null
  let ghostReady = false

  if (ghostDir) {
    claimGhost(ghostDir, process.pid)
  }

  /** Delete this ghost's folder once its processes are gone, and quit at once. */
  const panic = async () => {
    if (!ghostDir) {
      return { ok: false }
    }

    // The helper has to be on its way before this quits, or it goes down with it.
    await wipeLater(ghostDir, ghostTmp, { spawn: deps.ghost?.spawn })
    deps.ghost?.exit()

    return { ok: true }
  }

  // ── shield: the agent stands still while the VPN is required and the tunnel is not up ──

  let frozenSince: null | number = null

  // A launch with the tunnel still coming up is not a drop: the agent has not even started, so nothing was held.
  // Only a freeze that follows a calm moment is counted for the aura, and only when it lasted long enough to be one.
  let wasCalm = false

  /** A freeze is over (or the app is going while one is on): into the counters, if it was a real one. */
  const endFreeze = (): void => {
    if (frozenSince === null) {
      return
    }

    const lasted = Date.now() - frozenSince

    frozenSince = null

    if (lasted >= MIN_FREEZE_MS) {
      stats.bump('freezes')
      stats.bump('frozenSeconds', Math.round(lasted / 1000))
    }
  }

  const shield = createShield({
    onChange: state => {
      log(
        `[shield] ${state.frozen ? 'frozen' : 'calm'} (tunnel ${state.tunnel}, VPN ${state.required ? 'required' : 'not required'})`
      )

      if (!state.frozen) {
        wasCalm = true
        endFreeze()
      } else if (frozenSince === null && wasCalm) {
        frozenSince = Date.now()
      }

      broadcast(EVENT_CHANNEL, { state, type: 'shield' })
    },
    vpn: () => deps.vpn.getState()
  })

  wasCalm = !shield.getState().frozen

  let lastLook = 0

  /** The verdict after a fresh look at the tunnel (at most one look per FRESH_VERDICT_MS), for who is about to act. */
  const freshVerdict = async () => {
    if (Date.now() - lastLook >= FRESH_VERDICT_MS) {
      lastLook = Date.now()
      await deps.vpn.refresh().catch(() => {})
    }

    return shield.check()
  }

  const ledger = createLedger()
  let tunnelInterface = 'Mullvad'
  let latestSample: null | RadarSample = null

  const radar = createRadar({
    exec: deps.exec ?? runCommand,
    interfaces: deps.interfaces ?? (() => os.networkInterfaces() as ReturnType<RadarDeps['interfaces']>),
    roots: () => [process.pid],
    tunnelInterface: () => tunnelInterface
  })

  /** One look at the machine: the app's connections, judged and counted. */
  const lookAtTheMachine = async (): Promise<RadarSample> => {
    const status = await deps.mullvad.statusDetails().catch(() => null)

    tunnelInterface = status?.details?.tunnelInterface ?? tunnelInterface

    const sample = await radar.sample()

    ledger.record(sample, shield.check())
    latestSample = sample

    return sample
  }

  let timers: ReturnType<typeof setInterval>[] = []

  const startWatching = (): void => {
    if (timers.length > 0) {
      return
    }

    timers = [
      setInterval(() => void shield.check(), SHIELD_CHECK_MS),
      setInterval(() => void lookAtTheMachine().catch(() => {}), RADAR_SAMPLE_MS)
    ]

    for (const timer of timers) {
      timer.unref?.()
    }
  }

  const consent = createConsent({
    log,
    native: createNativeConsent({ dialog: deps.dialog, window: () => liveWindows()[0] ?? null }),
    present: prompt => {
      reveal()
      broadcast(EVENT_CHANNEL, { prompt, type: 'consent' })
    },
    retire: id => broadcast(EVENT_CHANNEL, { id, type: 'consent-closed' }),
    store: createFileConsentStore(path.join(deps.dataDir, 'hermoso', 'consent.json'))
  })

  // ── guardian: a person between the agent and the few things that cannot be undone ──

  let ruleTable: null | RuleTable = null

  const COUNTED: Record<GuardianDecision, string> = {
    allowed: 'guardianAllowed',
    always: 'guardianAllowed',
    blocked: 'guardianBlocked',
    denied: 'guardianDenied',
    remembered: 'guardianAllowed',
    timeout: 'guardianDenied'
  }

  const guardian = createGuardian({
    consent,
    enabled: () => settings.get().guardian,
    journal: event => {
      stats.event(event)
      stats.bump(COUNTED[event.decision])

      if (event.decision !== 'blocked' && event.decision !== 'remembered') {
        stats.bump('guardianAsked')
      }

      broadcast(EVENT_CHANNEL, { event, type: 'guardian' })
    },
    rules: () => (ruleTable ??= loadRuleTable(deps.pluginSource))
  })

  const guardianView = () => {
    const { counters, recent } = stats.get()

    return {
      enabled: settings.get().guardian,
      events: recent,
      totals: {
        allowed: counters.guardianAllowed ?? 0,
        asked: counters.guardianAsked ?? 0,
        blocked: counters.guardianBlocked ?? 0,
        denied: counters.guardianDenied ?? 0
      }
    }
  }

  const installer = createPluginInstaller(deps.pluginSource, { log, runHermes: deps.runHermes })
  const bridge = createBridge({ log })

  // ── what the agent can ask (through the plugin) ──

  /**
   * A jump the AGENT asks for: only after the person says yes, in Hermoso's own words (or said "always" for this
   * country before). The agent is never the user: whatever `by` it sends, a request through the bridge is the agent's.
   */
  async function agentJump(body: unknown) {
    const request = parseJump(body, 'agent')
    const resolved = resolveDestination(await teleport.destinations(), request.country, request.city)

    if ('message' in resolved) {
      return { code: 'unknown-destination', message: resolved.message, ok: false, state: teleport.getState() }
    }

    const place = resolved.city ? `${resolved.country.name} (${resolved.city.name})` : resolved.country.name
    const minutes = clampTripMinutes(request.minutes)

    const decision = await consent.ask({
      allowKey: `teleport:${resolved.country.code}`,
      allowLabel: resolved.country.name,
      kind: 'teleport',
      lines: [
        `The agent wants to move your whole computer’s internet exit to ${place} for ${minutes} minutes.`,
        request.reason ? `Why: ${request.reason}` : 'It gave no reason.',
        'Every app on this computer will exit from there. It comes back by itself.'
      ],
      title: `Teleport to ${place}?`
    })

    if (!decision.allowed) {
      return {
        code: 'denied',
        message:
          decision.answer === 'timeout' ? 'The user did not answer in time, so it was not done.' : 'The user said no.',
        ok: false,
        state: teleport.getState()
      }
    }

    return teleport.jump(request)
  }

  bridge.route('GET', '/v1/hello', ({ query }) => {
    const version = text(query.get('plugin'))
    const now = Date.now()
    const news = agent.seenAt === null || now - agent.seenAt > AGENT_STALE_MS || agent.version !== version

    agent = { seenAt: now, version }

    if (news) {
      broadcast(EVENT_CHANNEL, { agent, type: 'agent' })
    }

    return { app: 'hermoso', ok: true, pid: process.pid }
  })

  // The plugin asks before it acts: is the agent allowed to move right now?
  bridge.route('GET', '/v1/shield/state', async () => ({ ...(await freshVerdict()), ok: true }))

  // The plugin recognised something risky and asks the person before it runs.
  bridge.route('POST', '/v1/guardian/ask', ({ body }) => guardian.ask(body))

  bridge.route('POST', '/v1/teleport/jump', ({ body }) => agentJump(body))
  bridge.route('POST', '/v1/teleport/home', () => teleport.home('agent'))
  bridge.route('GET', '/v1/teleport/state', () => ({ ok: true, state: teleport.getState() }))

  bridge.route('GET', '/v1/teleport/destinations', async () => ({ countries: await teleport.destinations(), ok: true }))

  // ── what the app's own windows can ask ──

  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  const methods: Record<string, (params: unknown) => Promise<unknown> | unknown> = {
    'agent.state': () => agent,
    'aura.get': () => auraView(),
    'consent.ack': params => consent.ack(String(asRecord(params).id)),
    'consent.always': () => consent.always(),
    'consent.answer': params => consent.answer(String(asRecord(params).id), asRecord(params).answer),
    'consent.pending': () => consent.pending(),
    'consent.revoke': params => consent.revoke(String(asRecord(params).key)),
    'ghost.open': () => {
      if (ghostDir || !deps.ghost) {
        return { code: 'unavailable', message: 'A ghost can be opened from the main window only.', ok: false }
      }

      if (!activeHome) {
        return { code: 'no-setup', message: 'Hermoso has not started its agent yet: try again in a moment.', ok: false }
      }

      const port = Number(env[GHOST_DEBUG_PORT_ENV])

      const result = launchGhost({
        appPath: deps.ghost.appPath,
        debugPort: Number.isInteger(port) && port > 0 ? port : undefined,
        env,
        execPath: deps.ghost.execPath,
        flags: deps.ghost.flags,
        packaged: deps.ghost.packaged,
        sourceHome: activeHome,
        sourceUserData: deps.dataDir,
        spawn: deps.ghost.spawn,
        tmpRoot: ghostTmp
      })

      if (result.ok) {
        stats.bump('ghosts')
        log('[ghost] opened a ghost window')
      }

      return result
    },

    'ghost.panic': () => panic(),
    'ghost.state': () => ({ canOpen: !ghostDir && Boolean(deps.ghost), ghost: ghostDir !== null, key: PANIC_KEY }),
    'guardian.enable': params => {
      settings.set({ guardian: asRecord(params).on === true })

      return guardianView()
    },

    'guardian.state': () => guardianView(),
    'shield.lockdown.get': () => deps.mullvad.lockdownGet(),

    'shield.lockdown.set': async params => {
      const result = await deps.mullvad.lockdownSet(asRecord(params).on === true)

      return { ok: result.code === 0, on: await deps.mullvad.lockdownGet() }
    },

    'shield.radar': async () => ({
      sample: await lookAtTheMachine(),
      shield: shield.check(),
      summary: ledger.summary()
    }),

    'shield.report': async () => {
      const status = await deps.mullvad.statusDetails().catch(() => null)
      const place = status?.details
      const exit = place?.country ? (place.city ? `${place.country}, ${place.city}` : place.country) : null

      return ledger.report({
        appVersion: deps.appVersion,
        exit: place?.state === 'connected' ? exit : null,
        lockdown: await deps.mullvad.lockdownGet().catch(() => null),
        vpnRequired: shield.check().required
      })
    },

    'shield.reset': () => {
      ledger.reset()

      return true
    },

    'shield.state': () => freshVerdict(),
    'stats.get': () => stats.get(),
    'teleport.destinations': () => teleport.destinations(),
    'teleport.home': () => teleport.home('user'),
    'teleport.jump': params => teleport.jump(parseJump(params, 'user')),
    'teleport.state': () => teleport.getState(),
    'timemachine.enable': params => {
      settings.set({ timeMachine: asRecord(params).on === true })

      return timeMachineView()
    },
    'timemachine.rewound': () => {
      stats.bump('rewinds')

      return true
    },
    'timemachine.state': () => timeMachineView()
  }

  return {
    /** On the way out: bring the machine home, but never hold the quit for more than a few seconds. */
    async beforeQuit(): Promise<void> {
      endFreeze()
      stats.flush()

      if (teleport.needsQuitWait()) {
        await Promise.race([
          teleport.home('quit').catch(() => {}),
          new Promise<void>(resolve => setTimeout(resolve, QUIT_WAIT_MS).unref?.())
        ])
      }

      // A ghost leaves nothing: its folder is deleted as soon as its processes let go of it.
      if (ghostDir) {
        await wipeLater(ghostDir, ghostTmp, { spawn: deps.ghost?.spawn })
      }
    },

    async call(method: string, params?: unknown): Promise<unknown> {
      const handler = methods[method]

      if (!handler) {
        return { code: 'unknown-method', message: `unknown Hermoso method "${method}"`, ok: false }
      }

      return handler(params)
    },

    consent,

    async dispose(): Promise<void> {
      teleport.dispose()
      endFreeze()
      stats.flush()
      timers.forEach(timer => clearInterval(timer))
      timers = []

      // The plugin must not keep an address that no longer answers.
      for (const home of published) {
        removeBridgeFile(home)
      }

      published.clear()
      await bridge.stop()
    },

    // main.ts runs beforeQuit() only when this says so: a ghost always has something to do on the way out.
    needsQuitWait: (): boolean => ghostDir !== null || teleport.needsQuitWait(),

    /**
     * Before a backend starts for this Hermes home: the bridge is up, the plugin is installed and enabled, and the
     * plugin has been told where the app is. Never throws and never blocks the start for longer than a failed
     * command's timeout: a backend without the plugin is a backend without Hermoso's tools, not a broken backend.
     */
    async prepare(hermesHome: string): Promise<void> {
      let address: { token: string; url: string } | null = null

      startWatching()
      activeHome = hermesHome

      if (!ghostReady) {
        ghostReady = true

        if (ghostDir) {
          if (deps.ghost?.registerPanicKey?.(PANIC_KEY, () => void panic()) === false) {
            log(`[ghost] the panic key ${PANIC_KEY} could not be registered (another program holds it)`)
          }
        } else if (deps.ghost) {
          // Ghost folders nobody owns any more (the computer went off in the middle of one) are forgotten.
          const gone = sweepStale({ isAlive: deps.ghost.isAlive ?? pidAlive, tmpRoot: ghostTmp })

          if (gone.length > 0) {
            log(`[ghost] forgot ${gone.length} ghost folder(s) left behind`)
          }
        }
      }

      try {
        address = await bridge.start()
      } catch (error) {
        log(`[hermoso] the bridge did not start: ${error instanceof Error ? error.message : String(error)}`)
      }

      const installed = await installer.prepare(hermesHome)

      // Only a home that really has the plugin is told where the app is.
      if (address && installed) {
        try {
          writeBridgeFile(hermesHome, address)
          published.add(hermesHome)
        } catch (error) {
          log(
            `[hermoso] could not tell the plugin where the app is: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    },

    /** At launch, before the VPN gate connects anything: a trip left open by a crash is brought home. */
    recover: (): Promise<void> => teleport.recover(),

    shield: {
      check: () => shield.check(),
      ledger,
      latest: (): null | RadarSample => latestSample,
      look: lookAtTheMachine
    },

    teleport
  }
}

export type Hermoso = ReturnType<typeof createHermoso>
