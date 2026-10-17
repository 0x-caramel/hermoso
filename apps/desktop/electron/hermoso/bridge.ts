/**
 * The bridge between the agent and the app (main process, Electron-free).
 *
 * Hermoso's powers live in two places that cannot call each other directly: the Python plugin inside the
 * agent's backend (it sees every tool call and can ask the user) and this app (it owns the Mullvad tunnel,
 * the trip file and the window). The bridge is a small JSON API on the loopback interface that the plugin
 * calls; every feature registers its routes here instead of opening its own door.
 *
 * It is a door into a program that can change the user's network, so it is deliberately narrow:
 *
 *   - 127.0.0.1 only, on a port the system picks, for as long as the app runs;
 *   - every request needs `Authorization: Bearer <token>`, a fresh 256-bit secret handed only to the
 *     backends this app starts (through their environment); compared in constant time;
 *   - a browser can never reach it: a request with an `Origin` header is refused, the `Host` header must
 *     be the loopback address (no DNS rebinding), and the token cannot be set by a web page;
 *   - JSON in, JSON out, small bodies, known routes and methods only; errors never carry internals.
 *
 * Same-user processes that can read the backend's environment are outside this protection by design:
 * the operating system is the only real boundary between programs running as one user.
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type BridgeMethod = 'GET' | 'POST'

export interface BridgeRequest {
  /** Parsed JSON body (`{}` for a request without one). */
  body: Record<string, unknown>
  query: URLSearchParams
}

export type BridgeHandler = (request: BridgeRequest) => Promise<unknown> | unknown

export interface BridgeOptions {
  log?: (message: string) => void
  /** A token to use instead of a fresh one (tests). */
  token?: string
}

const MAX_BODY_BYTES = 64 * 1024

function json(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)

  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

const refuse = (response: http.ServerResponse, status: number, code: string): void =>
  json(response, status, { code, ok: false })

function sameToken(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()

  return crypto.timingSafeEqual(a, b)
}

async function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    size += (chunk as Buffer).length

    if (size > MAX_BODY_BYTES) {
      return null
    }

    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
}

export function createBridge(options: BridgeOptions = {}) {
  const log = options.log ?? (() => {})
  const token = options.token ?? crypto.randomBytes(32).toString('hex')
  const routes = new Map<string, BridgeHandler>()
  let server: http.Server | null = null
  let port = 0

  const key = (method: string, route: string) => `${method} ${route}`

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // A browser always sends Origin on a cross-site request; this door is not for browsers.
    if (request.headers.origin !== undefined) {
      return refuse(response, 403, 'forbidden')
    }

    const host = String(request.headers.host ?? '').toLowerCase()

    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return refuse(response, 403, 'forbidden')
    }

    const header = String(request.headers.authorization ?? '')
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

    if (!given || !sameToken(given, token)) {
      return refuse(response, 401, 'unauthorized')
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    const method = String(request.method ?? 'GET').toUpperCase()
    const handler = routes.get(key(method, url.pathname))

    if (!handler) {
      const known = [...routes.keys()].some(entry => entry.endsWith(` ${url.pathname}`))

      return refuse(response, known ? 405 : 404, known ? 'method-not-allowed' : 'not-found')
    }

    let body: Record<string, unknown> = {}

    if (method === 'POST') {
      if (
        !String(request.headers['content-type'] ?? '')
          .toLowerCase()
          .startsWith('application/json')
      ) {
        return refuse(response, 415, 'unsupported-media-type')
      }

      const raw = await readBody(request)

      if (raw === null) {
        return refuse(response, 413, 'too-large')
      }

      try {
        const parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {}

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return refuse(response, 400, 'bad-request')
        }

        body = parsed as Record<string, unknown>
      } catch {
        return refuse(response, 400, 'bad-request')
      }
    }

    try {
      json(response, 200, await handler({ body, query: url.searchParams }))
    } catch (error) {
      // The details go to the log; the caller learns only that it failed.
      log(
        `[hermoso-bridge] ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`
      )
      refuse(response, 500, 'internal-error')
    }
  }

  return {
    /** Register a route. Routes are added before or after `start`; the last registration of a route wins. */
    route(method: BridgeMethod, route: string, handler: BridgeHandler): void {
      routes.set(key(method, route), handler)
    },

    async start(): Promise<{ port: number; token: string; url: string }> {
      if (server) {
        return { port, token, url: `http://127.0.0.1:${port}` }
      }

      const created = http.createServer((request, response) => {
        void handle(request, response).catch(error => {
          log(`[hermoso-bridge] unhandled: ${error instanceof Error ? error.message : String(error)}`)

          if (!response.headersSent) {
            refuse(response, 500, 'internal-error')
          }
        })
      })

      created.keepAliveTimeout = 5_000
      created.requestTimeout = 120_000

      await new Promise<void>((resolve, reject) => {
        created.once('error', reject)
        created.listen(0, '127.0.0.1', () => {
          created.off('error', reject)
          resolve()
        })
      })

      server = created
      port = (created.address() as AddressInfo).port
      log(`[hermoso-bridge] listening on 127.0.0.1:${port}`)

      return { port, token, url: `http://127.0.0.1:${port}` }
    },

    /** The environment a backend needs to find the bridge; empty until `start` has run. */
    env(): Record<string, string> {
      return server ? { HERMOSO_BRIDGE_TOKEN: token, HERMOSO_BRIDGE_URL: `http://127.0.0.1:${port}` } : {}
    },

    async stop(): Promise<void> {
      const current = server

      server = null

      if (!current) {
        return
      }

      current.closeAllConnections?.()
      await new Promise<void>(resolve => current.close(() => resolve()))
    }
  }
}

export type Bridge = ReturnType<typeof createBridge>
