/**
 * The status-bar chip for the shield: nothing while the person does not require the VPN, a quiet shield while it is
 * required and the tunnel is up, and a loud one the moment the agent is frozen. A click opens the same verdict.
 */

import { Button, cn, host, Popover, PopoverContent, PopoverTrigger, useValue } from '@hermes/plugin-sdk'
import { IconShieldCheck, IconShieldExclamation } from '@tabler/icons-react'
import { useState } from 'react'

import { ShieldStatus } from './shield-panel'
import { $hermosoReady, $shield } from './store'
import { STRINGS } from './strings'

const T = STRINGS.shield

const PATH = '/hermoso'

export function ShieldChip() {
  const ready = useValue($hermosoReady)
  const state = useValue($shield)
  const [open, setOpen] = useState(false)

  if (!ready || !state.required) {
    return null
  }

  const title = state.frozen ? T.chipTitleFrozen : T.chipTitleUp
  const Icon = state.frozen ? IconShieldExclamation : IconShieldCheck

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={title}
          className={cn(
            'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] transition-colors hover:bg-(--chrome-action-hover)',
            state.frozen ? 'font-medium text-destructive' : 'text-(--ui-text-tertiary) hover:text-foreground'
          )}
          data-frozen={state.frozen}
          title={title}
          type="button"
        >
          <Icon className="size-3" />
          {state.frozen && <span>{T.chipFrozen}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[19rem] p-3" side="top">
        <div className="flex flex-col gap-3">
          <ShieldStatus />
          <Button
            onClick={() => {
              setOpen(false)
              host.navigate(PATH)
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {T.openShield}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
