import http from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { createBridge } from './bridge'

interface Reply {
  body: any
  status: number
}

function call(
  port: number,
  options: { body?: string; headers?: Record<string, string>; host?: string; method?: string; path: string }
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers: { ...(options.host ? { Host: options.host } : {}), ...options.headers },
        host: '127.0.0.1',
        method: options.method ?? 'GET',
        path: options.path,
        port
      },
      response => {
        const chunks: Buffer[] = []

        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')

          resolve({ body: text ? JSON.parse(text) : null, status: response.statusCode ?? 0 })
        })
      }
    )

    request.on('error', reject)
    request.end(options.body)
  })
}

const open: { stop: () => Promise<void> }[] = []

async function started() {
  const bridge = createBridge({ token: 'secret-token' })

  bridge.route('GET', '/v1/ping', ({ query }) => ({ ok: true, pong: query.get('x') ?? null }))
  bridge.route('POST', '/v1/echo', ({ body }) => ({ echoed: body, ok: true }))

  bridge.route('POST', '/v1/boom', () => {
    throw new Error('secret internals: C:\\Users\\someone\\token.txt')
  })

  const info = await bridge.start()

  open.push(bridge)

  return { bridge, ...info }
}

const auth = { Authorization: 'Bearer secret-token' }
const json = { ...auth, 'Content-Type': 'application/json' }

afterEach(async () => {
  await Promise.all(open.splice(0).map(bridge => bridge.stop()))
})

describe('the bridge door', () => {
  it('listens on the loopback interface only, on a port the system picked', async () => {
    const { port, url } = await started()

    expect(port).toBeGreaterThan(0)
    expect(url).toBe(`http://127.0.0.1:${port}`)
  })

  it('hands a backend what it needs to find it, and nothing before it is started', async () => {
    const bridge = createBridge({ token: 't' })

    expect(bridge.env()).toEqual({})

    const info = await bridge.start()

    open.push(bridge)
    expect(bridge.env()).toEqual({ HERMOSO_BRIDGE_TOKEN: 't', HERMOSO_BRIDGE_URL: info.url })
  })

  it('makes a fresh 256-bit token each time', async () => {
    const a = createBridge()
    const b = createBridge()
    const [x, y] = [await a.start(), await b.start()]

    open.push(a, b)

    expect(x.token).toMatch(/^[0-9a-f]{64}$/)
    expect(x.token).not.toBe(y.token)
  })

  it('answers a route with JSON and no caching', async () => {
    const { port } = await started()

    expect(await call(port, { headers: auth, path: '/v1/ping?x=7' })).toEqual({
      body: { ok: true, pong: '7' },
      status: 200
    })

    expect(await call(port, { body: '{"a":1}', headers: json, method: 'POST', path: '/v1/echo' })).toEqual({
      body: { echoed: { a: 1 }, ok: true },
      status: 200
    })
  })

  it('treats a POST without a body as an empty object', async () => {
    const { port } = await started()

    expect((await call(port, { headers: json, method: 'POST', path: '/v1/echo' })).body).toEqual({
      echoed: {},
      ok: true
    })
  })
})

describe('who is refused', () => {
  it('a request with no token, a wrong token or a malformed header', async () => {
    const { port } = await started()

    for (const headers of [
      {},
      { Authorization: 'Bearer nope' },
      { Authorization: 'secret-token' },
      { Authorization: 'Bearer ' }
    ]) {
      expect(await call(port, { headers, path: '/v1/ping' })).toEqual({
        body: { code: 'unauthorized', ok: false },
        status: 401
      })
    }
  })

  it('anything that looks like a browser (an Origin header), even with the right token', async () => {
    const { port } = await started()

    expect((await call(port, { headers: { ...auth, Origin: 'http://evil.example' }, path: '/v1/ping' })).status).toBe(
      403
    )
    expect((await call(port, { headers: { ...auth, Origin: 'null' }, path: '/v1/ping' })).status).toBe(403)
  })

  it('a Host that is not the loopback address (DNS rebinding)', async () => {
    const { port } = await started()

    expect((await call(port, { headers: auth, host: 'rebind.example', path: '/v1/ping' })).status).toBe(403)
    expect((await call(port, { headers: auth, host: `rebind.example:${port}`, path: '/v1/ping' })).status).toBe(403)
    expect((await call(port, { headers: auth, host: `localhost:${port}`, path: '/v1/ping' })).status).toBe(200)
  })

  it('an unknown route, a known route with the wrong method', async () => {
    const { port } = await started()

    expect((await call(port, { headers: auth, path: '/v1/missing' })).status).toBe(404)
    expect((await call(port, { headers: json, method: 'POST', path: '/v1/ping' })).status).toBe(405)
    expect((await call(port, { headers: auth, method: 'DELETE', path: '/v1/ping' })).status).toBe(405)
  })

  it('a body that is not JSON, not an object, too large, or not declared as JSON', async () => {
    const { port } = await started()

    expect((await call(port, { body: '{oops', headers: json, method: 'POST', path: '/v1/echo' })).status).toBe(400)
    expect((await call(port, { body: '[1,2]', headers: json, method: 'POST', path: '/v1/echo' })).status).toBe(400)
    expect((await call(port, { body: '"text"', headers: json, method: 'POST', path: '/v1/echo' })).status).toBe(400)

    expect(
      (
        await call(port, {
          body: JSON.stringify({ x: 'a'.repeat(70_000) }),
          headers: json,
          method: 'POST',
          path: '/v1/echo'
        })
      ).status
    ).toBe(413)

    expect(
      (
        await call(port, {
          body: '{}',
          headers: { ...auth, 'Content-Type': 'text/plain' },
          method: 'POST',
          path: '/v1/echo'
        })
      ).status
    ).toBe(415)
  })
})

describe('when a handler fails', () => {
  it('the caller learns only that it failed, the log has the reason', async () => {
    const lines: string[] = []
    const bridge = createBridge({ log: line => lines.push(line), token: 'secret-token' })

    bridge.route('POST', '/v1/boom', () => {
      throw new Error('secret internals: C:\\Users\\someone\\token.txt')
    })

    const info = await bridge.start()

    open.push(bridge)

    const reply = await call(info.port, { headers: json, method: 'POST', path: '/v1/boom' })

    expect(reply).toEqual({ body: { code: 'internal-error', ok: false }, status: 500 })
    expect(JSON.stringify(reply)).not.toContain('secret internals')
    expect(lines.join('\n')).toContain('secret internals')
  })
})

describe('stopping', () => {
  it('closes the door, and stopping twice is fine', async () => {
    const { bridge, port } = await started()

    await bridge.stop()
    await bridge.stop()

    await expect(call(port, { headers: auth, path: '/v1/ping' })).rejects.toThrow()
    expect(bridge.env()).toEqual({})
  })
})
