/**
 * Guardian (main process, Electron-free): the person's side of the guardian.
 *
 * The agent's plugin recognises a risky tool call (deleting a folder, rewriting git history, running what was
 * downloaded, reading keys, switching the VPN off, writing where programs start by themselves...) and asks here
 * BEFORE the tool runs. This module is where the person stands:
 *
 *   - what the person reads is in `guardian-rules.json` (shared with the plugin), never what the request says: the
 *     agent can name a rule, it cannot choose the words, the title or the "always allow" label;
 *   - a "block" rule is refused with no question (the agent has no reason to wipe a drive or to edit the file that
 *     holds the person's own answers), whether the guardian is switched on or off;
 *   - everything else is asked in Hermoso's own consent window: allow once, always allow this kind, deny; no answer is
 *     a no; "always" is remembered per rule and can be taken back on the Hermoso page;
 *   - with the guardian switched off nothing is asked;
 *   - what was decided is journalled, so the person can see what the guardian did.
 *
 * It decides nothing by itself: a yes is always the person's, or an earlier "always" of theirs.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Consent } from './consent'

export type GuardianLevel = 'ask' | 'block'

export interface RuleWords {
  level: GuardianLevel
  /** A gerund phrase: it becomes the dialog's title and "Always allow <title>". */
  title: string
  /** A whole sentence about the danger. */
  why: string
}

export type RuleTable = Record<string, RuleWords>

export type GuardianDecision = 'allowed' | 'always' | 'blocked' | 'denied' | 'remembered' | 'timeout'

export interface GuardianEvent {
  at: number
  decision: GuardianDecision
  /** The command or path, as the agent gave it (clipped). */
  detail: string
  rule: string
  title: string
  tool: string
}

export interface Review {
  detail: string
  rule: string
  tool: string
}

export type GuardianAnswer =
  { allowed: boolean; answer: string; ok: true } | { code: string; message: string; ok: false }

const RULE_ID = /^[a-z][a-z0-9-]{1,40}$/
const TOOL_ID = /^[\w.:-]{1,60}$/
const DETAIL_LIMIT = 300

const GENERIC: RuleWords = {
  level: 'ask',
  title: 'Something the guardian flagged',
  why: 'It looks risky.'
}

/** One line of plain text, never longer than `limit` (a dialog must stay readable, whatever the agent sends). */
export function clip(text: string, limit = DETAIL_LIMIT): string {
  const flat = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`
}

/** The words, from the table next to the plugin. A missing or damaged file is an empty table: every rule then asks. */
export function loadRuleTable(pluginDir: string): RuleTable {
  try {
    const text = fs.readFileSync(path.join(pluginDir, 'guardian-rules.json'), 'utf8')
    // a file saved with a byte-order mark is still the same file
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text)
    const out: RuleTable = {}

    for (const [rule, value] of Object.entries((parsed?.rules ?? {}) as Record<string, any>)) {
      if (RULE_ID.test(rule) && value && typeof value === 'object') {
        out[rule] = {
          level: value.level === 'block' ? 'block' : 'ask',
          title: typeof value.title === 'string' && value.title.trim() ? clip(value.title, 80) : rule,
          why: typeof value.why === 'string' ? clip(value.why, 220) : GENERIC.why
        }
      }
    }

    return out
  } catch {
    return {}
  }
}

export function wordsFor(table: RuleTable, rule: string): RuleWords {
  return table[rule] ?? GENERIC
}

/** A request out of untrusted JSON (the plugin's, through the bridge): only what is safe to show is kept. */
export function parseReview(raw: unknown): null | Review {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rule = typeof body.rule === 'string' ? body.rule.trim() : ''

  if (!RULE_ID.test(rule)) {
    return null
  }

  const tool = typeof body.tool === 'string' && TOOL_ID.test(body.tool.trim()) ? body.tool.trim() : 'tool'

  return { detail: typeof body.detail === 'string' ? clip(body.detail) : '', rule, tool }
}

/** What the agent is about to do, in the dialog's first sentence. */
export function verbFor(tool: string): string {
  switch (tool) {
    case 'terminal':
      return 'run this command'

    case 'execute_code':
      return 'run this code'

    case 'write_file':
      return 'write this file'

    case 'patch':
      return 'change this file'

    default:
      return `use “${tool}” like this`
  }
}

/** "Writing into system folders" → "writing into system folders", for "Always allow …". */
export function allowLabel(title: string): string {
  return title ? title[0].toLowerCase() + title.slice(1) : title
}

export interface GuardianDeps {
  consent: Pick<Consent, 'ask'>
  /** Whether the person has the guardian on. A "block" rule is enforced either way. */
  enabled: () => boolean
  journal: (event: GuardianEvent) => void
  now?: () => number
  rules: () => RuleTable
}

export function createGuardian(deps: GuardianDeps) {
  const now = deps.now ?? Date.now

  return {
    async ask(raw: unknown): Promise<GuardianAnswer> {
      const review = parseReview(raw)

      if (!review) {
        return { code: 'bad-request', message: 'a review needs the id of a rule', ok: false }
      }

      const words = wordsFor(deps.rules(), review.rule)
      const base = { at: now(), detail: review.detail, rule: review.rule, title: words.title, tool: review.tool }

      if (words.level === 'block') {
        deps.journal({ ...base, decision: 'blocked' })

        return { allowed: false, answer: 'blocked', ok: true }
      }

      if (!deps.enabled()) {
        return { allowed: true, answer: 'off', ok: true }
      }

      const decision = await deps.consent.ask({
        allowKey: `guardian:${review.rule}`,
        allowLabel: allowLabel(words.title),
        code: review.detail || null,
        kind: 'guardian',
        lines: [`The agent wants to ${verbFor(review.tool)}.`, words.why],
        title: `${words.title}?`
      })

      const outcome: GuardianDecision =
        decision.answer === 'once'
          ? 'allowed'
          : decision.answer === 'always' || decision.answer === 'remembered' || decision.answer === 'timeout'
            ? decision.answer
            : 'denied'

      deps.journal({ ...base, decision: outcome })

      return { allowed: decision.allowed, answer: decision.answer, ok: true }
    }
  }
}

export type Guardian = ReturnType<typeof createGuardian>
