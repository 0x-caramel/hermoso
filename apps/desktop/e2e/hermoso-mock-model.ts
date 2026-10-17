/**
 * A scripted OpenAI-compatible model for the Hermoso e2e: it answers like an agent that decides to teleport.
 *
 * Only the pieces `hermes serve` needs: GET /v1/models and POST /v1/chat/completions (streaming and not). The
 * script is chosen by a keyword in the person's last message, and the step by how many tool results the
 * conversation already holds, so it is stateless and deterministic whatever Hermes retries:
 *
 *   E2E_TELEPORT_YES   hermoso_teleport (Germany) → hermoso_return_home → a closing sentence
 *   E2E_TELEPORT_NO    hermoso_teleport (France)  → a closing sentence that says the person refused
 *
 * Hermes defers a plugin's tools behind `tool_search` / `tool_call` and lists them by name in the `tool_search`
 * description. The mock behaves like a model that reads that list: it calls the tool through `tool_call` (or
 * directly, if the backend offers it directly).
 *
 * A request that neither offers `hermoso_teleport` nor lists it (the plugin did not load, or its tools were
 * hidden) is answered with plain text naming the problem, so the spec fails with a reason instead of a timeout.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const TELEPORT_YES = 'E2E_TELEPORT_YES'
export const TELEPORT_NO = 'E2E_TELEPORT_NO'
export const YES_DONE = 'Teleport round trip complete.'
export const NO_DONE = 'The person refused the teleport.'
export const TOOLS_MISSING = 'HERMOSO TOOLS MISSING: hermoso_teleport was neither offered nor listed for the model.'

interface Turn {
  text?: string
  tool?: { args: Record<string, unknown>; name: string }
}

const SCRIPTS: Record<string, Turn[]> = {
  [TELEPORT_NO]: [
    {
      tool: {
        args: { country: 'France', minutes: 5, reason: 'e2e: this one will be refused' },
        name: 'hermoso_teleport'
      }
    },
    { text: NO_DONE }
  ],
  [TELEPORT_YES]: [
    { tool: { args: { country: 'Germany', minutes: 5, reason: 'e2e: compare prices' }, name: 'hermoso_teleport' } },
    { tool: { args: {}, name: 'hermoso_return_home' } },
    { text: YES_DONE }
  ]
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map(part => (typeof part === 'string' ? part : String((part as { text?: unknown }).text ?? '')))
          .join('\n')
      : ''

const chunk = (delta: Record<string, unknown>, finish: null | string = null) =>
  `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finish, index: 0 }],
    created: 0,
    id: 'hermoso-mock',
    model: 'mock-model',
    object: 'chat.completion.chunk'
  })}\n\n`

export interface HermosoMock {
  close: () => Promise<void>
  /** The tool names each request offered to the model, in order (what the backend let the agent use). */
  offered: string[][]
  /** Whether each request could reach `hermoso_teleport`: offered directly, or listed in the `tool_search` catalog. */
  reachable: boolean[]
  /** The tool results the model has seen, in order (what the agent got back from Hermoso). */
  toolResults: string[]
  url: string
}

export async function startHermosoMock(): Promise<HermosoMock> {
  const toolResults: string[] = []
  const offeredLog: string[][] = []
  const reachableLog: boolean[] = []

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []

    request.on('data', piece => chunks.push(piece))
    request.on('end', () => {
      const url = request.url ?? ''

      if (request.method === 'GET' && url.startsWith('/v1/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }], object: 'list' }))

        return
      }

      if (request.method !== 'POST' || !url.startsWith('/v1/chat/completions')) {
        response.writeHead(404).end()

        return
      }

      let body: any = {}

      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        // an empty or odd body is answered like a plain request
      }

      const messages: any[] = Array.isArray(body.messages) ? body.messages : []
      const lastUser = messages.map(message => message.role).lastIndexOf('user')
      const prompt = lastUser >= 0 ? textOf(messages[lastUser].content) : ''
      const results = messages.slice(lastUser + 1).filter(message => message.role === 'tool')
      const script = Object.entries(SCRIPTS).find(([keyword]) => prompt.includes(keyword))?.[1]
      const tools: any[] = Array.isArray(body.tools) ? body.tools : []
      const offered: string[] = tools.map(tool => tool?.function?.name)
      const catalog = String(tools.find(tool => tool?.function?.name === 'tool_search')?.function?.description ?? '')
      const reachable =
        offered.includes('hermoso_teleport') || (offered.includes('tool_call') && catalog.includes('hermoso_teleport'))

      offeredLog.push(offered)
      reachableLog.push(reachable)

      results.forEach(result => {
        const text = textOf(result.content)

        if (!toolResults.includes(text)) {
          toolResults.push(text)
        }
      })

      let turn: Turn = { text: 'ok' }

      if (script) {
        turn = !reachable ? { text: TOOLS_MISSING } : (script[results.length] ?? { text: 'done' })
      }

      // A tool the backend defers is called through the bridge, the way a model that read the catalog calls it.
      const direct = turn.tool ? offered.includes(turn.tool.name) : true

      const call = turn.tool
        ? [
            {
              function: direct
                ? { arguments: JSON.stringify(turn.tool.args), name: turn.tool.name }
                : {
                    arguments: JSON.stringify({ calls: [{ arguments: turn.tool.args, name: turn.tool.name }] }),
                    name: 'tool_call'
                  },
              id: `call_hermoso_${results.length}`,
              index: 0,
              type: 'function'
            }
          ]
        : null

      if (body.stream) {
        response.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream' })

        if (turn.text) {
          response.write(chunk({ content: turn.text }))
        }

        response.write(call ? chunk({ tool_calls: call }, 'tool_calls') : chunk({}, 'stop'))
        response.write('data: [DONE]\n\n')
        response.end()

        return
      }

      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: call ? 'tool_calls' : 'stop',
              index: 0,
              message: { content: turn.text ?? null, role: 'assistant', ...(call ? { tool_calls: call } : {}) }
            }
          ],
          created: 0,
          id: 'hermoso-mock',
          model: 'mock-model',
          object: 'chat.completion',
          usage: { completion_tokens: 20, prompt_tokens: 10, total_tokens: 30 }
        })
      )
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const { port } = server.address() as AddressInfo

  return {
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    offered: offeredLog,
    reachable: reachableLog,
    toolResults,
    url: `http://127.0.0.1:${port}`
  }
}
