/**
 * The Hermoso page: who he is, and every protection he gives, one section each. Teleport is the first.
 */

import { cn, useTheme } from '@hermes/plugin-sdk'

import { STRINGS } from './strings'
import { TeleportPanel } from './teleport-panel'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

/** The brother's portrait on the app-icon tile, light or dark like the rest of the app's brand mark. */
export function HermosoMark({ className }: { className?: string }) {
  const { renderedMode } = useTheme()

  return (
    <span className={cn('inline-flex size-14 shrink-0 items-center justify-center', className)}>
      <img
        alt=""
        className="size-full object-contain"
        src={assetPath(renderedMode === 'dark' ? 'nous-girl-dark.png' : 'nous-girl.png')}
      />
    </span>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg bg-(--ui-bg-quaternary) p-4">{children}</section>
}

export function HermosoPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-5 px-6 py-8">
        <header className="flex items-center gap-4">
          <HermosoMark />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{STRINGS.brand.name}</h1>
            <p className="text-sm text-(--ui-text-tertiary)">{STRINGS.brand.motto}</p>
          </div>
        </header>

        <Section>
          <TeleportPanel />
        </Section>
      </div>
    </div>
  )
}
