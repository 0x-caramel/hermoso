import { describe, expect, it, vi } from 'vitest'

import { createEgressGate, isLocalRequestUrl, type SessionLike } from './egress-gate'

type Listener = Parameters<SessionLike['webRequest']['onBeforeRequest']>[0]

function fakeSession() {
  let listener: Listener = null

  const ses: SessionLike = {
    webRequest: {
      onBeforeRequest: vi.fn((next: Listener) => {
        listener = next
      })
    }
  }

  /** Fire a request at whatever listener is installed; resolves with the response when it is answered. */
  const request = (url: string) =>
    new Promise<{ cancel?: boolean } | 'no-listener'>(resolve => {
      if (!listener) {
        resolve('no-listener')

        return
      }

      listener({ url }, response => resolve(response))
    })

  return { listener: () => listener, request, ses }
}

function controlledGate(initiallyReleased = false) {
  let released = initiallyReleased
  const waiters: (() => void)[] = []
  const log = vi.fn()

  const gate = createEgressGate({
    isReleased: () => released,
    log,
    whenReleased: () => (released ? Promise.resolve() : new Promise<void>(resolve => waiters.push(resolve)))
  })

  return {
    gate,
    log,
    open: () => {
      released = true
      // main wires release() first, then held requests are flushed — same order here.
      gate.release()

      for (const resolve of waiters.splice(0)) {
        resolve()
      }
    }
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('isLocalRequestUrl', () => {
  it('treats everything that never leaves the machine as local', () => {
    for (const url of [
      'file:///C:/app/index.html',
      'data:text/html,<p>x</p>',
      'blob:https://x.test/abc',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'hermes-media://file/a.png',
      'http://127.0.0.1:9119/api/status',
      'ws://127.0.0.1:55012/api/ws?token=a',
      'http://localhost:5174/',
      'http://app.localhost:3000/',
      'http://[::1]:8080/',
      'http://127.12.0.3/'
    ]) {
      expect(isLocalRequestUrl(url), url).toBe(true)
    }
  })

  it('treats everything bound for the network as external', () => {
    for (const url of [
      'https://fonts.googleapis.com/css2?family=Courier+Prime',
      'https://fonts.gstatic.com/s/x.woff2',
      'http://example.com/',
      'wss://gateway.example.com/api/ws',
      'https://api.github.com/repos/NousResearch/hermes-agent/commits/main',
      'http://192.168.1.20:9119/',
      'http://100.64.0.1:9119/',
      'http://127.0.0.1.evil.test/',
      'https://localhost.evil.test/'
    ]) {
      expect(isLocalRequestUrl(url), url).toBe(false)
    }
  })

  it('does not hold what it cannot parse', () => {
    expect(isLocalRequestUrl('not a url')).toBe(true)
  })
})

describe('createEgressGate', () => {
  it('holds external requests until the gate opens, then lets them through', async () => {
    const { gate, open } = controlledGate()
    const { request, ses } = fakeSession()

    gate.attach(ses)

    const font = request('https://fonts.googleapis.com/css2?family=Courier+Prime')
    const settled = vi.fn()
    void font.then(settled)

    await tick()
    expect(settled).not.toHaveBeenCalled()
    expect(gate.heldCount()).toBe(1)

    open()

    await expect(font).resolves.toEqual({})
    expect(gate.heldCount()).toBe(0)
  })

  it('never delays a request that stays on this machine', async () => {
    const { gate } = controlledGate()
    const { request, ses } = fakeSession()

    gate.attach(ses)

    await expect(request('http://127.0.0.1:9119/api/status')).resolves.toEqual({})
    await expect(request('ws://localhost:5174/')).resolves.toEqual({})
    await expect(request('file:///app/index.html')).resolves.toEqual({})
    expect(gate.heldCount()).toBe(0)
  })

  it('holds many requests and releases them all, in a single log line', async () => {
    const { gate, log, open } = controlledGate()
    const { request, ses } = fakeSession()

    gate.attach(ses)

    const pending = [
      request('https://fonts.googleapis.com/a'),
      request('https://fonts.gstatic.com/b'),
      request('wss://remote.example.com/ws')
    ]

    expect(gate.heldCount()).toBe(3)
    open()

    await expect(Promise.all(pending)).resolves.toEqual([{}, {}, {}])
    expect(log).toHaveBeenCalledWith('[egress] gate open: releasing 3 held request(s)')
  })

  it('removes its listener once the gate is open, so nothing is paid per request afterwards', () => {
    const { gate, open } = controlledGate()
    const { listener, ses } = fakeSession()

    gate.attach(ses)
    expect(listener()).not.toBeNull()

    open()
    expect(listener()).toBeNull()
  })

  it('installs nothing at all when the gate was never closed', () => {
    const { gate } = controlledGate(true)
    const { ses } = fakeSession()

    gate.attach(ses)

    expect(ses.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  it('keeps a session’s own handler running behind the gate, and hands it back on release', async () => {
    const { gate, open } = controlledGate()
    const { listener, request, ses } = fakeSession()

    const own = vi.fn((details: { url: string }, respond: (r: { cancel?: boolean }) => void) =>
      respond({ cancel: details.url.endsWith('.png') })
    )

    gate.attach(ses, own)

    // Local traffic goes straight to the session's own handler.
    await expect(request('http://127.0.0.1/pic.png')).resolves.toEqual({ cancel: true })
    expect(own).toHaveBeenCalledTimes(1)

    // External traffic waits, and the session's handler still decides it afterwards.
    const held = request('https://example.com/pic.png')
    expect(own).toHaveBeenCalledTimes(1)

    open()

    await expect(held).resolves.toEqual({ cancel: true })
    expect(listener()).toBe(own)
  })

  it('guards a session attached later, and leaves one created after release alone', async () => {
    const { gate, open } = controlledGate()
    const early = fakeSession()
    const late = fakeSession()

    gate.attach(early.ses)
    gate.attach(late.ses)

    const a = early.request('https://a.test/')
    const b = late.request('https://b.test/')

    open()
    await Promise.all([a, b])

    const afterwards = fakeSession()
    gate.attach(afterwards.ses)

    expect(afterwards.ses.webRequest.onBeforeRequest).not.toHaveBeenCalled()
  })

  it('re-attaching a session with its own handler replaces the bare guard, not stacks on it', async () => {
    const { gate, open } = controlledGate()
    const { listener, request, ses } = fakeSession()

    const own = vi.fn((_details: { url: string }, respond: (r: { cancel?: boolean }) => void) =>
      respond({ cancel: true })
    )

    gate.attach(ses) // e.g. from `session-created`
    gate.attach(ses, own) // the owner then registers its handler through the gate

    const held = request('https://example.com/x')
    open()

    await expect(held).resolves.toEqual({ cancel: true })
    expect(listener()).toBe(own)
  })
})
