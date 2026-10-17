/**
 * The status-bar chip for Teleport: a quiet globe while the connection is home, the place and the time left
 * while it is away. A click opens the same panel the Hermoso page has.
 */

import { cn, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { IconWorldBolt } from '@tabler/icons-react'
import { useState } from 'react'

import { ConsentHost } from './consent-host'
import { $hermosoReady, $teleport } from './store'
import { STRINGS } from './strings'
import { clock, placeName, TeleportPanel, useCountdown } from './teleport-panel'

const T = STRINGS.teleport

export function TeleportChip() {
  const ready = useValue($hermosoReady)
  const state = useValue($teleport)
  const left = useCountdown(state.trip?.until ?? null)
  const [open, setOpen] = useState(false)

  // The consent dialog lives here because this chip is always mounted: a request must be seen whatever page is open.
  if (!ready) {
    return <ConsentHost />
  }

  const away = state.trip !== null && state.phase !== 'idle'
  const place = state.trip ? placeName(state.trip) : ''

  const title = away ? T.chipTitleAway(place, left === null ? '' : clock(left)) : T.chipTitleHome

  return (
    <>
      <ConsentHost />
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-label={title}
            className={cn(
              'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors hover:bg-(--chrome-action-hover)',
              away ? 'text-primary' : 'text-(--ui-text-tertiary) hover:text-foreground'
            )}
            title={title}
            type="button"
          >
            <IconWorldBolt className="size-3" />
            {away && (
              <span className="max-w-40 truncate">
                {place}
                {left !== null ? ` · ${clock(left)}` : ''}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[19rem] p-3" side="top">
          <TeleportPanel onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    </>
  )
}
