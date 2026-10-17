/**
 * Aura (main process, Electron-free): the brother's glow, for fun.
 *
 * It counts what Hermoso has done for the person (the agent stopped when the VPN dropped, a risky thing refused or put
 * to a person, a rewind, a ghost, a trip with a yes) and turns it into points and a level. It is a pure function of the
 * counters Hermoso keeps anyway, so it can never differ from what really happened, and it changes nothing: no setting,
 * no protection depends on it.
 */

export interface Weight {
  /** What one of them is worth. */
  each: number
  key: AuraKey
}

export type AuraKey =
  'freezes' | 'frozenHalfMinutes' | 'ghosts' | 'guardianAsked' | 'guardianRefused' | 'rewinds' | 'teleports'

/** In the order the page lists them. */
export const WEIGHTS: readonly Weight[] = [
  { each: 25, key: 'freezes' },
  { each: 10, key: 'guardianRefused' },
  { each: 5, key: 'guardianAsked' },
  { each: 15, key: 'rewinds' },
  { each: 20, key: 'ghosts' },
  { each: 10, key: 'teleports' },
  { each: 1, key: 'frozenHalfMinutes' }
]

export interface Level {
  /** The points at which it begins. */
  at: number
  id: 'beyond' | 'glow' | 'jacked' | 'quiet' | 'radiant' | 'strong'
}

export const LEVELS: readonly Level[] = [
  { at: 0, id: 'quiet' },
  { at: 30, id: 'glow' },
  { at: 100, id: 'radiant' },
  { at: 250, id: 'strong' },
  { at: 600, id: 'jacked' },
  { at: 1500, id: 'beyond' }
]

/** A count past this is not believed: a damaged file must not make a number with twenty digits. */
const MAX_COUNT = 100_000

export interface AuraLine {
  count: number
  each: number
  key: AuraKey
  points: number
}

export interface AuraState {
  breakdown: AuraLine[]
  level: Level['id']
  /** The next level, or null at the top. */
  next: null | Level
  points: number
  /** How far the points are from the start of this level to the start of the next (0 at the top). */
  span: number
  /** How far into this level the points are. */
  into: number
}

const count = (counters: Record<string, number>, name: string): number => {
  const value = counters[name]

  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_COUNT) : 0
}

/** The counts that earn aura, from the raw counters. */
export function earned(counters: Record<string, number>): Record<AuraKey, number> {
  return {
    freezes: count(counters, 'freezes'),
    frozenHalfMinutes: Math.floor(count(counters, 'frozenSeconds') / 30),
    ghosts: count(counters, 'ghosts'),
    guardianAsked: count(counters, 'guardianAsked'),
    guardianRefused: count(counters, 'guardianDenied') + count(counters, 'guardianBlocked'),
    rewinds: count(counters, 'rewinds'),
    teleports: count(counters, 'teleports')
  }
}

export function computeAura(counters: Record<string, number>): AuraState {
  const counts = earned(counters)

  const breakdown: AuraLine[] = WEIGHTS.map(({ each, key }) => ({
    count: counts[key],
    each,
    key,
    points: counts[key] * each
  }))

  const points = breakdown.reduce((sum, line) => sum + line.points, 0)
  const index = LEVELS.reduce((found, level, at) => (points >= level.at ? at : found), 0)
  const level = LEVELS[index]
  const next = LEVELS[index + 1] ?? null

  return {
    breakdown,
    into: points - level.at,
    level: level.id,
    next,
    points,
    span: next ? next.at - level.at : 0
  }
}
