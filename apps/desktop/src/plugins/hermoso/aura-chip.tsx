/**
 * The status-bar chip for Aura: a spark and the number, once there is something to count (a window with nothing to
 * show takes no room in the bar). A click opens the Hermoso page. A ghost keeps nothing, aura included.
 */

import { host, useValue } from '@hermes/plugin-sdk'
import { IconSparkles } from '@tabler/icons-react'

import { $aura, $ghost, $hermosoReady } from './store'
import { STRINGS } from './strings'

const T = STRINGS.aura

const PATH = '/hermoso'

export function AuraChip() {
  const ready = useValue($hermosoReady)
  const aura = useValue($aura)
  const ghost = useValue($ghost)

  if (!ready || ghost.ghost || aura.points <= 0) {
    return null
  }

  const title = T.chipTitle(T.levels[aura.level] ?? aura.level, aura.points)

  return (
    <button
      aria-label={title}
      className="inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground"
      data-level={aura.level}
      onClick={() => host.navigate(PATH)}
      title={title}
      type="button"
    >
      <IconSparkles className="size-3" />
      <span className="tabular-nums">{aura.points}</span>
    </button>
  )
}
