/**
 * Shield, as the person sees it: whether the agent is free or standing still, Mullvad's "Always require VPN" (the
 * only wall that stops a leak while the tunnel is down), the radar of what the app's own connections do, and the
 * proof report with its limits stated. Main decides everything shown here; this only asks and paints.
 */

import { Badge, Button, cn, StatusDot, type StatusTone, ToggleRow, useValue } from '@hermes/plugin-sdk'
import { IconClipboard, IconDownload, IconRefresh, IconShieldLock } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import type { RadarConnection, Route, ShieldState } from './api'
import { $lockdown, $radar, $shield, loadLockdown, lookAtRadar, readReport, resetRadar, setLockdown } from './store'
import { STRINGS } from './strings'

const T = STRINGS.shield

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'

/** How often the open panel looks at the machine again. */
const LOOK_EVERY_MS = 8_000

/** The most connections listed at once: the rest are counted. */
const LISTED = 8

export function shieldTone(state: ShieldState): StatusTone {
  return state.frozen ? 'bad' : state.required ? 'good' : 'muted'
}

export function shieldHeadline(state: ShieldState): string {
  return state.frozen ? T.frozen : state.required ? T.protectedNow : T.notRequired
}

const ROUTE_LABEL: Record<Route, string> = {
  lan: T.routes.lan,
  loopback: T.routes.loopback,
  outside: T.routes.outside,
  tunnel: T.routes.tunnel
}

function RouteBadge({ route }: { route: Route }) {
  return (
    <Badge
      className={cn('shrink-0', route === 'outside' && 'bg-destructive text-destructive-foreground')}
      data-route={route}
      variant={route === 'tunnel' ? 'default' : 'outline'}
    >
      {ROUTE_LABEL[route]}
    </Badge>
  )
}

function host(connection: RadarConnection): string {
  return connection.remoteAddress.includes(':')
    ? `[${connection.remoteAddress}]:${connection.remotePort}`
    : `${connection.remoteAddress}:${connection.remotePort}`
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = document.createElement('a')

  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** The state line alone: the chip's popover shows just this. */
export function ShieldStatus() {
  const state = useValue($shield)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm font-medium" data-testid="shield-headline">
        <StatusDot tone={shieldTone(state)} />
        <span className={cn(state.frozen && 'text-destructive')}>{shieldHeadline(state)}</span>
      </div>
      <p className={CAPTION}>
        {state.frozen
          ? T.frozenWhy(state.since === null ? '' : new Date(state.since).toLocaleTimeString())
          : state.required
            ? T.protectedWhy
            : T.notRequiredWhy}
      </p>
    </div>
  )
}

function Lockdown() {
  const on = useValue($lockdown)
  const [message, setMessage] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadLockdown()
  }, [])

  return (
    <div className="flex flex-col gap-1">
      <ToggleRow
        checked={on === true}
        description={T.alwaysDescription}
        disabled={busy || on === null}
        label={T.alwaysTitle}
        onChange={next => {
          setBusy(true)
          setMessage(null)

          void setLockdown(next).then(ok => {
            setBusy(false)
            setMessage(ok ? null : T.alwaysFailed)
          })
        }}
      />
      {on === null && <p className={CAPTION}>{T.alwaysUnknown}</p>}
      {message && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  )
}

function Radar() {
  const view = useValue($radar)
  const [copied, setCopied] = useState(false)
  const summary = view?.summary
  const seen = summary?.seen ?? 0
  const outside = summary?.byRoute.outside ?? 0
  const connections = view?.sample.connections ?? []

  const copy = async () => {
    const report = await readReport()

    if (report) {
      try {
        await navigator.clipboard.writeText(report)
        setCopied(true)
        setTimeout(() => setCopied(false), 2_000)
      } catch {
        // clipboard refused: the download button still works
      }
    }
  }

  const save = async () => {
    const report = await readReport()

    if (report) {
      download(`hermoso-shield-report-${new Date().toISOString().slice(0, 10)}.md`, report)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-(--ui-text-secondary)">{T.radarTitle}</span>
        <Button onClick={() => void lookAtRadar()} size="xs" type="button" variant="ghost">
          <IconRefresh className="size-3" />
          {T.lookNow}
        </Button>
      </div>

      {view?.sample.error ? (
        <p className="text-[0.6875rem] text-destructive" data-testid="radar-error" role="alert">
          {T.radarError(view.sample.error)}
        </p>
      ) : !view ? (
        <p className={CAPTION}>{T.radarWaiting}</p>
      ) : (
        <p className={cn('text-sm', outside > 0 && 'font-medium text-destructive')} data-testid="radar-summary">
          {seen === 0 ? T.radarNothing : outside > 0 ? T.radarOutside(seen, outside) : T.radarClean(seen)}
        </p>
      )}

      {connections.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="radar-list">
          {connections.slice(0, LISTED).map(connection => (
            <li
              className="flex items-center justify-between gap-2 text-xs"
              key={`${connection.pid}|${connection.localAddress}:${connection.localPort}|${host(connection)}`}
            >
              <span className="min-w-0 truncate">
                {connection.process} <span className="text-(--ui-text-tertiary)">→ {host(connection)}</span>
              </span>
              <RouteBadge route={connection.route} />
            </li>
          ))}
          {connections.length > LISTED && <li className={CAPTION}>{T.more(connections.length - LISTED)}</li>}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-1">
        <Button onClick={() => void copy()} size="xs" type="button" variant="outline">
          <IconClipboard className="size-3" />
          {copied ? T.copied : T.copyReport}
        </Button>
        <Button onClick={() => void save()} size="xs" type="button" variant="outline">
          <IconDownload className="size-3" />
          {T.saveReport}
        </Button>
        <Button onClick={() => void resetRadar()} size="xs" type="button" variant="ghost">
          {T.startOver}
        </Button>
      </div>

      <p className={CAPTION}>{T.limits}</p>
    </div>
  )
}

export function ShieldPanel({ className }: { className?: string }) {
  useEffect(() => {
    void lookAtRadar()

    const timer = setInterval(() => void lookAtRadar(), LOOK_EVERY_MS)

    return () => clearInterval(timer)
  }, [])

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconShieldLock className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      <ShieldStatus />
      <p className={CAPTION}>{T.blurb}</p>

      <Lockdown />
      <Radar />
    </div>
  )
}
