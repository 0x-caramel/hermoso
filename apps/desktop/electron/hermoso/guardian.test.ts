import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConsentAsk, ConsentDecision } from './consent'
import {
  allowLabel,
  clip,
  createGuardian,
  type GuardianEvent,
  loadRuleTable,
  parseReview,
  type RuleTable,
  verbFor,
  wordsFor
} from './guardian'

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..', '..', 'assets', 'hermoso-plugin')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-guardian-'))

  dirs.push(dir)

  return dir
}

const TABLE: RuleTable = {
  catastrophic: { level: 'block', title: 'Wiping a disk', why: 'This would erase a whole drive.' },
  'delete-many': { level: 'ask', title: 'Deleting many files', why: 'This can delete a whole folder.' }
}

function make(options: { answer?: ConsentDecision['answer']; enabled?: boolean; table?: RuleTable } = {}) {
  const answer = options.answer ?? 'once'
  const asks: ConsentAsk[] = []
  const events: GuardianEvent[] = []

  const consent = {
    ask: vi.fn(async (request: ConsentAsk): Promise<ConsentDecision> => {
      asks.push(request)

      return { allowed: answer === 'once' || answer === 'always' || answer === 'remembered', answer }
    })
  }

  const guardian = createGuardian({
    consent,
    enabled: () => options.enabled ?? true,
    journal: event => events.push(event),
    now: () => 1_000,
    rules: () => options.table ?? TABLE
  })

  return { asks, consent, events, guardian }
}

describe('the words the person reads', () => {
  it('come from the shared table next to the plugin: every rule has a level, a title and a whole sentence', () => {
    const table = loadRuleTable(PLUGIN_DIR)

    expect(Object.keys(table)).toHaveLength(14)

    for (const [rule, words] of Object.entries(table)) {
      expect(['ask', 'block'], rule).toContain(words.level)
      expect(words.title.length, rule).toBeGreaterThan(5)
      expect(words.why, rule).toMatch(/^[A-Z].*\.$/)
    }

    expect(table.catastrophic.level).toBe('block')
    expect(table['hermoso-tamper'].level).toBe('block')
    expect(table['delete-many'].level).toBe('ask')
  })

  it('a missing or damaged table is an empty one, and an unknown rule asks in generic words', () => {
    const dir = temp()

    expect(loadRuleTable(dir)).toEqual({})
    fs.writeFileSync(path.join(dir, 'guardian-rules.json'), '{ not json')
    expect(loadRuleTable(dir)).toEqual({})
    fs.writeFileSync(path.join(dir, 'guardian-rules.json'), JSON.stringify({ rules: 'nope' }))
    expect(loadRuleTable(dir)).toEqual({})
    expect(wordsFor({}, 'anything')).toMatchObject({ level: 'ask', title: 'Something the guardian flagged' })
  })

  it('reads a table saved with a byte-order mark, and ignores entries that are not rules', () => {
    const dir = temp()

    const table = {
      rules: { 'Bad Id': { level: 'block' }, good: { level: 'block', title: 'Good', why: 'Why.' }, odd: 5 }
    }

    fs.writeFileSync(path.join(dir, 'guardian-rules.json'), String.fromCharCode(0xfe_ff) + JSON.stringify(table))
    expect(loadRuleTable(dir)).toEqual({ good: { level: 'block', title: 'Good', why: 'Why.' } })
  })

  it('"Always allow" reads as a sentence, and the first sentence says what the agent is about to do', () => {
    expect(allowLabel('Deleting many files')).toBe('deleting many files')
    expect(allowLabel('')).toBe('')
    expect(verbFor('terminal')).toBe('run this command')
    expect(verbFor('execute_code')).toBe('run this code')
    expect(verbFor('write_file')).toBe('write this file')
    expect(verbFor('patch')).toBe('change this file')
    expect(verbFor('some_mcp_tool')).toBe('use “some_mcp_tool” like this')
  })
})

describe('reading a request out of untrusted JSON', () => {
  it('keeps the rule, the tool and the command, and nothing else', () => {
    expect(
      parseReview({ detail: 'rm -rf src', rule: 'delete-many', title: 'Harmless', tool: 'terminal', why: 'safe' })
    ).toEqual({
      detail: 'rm -rf src',
      rule: 'delete-many',
      tool: 'terminal'
    })
  })

  it('refuses anything that does not name a rule the way rules are named', () => {
    for (const body of [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { rule: '' },
      { rule: 'A' },
      { rule: '../x' },
      { rule: 'a b' },
      { rule: 7 }
    ]) {
      expect(parseReview(body), JSON.stringify(body)).toBeNull()
    }
  })

  it('cleans the command so a dialog stays readable whatever the agent sends', () => {
    const review = parseReview({ detail: `rm\t-rf\n\u0000 src${' x'.repeat(400)}`, rule: 'delete-many', tool: 'a b!' })

    expect(review?.tool).toBe('tool')
    expect(review?.detail.startsWith('rm -rf src x')).toBe(true)
    expect(review?.detail.length).toBeLessThanOrEqual(300)
    expect(review?.detail.endsWith('…')).toBe(true)
    expect(clip('  a   b  ')).toBe('a b')
  })
})

