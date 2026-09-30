/**
 * Egress gate (main process, Electron-free core).
 *
 * The VPN gate (vpn-controller.ts) holds the agent backend until the Mullvad
 * tunnel is up, but the app's own shell talks to the network too: the renderer
 * loads theme fonts from Google the moment it mounts, the update poller asks
 * GitHub, link previews fetch pages. Left alone those leave the machine outside
 * the tunnel during the seconds the gate is holding the start — which would make
 * "nothing goes out unprotected" false.
 *
 * So while the startup gate is closed, every request of the app's own Chromium
 * network stack that is not bound for this machine is *held* (not failed) and
 * released the moment the gate opens. `session.webRequest.onBeforeRequest` sees
 * all of it: renderer subresources, fetch/XHR, WebSockets, and the main process's
 * `net.fetch` / `net.request` on any session. What it cannot see is Node's own
 * `http` / `https` and child processes; those call sites wait on the gate
 * explicitly (see main.ts → `waitForStartupGate`).
 *
 * The hook exists only while the gate is closed. On release the listeners are
 * removed (or replaced by the session's own handler), so a launch that never
 * needed the gate — VPN off, or not required — installs nothing, and a released
 * one pays no per-request cost afterwards.
 */

type Respond = (response: { cancel?: boolean }) => void
interface RequestDetails {
  resourceType?: string
  url: string
}
type BeforeRequestListener = (details: RequestDetails, callback: Respond) => void

/** The slice of `Electron.Session` the gate touches. */
export interface SessionLike {
  webRequest: { onBeforeRequest(listener: BeforeRequestListener | null): void }
}

export interface EgressGateOptions {
  isReleased: () => boolean
  log?: (message: string) => void
  whenReleased: () => Promise<void>
}

const NETWORK_PROTOCOLS = new Set(['ftp:', 'http:', 'https:', 'ws:', 'wss:'])
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * True for requests that never leave this machine: every non-network scheme
 * (`file:`, `data:`, `blob:`, `devtools:`, the app's own protocols) and network
 * schemes aimed at loopback (the local backend, the dev server).
 */
export function isLocalRequestUrl(rawUrl: string): boolean {
  let url: URL

  try {
    url = new URL(rawUrl)
  } catch {
    // Not something Chromium can put on the wire either.
    return true
  }

  if (!NETWORK_PROTOCOLS.has(url.protocol)) {
    return true
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    IPV4_LOOPBACK.test(host)
  )
}

export function createEgressGate({ isReleased, log, whenReleased }: EgressGateOptions) {
  // Sessions we hold a listener on, with the session's own handler (if it has one) to
  // fall back to once the gate opens.
  const owned = new Map<SessionLike, BeforeRequestListener | null>()
  let held = 0

  const pass = (inner: BeforeRequestListener | null, details: RequestDetails, respond: Respond) => {
    if (inner) {
      inner(details, respond)
    } else {
      respond({})
    }
  }

  const listenerFor =
    (inner: BeforeRequestListener | null): BeforeRequestListener =>
    (details, respond) => {
      if (isReleased() || isLocalRequestUrl(details.url)) {
        pass(inner, details, respond)

        return
      }

      held += 1

      void whenReleased().then(() => {
        held -= 1
        pass(inner, details, respond)
      })
    }

  return {
    /**
     * Guard a session. `inner` is the session's own `onBeforeRequest` handler, if
     * it has one (it keeps running, behind the gate); a session must be attached
     * through here rather than setting its own listener, or one would replace the other.
     */
    attach(ses: SessionLike, inner: BeforeRequestListener | null = null): void {
      if (isReleased()) {
        if (inner) {
          ses.webRequest.onBeforeRequest(inner)
        }

        return
      }

      owned.set(ses, inner)
      ses.webRequest.onBeforeRequest(listenerFor(inner))
    },

    heldCount: (): number => held,

    /** The gate opened: hand every session back to its own handler. Held requests are flushed by `whenReleased`. */
    release(): void {
      if (held > 0) {
        log?.(`[egress] gate open: releasing ${held} held request(s)`)
      }

      for (const [ses, inner] of owned) {
        ses.webRequest.onBeforeRequest(inner)
      }

      owned.clear()
    }
  }
}

export type EgressGate = ReturnType<typeof createEgressGate>
