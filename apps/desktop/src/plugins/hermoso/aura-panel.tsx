/**
 * Aura, as the person sees it: a level, a number and what earned them. It is for fun and says so: nothing in Hermoso
 * depends on it, and it is only arithmetic over the counts main keeps (main works it out; this paints it).
 */

import { cn, useValue } from '@hermes/plugin-sdk'
import { IconSparkles } from '@tabler/icons-react'

import type { AuraLevelId } from './api'
import { $aura } from './store'
import { STRINGS } from './strings'

const T = STRINGS.aura

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

/** The glow around the emblem grows with the level (whole class names, so the stylesheet keeps them). */
const GLOW: Record<AuraLevelId, string> = {
  beyond: 'shadow-2xl shadow-primary/70',
  glow: 'shadow-sm shadow-primary/30',
  jacked: 'shadow-xl shadow-primary/60',
  quiet: '',
  radiant: 'shadow-md shadow-primary/40',
  strong: 'shadow-lg shadow-primary/50'
}

export function AuraEmblem({ className, level }: { className?: string; level: AuraLevelId }) {
  return (
    <span
      className={cn(
        'flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary',
        GLOW[level] ?? '',
        className
      )}
      data-level={level}
    >
      <IconSparkles className="size-6" />
    </span>
  )
}

export function AuraPanel({ className }: { className?: string }) {
  const aura = useValue($aura)
  const earned = aura.breakdown.filter(line => line.count > 0)
  const name = T.levels[aura.level] ?? aura.level
  const nextName = aura.next ? (T.levels[aura.next.id] ?? aura.next.id) : null
  const percent = aura.span > 0 ? Math.min(100, Math.max(0, Math.round((aura.into / aura.span) * 100))) : 100

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconSparkles className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      <div className="flex items-center gap-4">
        <AuraEmblem level={aura.level} />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight" data-testid="aura-level">
            {name}
          </p>
          <p className="text-sm tabular-nums text-(--ui-text-secondary)" data-testid="aura-points">
            {T.points(aura.points)}
          </p>
        </div>
      </div>

      <p className={CAPTION}>{T.taglines[aura.level] ?? ''}</p>

      {aura.next && nextName ? (
        <div className="flex flex-col gap-1">
          <div
            aria-label={T.progressLabel(nextName)}
            aria-valuemax={aura.span}
            aria-valuemin={0}
            aria-valuenow={aura.into}
            className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <span className={CAPTION} data-testid="aura-next">
            {T.next(aura.next.at - aura.points, nextName)}
          </span>
        </div>
      ) : (
        <span className={CAPTION} data-testid="aura-next">
          {T.top}
        </span>
      )}

      {earned.length === 0 ? (
        <p className={CAPTION}>{T.nothingYet}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="aura-lines">
          {earned.map(line => (
            <li className="flex items-baseline justify-between gap-3 text-sm" key={line.key}>
              <span className="min-w-0 truncate">{T.lines[line.key] ?? line.key}</span>
              <span className="shrink-0 tabular-nums text-(--ui-text-tertiary)">
                {line.count} × {line.each} = <span className="font-medium text-foreground">+{line.points}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className={CAPTION}>
        {T.blurb}
        {aura.since > 0 && ` ${T.since(new Date(aura.since).toLocaleDateString())}`}
      </p>
    </div>
  )
}