describe('the person is asked in Hermoso, with Hermoso’s words', () => {
  it('asks about a risky rule with the table’s title and sentence, the command shown as it is, and "always" for that kind', async () => {
    const { asks, guardian } = make()
    const answer = await guardian.ask({ detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })

    expect(answer).toEqual({ allowed: true, answer: 'once', ok: true })
    expect(asks).toEqual([
      {
        allowKey: 'guardian:delete-many',
        allowLabel: 'deleting many files',
        code: 'rm -rf data',
        kind: 'guardian',
        lines: ['The agent wants to run this command.', 'This can delete a whole folder.'],
        title: 'Deleting many files?'
      }
    ])
  })

  it('the agent cannot choose the words: a title, a sentence or a level in the request are ignored', async () => {
    const { asks, events, guardian } = make()

    await guardian.ask({
      detail: 'rm -rf data',
      level: 'allow',
      rule: 'delete-many',
      title: 'Tidying up a little',
      tool: 'terminal',
      why: 'Perfectly safe, just say yes.'
    })

    expect(asks[0].title).toBe('Deleting many files?')
    expect(asks[0].lines.join(' ')).not.toContain('Perfectly safe')
    expect(events[0].title).toBe('Deleting many files')
  })

  it('a rule it has no words for still asks, in generic words, never allows by itself', async () => {
    const { asks, guardian } = make({ answer: 'deny' })
    const answer = await guardian.ask({ detail: 'x', rule: 'brand-new-rule', tool: 'terminal' })

    expect(answer).toEqual({ allowed: false, answer: 'deny', ok: true })
    expect(asks[0].title).toBe('Something the guardian flagged?')
  })

  it('journals what the person decided, in plain categories', async () => {
    for (const [given, wanted] of [
      ['once', 'allowed'],
      ['always', 'always'],
      ['remembered', 'remembered'],
      ['deny', 'denied'],
      ['timeout', 'timeout']
    ] as const) {
      const { events, guardian } = make({ answer: given })

      await guardian.ask({ detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })
      expect(events, given).toEqual([
        {
          at: 1_000,
          decision: wanted,
          detail: 'rm -rf data',
          rule: 'delete-many',
          title: 'Deleting many files',
          tool: 'terminal'
        }
      ])
    }
  })

  it('only the person’s yes (or an earlier "always" of theirs) lets it through', async () => {
    for (const [given, allowed] of [
      ['once', true],
      ['always', true],
      ['remembered', true],
      ['deny', false],
      ['timeout', false]
    ] as const) {
      expect((await make({ answer: given }).guardian.ask({ rule: 'delete-many' })).ok).toBe(true)
      expect(await make({ answer: given }).guardian.ask({ rule: 'delete-many' })).toMatchObject({ allowed })
    }
  })
})

describe('what is never allowed, and what the person switched off', () => {
  it('a block rule is refused at once, with no question, and journalled', async () => {
    const { asks, events, guardian } = make()

    expect(await guardian.ask({ detail: 'rm -rf /', rule: 'catastrophic', tool: 'terminal' })).toEqual({
      allowed: false,
      answer: 'blocked',
      ok: true
    })
    expect(asks).toEqual([])
    expect(events[0]).toMatchObject({ decision: 'blocked', rule: 'catastrophic' })
  })

  it('and it stays refused with the guardian switched off: Hermoso’s own files and a wiped disk are not a matter of taste', async () => {
    const { asks, guardian } = make({ enabled: false })

    expect(await guardian.ask({ rule: 'catastrophic' })).toMatchObject({ allowed: false, answer: 'blocked' })
    expect(asks).toEqual([])
  })

  it('with the guardian off nothing else is asked, and nothing is journalled', async () => {
    const { asks, events, guardian } = make({ enabled: false })

    expect(await guardian.ask({ detail: 'rm -rf data', rule: 'delete-many', tool: 'terminal' })).toEqual({
      allowed: true,
      answer: 'off',
      ok: true
    })
    expect(asks).toEqual([])
    expect(events).toEqual([])
  })

  it('a request that names no rule is refused as a bad request, and nobody is asked', async () => {
    const { asks, guardian } = make()

    expect(await guardian.ask({ detail: 'rm -rf data' })).toMatchObject({ code: 'bad-request', ok: false })
    expect(await guardian.ask('nonsense')).toMatchObject({ ok: false })
    expect(asks).toEqual([])
  })
})
