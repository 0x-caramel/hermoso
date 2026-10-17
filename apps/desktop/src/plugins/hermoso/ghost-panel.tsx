/**
 * Ghost, as the person sees it. In the main window: what a ghost is, what is copied into it, and the button that opens
 * one. In a ghost: that it is one, the panic button and the key. The ghost itself (its folders, what is deleted and
 * when) is main's; this only asks and paints, and says the limits plainly: a mode about privacy must not oversell.
 */

import { Button, cn, useValue } from '@hermes/plugin-sdk'
import { IconGhost2 } from '@tabler/icons-react'
import { useState } from 'react'

import type { GhostOpenResult } from './api'
import { $ghost, openGhost, panicGhost } from './store'
import { STRINGS } from './strings'

const T = STRINGS.ghost

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

export function PanicButton({ className, size = 'sm' }: { className?: string; size?: 'sm' | 'xs' }) {
  const ghost = useValue($ghost)

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Button data-testid="panic" onClick={() => void panicGhost()} size={size} type="button" variant="destructive">
        {T.panic}
      </Button>
      {ghost.key && <span className={CAPTION}>{T.panicHint(ghost.key)}</span>}
    </div>
  )
}

export function GhostPanel({ className }: { className?: string }) {
  const ghost = useValue($ghost)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GhostOpenResult | null>(null)

  const open = async () => {
    setBusy(true)
    setResult(null)
    setResult(await openGhost())
    setBusy(false)
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconGhost2 className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      {ghost.ghost ? (
        <>
          <p className="text-sm font-medium" data-testid="ghost-banner">
            {T.banner}
          </p>
          <PanicButton />
        </>
      ) : (
        <>
          <p className={CAPTION}>{T.blurb}</p>
          <p className={CAPTION}>{T.whatItCopies}</p>

          <div>
            <Button
              disabled={!ghost.canOpen || busy}
              onClick={() => void open()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconGhost2 className="size-3.5" />
              {T.open}
            </Button>
          </div>

          {result?.ok === true && (
            <p className={CAPTION} data-testid="ghost-opened">
              {T.opened}
            </p>
          )}
          {result?.ok === false && (
            <p className="text-[0.6875rem] text-destructive" role="alert">
              {T.errors[result.code] ?? result.message}
            </p>
          )}
        </>
      )}

      <p className={CAPTION}>{T.limits}</p>
    </div>
  )
}
