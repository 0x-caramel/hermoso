import { describe, expect, it } from 'vitest'

import { computeAura, earned, LEVELS, WEIGHTS } from './aura'

describe('what earns aura', () => {
  it('starts at nothing, quiet, with a first level to reach', () => {
    const aura = computeAura({})

    expect(aura.points).toBe(0)
    expect(aura.level).toBe('quiet')
    expect(aura.next).toEqual({ at: 30, id: 'glow' })
    expect(aura.into).toBe(0)
    expect(aura.span).toBe(30)
    expect(aura.breakdown.every(line => line.count === 0 && line.points === 0)).toBe(true)
  })

  it('counts each protective act at its own worth, and lists them all in a fixed order', () => {
    const aura = computeAura({
      freezes: 2,
      frozenSeconds: 95,
      ghosts: 1,
      guardianAsked: 4,
      guardianBlocked: 1,
      guardianDenied: 2,
      rewinds: 1,
      teleports: 3
    })

    expect(aura.breakdown.map(line => [line.key, line.count, line.points])).toEqual([
      ['freezes', 2, 50],
      ['guardianRefused', 3, 30],
      ['guardianAsked', 4, 20],
      ['rewinds', 1, 15],
      ['ghosts', 1, 20],
      ['teleports', 3, 30],
      ['frozenHalfMinutes', 3, 3]
    ])
    expect(aura.points).toBe(168)
    expect(aura.breakdown.map(line => line.key)).toEqual(WEIGHTS.map(weight => weight.key))
  })

  it('a refusal counts whether the person said no, the time ran out, or it was never allowed', () => {
    expect(earned({ guardianBlocked: 1, guardianDenied: 1 }).guardianRefused).toBe(2)
  })

  it('time frozen is counted by the half minute, not by the second', () => {
    expect(earned({ frozenSeconds: 29 }).frozenHalfMinutes).toBe(0)
    expect(earned({ frozenSeconds: 30 }).frozenHalfMinutes).toBe(1)
    expect(earned({ frozenSeconds: 3600 }).frozenHalfMinutes).toBe(120)
  })

  it('does not believe what is not a count: text, negatives, infinities, fractions, absurd sizes', () => {
    const counts = earned({
      freezes: 2.9,
      ghosts: -4,
      guardianAsked: Number.POSITIVE_INFINITY,
      rewinds: Number.NaN,
      teleports: 1e12,
      unknown: 99
    } as unknown as Record<string, number>)

    expect(counts.freezes).toBe(2)
    expect(counts.ghosts).toBe(0)
    expect(counts.guardianAsked).toBe(0)
    expect(counts.rewinds).toBe(0)
    expect(counts.teleports).toBe(100_000)
    expect(Number.isFinite(computeAura({ teleports: 1e12 }).points)).toBe(true)
  })
})

describe('levels', () => {
  it('begin exactly at their points', () => {
    expect(computeAura({}).level).toBe('quiet')
    expect(computeAura({ freezes: 1 }).level).toBe('quiet')
    expect(computeAura({ freezes: 2 }).level).toBe('glow')
    expect(computeAura({ freezes: 4 }).level).toBe('radiant')
    expect(computeAura({ freezes: 10 }).level).toBe('strong')
    expect(computeAura({ freezes: 24 }).level).toBe('jacked')
    expect(computeAura({ freezes: 60 }).level).toBe('beyond')
  })

  it('say how far into the level the points are, and how far the next one is', () => {
    const aura = computeAura({ freezes: 5 })

    expect(aura).toMatchObject({ into: 25, level: 'radiant', points: 125, span: 150 })
    expect(aura.next).toEqual({ at: 250, id: 'strong' })
  })

  it('at the top there is no next, and no span', () => {
    const aura = computeAura({ freezes: 100 })

    expect(aura.level).toBe('beyond')
    expect(aura.next).toBeNull()
    expect(aura.span).toBe(0)
    expect(aura.into).toBe(1000)
  })

  it('are in order, each higher than the last', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].at).toBeGreaterThan(LEVELS[i - 1].at)
    }
  })
})
