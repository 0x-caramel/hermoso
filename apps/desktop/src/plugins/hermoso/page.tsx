/**
 * The Hermoso page: who he is, his aura (for fun), and every protection he gives, one section each. The shield first,
 * then the guardian, the Time Machine, the ghost and Teleport, then what the agent is allowed to do without asking and
 * whether its tools are connected.
 */

import { Button, cn, useTheme, useValue } from '@hermes/plugin-sdk'
import { IconPlugConnected } from '@tabler/icons-react'
import { type ReactNode, useEffect } from 'react'

import { AuraPanel } from './aura-panel'
import { GhostPanel } from './ghost-panel'
import { GuardianPanel } from './guardian-panel'
import { ShieldPanel } from './shield-panel'
import { $agent, $allowed, $ghost, loadAllowed, revokeAllowed } from './store'
import { STRINGS } from './strings'
import { TeleportPanel } from './teleport-panel'
import { TimeMachinePanel } from './timemachine-panel'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

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

function Section({ children }: { children: ReactNode }) {
  return <section className="rounded-lg bg-(--ui-bg-quaternary) p-4">{children}</section>
}

/** The aura scoreboard. A ghost keeps nothing, so it has none. */
function AuraSection() {
  const ghost = useValue($ghost)

  return ghost.ghost ? null : (
    <Section>
      <AuraPanel />
    </Section>
  )
}

function AgentTools() {
  const T = STRINGS.agentTools
  const agent = useValue($agent)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <IconPlugConnected className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>
      <p className="text-xs" data-testid="agent-status">
        {agent.seenAt === null ? T.never : T.seen(agent.version ?? '?', new Date(agent.seenAt).toLocaleTimeString())}
      </p>
      <p className={CAPTION}>{T.hint}</p>
    </div>
  )
}

function Allowed() {
  const T = STRINGS.allowed
  const allowed = useValue($allowed)

  useEffect(() => {
    void loadAllowed()
  }, [])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{T.title}</span>
      <p className={CAPTION}>{T.hint}</p>

      {allowed.length === 0 ? (
        <p className={CAPTION}>{T.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {allowed.map(item => (
            <li className="flex items-center justify-between gap-3 text-sm" key={item.key}>
              <span className="truncate">{item.label}</span>
              <Button onClick={() => void revokeAllowed(item.key)} size="xs" type="button" variant="ghost">
                {T.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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

        <AuraSection />

        <Section>
          <ShieldPanel />
        </Section>

        <Section>
          <GuardianPanel />
        </Section>

        <Section>
          <TimeMachinePanel />
        </Section>

        <Section>
          <GhostPanel />
        </Section>

        <Section>
          <TeleportPanel />
        </Section>

        <Section>
          <Allowed />
        </Section>

        <Section>
          <AgentTools />
        </Section>
      </div>
    </div>
  )
}
