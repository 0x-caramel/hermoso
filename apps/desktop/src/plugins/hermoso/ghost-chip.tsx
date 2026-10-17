/**
 * The status-bar chip of a ghost window: nothing in the main window, a quiet "Ghost" in a ghost, with the panic button
 * one click away (and the key from anywhere).
 */

import { cn, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { IconGhost2 } from '@tabler/icons-react'

import { PanicButton } from './ghost-panel'
import { $ghost, $hermosoReady } from './store'
import { STRINGS } from './strings'

const T = STRINGS.ghost

export function GhostChip() {
  const ready = useValue($hermosoReady)
  const ghost = useValue($ghost)

  if (!ready || !ghost.ghost) {
    return null
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={T.chipTitle}
          className={cn(
            'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] font-medium transition-colors hover:bg-(--chrome-action-hover)'
          )}
          title={T.chipTitle}
          type="button"
        >
          <IconGhost2 className="size-3" />
          <span>{T.chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[19rem] p-3" side="top">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">{T.banner}</p>
          <PanicButton />
        </div>
      </PopoverContent>
    </Popover>
  )
}
