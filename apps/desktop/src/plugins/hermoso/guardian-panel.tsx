/**
 * Guardian, as the person sees it: whether risky commands are reviewed, what it has asked and refused so far, and the
 * last things it decided. What the person is asked, and the "always allow" they chose, live where Teleport's do: in
 * the consent dialog and the "Allowed without asking" list. Main decides everything here; this only asks and paints.
 */

import { Badge, cn, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { IconShieldCheck } from '@tabler/icons-react'
import { useEffect } from 'react'

import type { GuardianDecision } from './api'
import { $guardian, loadGuardian, setGuardianOn } from './store'
import { STRINGS } from './strings'

const T = STRINGS.guardian

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

/** The most decisions listed: the file keeps thirty. */
const LISTED = 8

const REFUSED = new Set<GuardianDecision>(['blocked', 'denied', 'timeout'])

export function DecisionBadge({ decision }: { decision: GuardianDecision }) {
  return (
    <Badge
      className={cn('shrink-0', REFUSED.has(decision) && 'bg-destructive text-destructive-foreground')}
      data-decision={decision}
      variant={REFUSED.has(decision) ? 'default' : 'outline'}
    >
      {T.decisions[decision]}
    </Badge>
  )
}

export function GuardianPanel({ className }: { className?: string }) {
  const guardian = useValue($guardian)
  const { totals } = guardian

  useEffect(() => {
    void loadGuardian()
  }, [])

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconShieldCheck className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      <p className={CAPTION}>{T.blurb}</p>

      <ToggleRow
        checked={guardian.enabled}
        description={T.switchDescription}
        label={T.switchTitle}
        onChange={on => void setGuardianOn(on)}
      />
      {!guardian.enabled && (
        <p className={CAPTION} data-testid="guardian-off-note">
          {T.offNote}
        </p>
      )}

      <p className="text-sm" data-testid="guardian-totals">
        {totals.asked + totals.blocked === 0 ? T.nothingYet : T.totals(totals)}
      </p>

      {guardian.events.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="guardian-journal">
          {guardian.events.slice(0, LISTED).map(event => (
            <li className="flex flex-col gap-0.5" key={`${event.at}|${event.rule}|${event.detail}`}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium">{event.title}</span>
                <DecisionBadge decision={event.decision} />
              </div>
              {event.detail && (
                <code className="truncate font-mono text-[0.6875rem] text-(--ui-text-tertiary)" title={event.detail}>
                  {event.detail}
                </code>
              )}
              <span className={CAPTION}>{new Date(event.at).toLocaleTimeString()}</span>
            </li>
          ))}
        </ul>
      )}

      <p className={CAPTION}>{T.limits}</p>
    </div>
  )
}
