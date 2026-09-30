import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorBanner, ErrorIcon } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { LogView } from '@/components/ui/log-view'
import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { prefersReducedMotion } from '@/hooks/use-media-query'
import { useI18n } from '@/i18n'
import { ExternalLink, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $desktopBoot } from '@/store/boot'
import {
  $vpn,
  $vpnLoaded,
  ensureVpn,
  initVpnBridge,
  loadVpnState,
  openMullvad,
  vpnHoldsBoot,
  waiveVpnStartup
} from '@/store/vpn'

// A check that finishes inside this window never paints — the tunnel is usually
// already up, and a card that flashes for a frame is worse than none.
const PAINT_DELAY_MS = 300
const FADE_OUT_MS = 200

type Phase = 'gone' | 'in' | 'out'

// The first screen of a launch when Mullvad is required. It owns the boot
// until the tunnel is up (or the user explicitly stops requiring it): main
// holds the backend start on the same state, so nothing dials out while this
// is showing. It is a startup gate only — once the app has booted, a reconnect
// from Settings never covers the chat again.
export function VpnGateOverlay() {
  const { t } = useI18n()
  const copy = t.vpn.gate
  const vpn = useStore($vpn)
  const loaded = useStore($vpnLoaded)
  const boot = useStore($desktopBoot)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('gone')
  const reduceMotion = prefersReducedMotion()
  const coldBootDoneRef = useRef(false)
  const shownRef = useRef(false)

  useEffect(() => {
    initVpnBridge()
    void loadVpnState()
  }, [])

  if (!boot.running && boot.progress >= 100 && !boot.error) {
    coldBootDoneRef.current = true
  }

  const blocked = vpn.gate === 'blocked'
  const holding = loaded && vpnHoldsBoot(vpn) && !coldBootDoneRef.current
  const paintable = useDelayedTrue(holding && !blocked, PAINT_DELAY_MS)

  // Once the card has been shown it stays until the gate releases: the brief
  // blocked → checking → blocked flip of a retry must not blink the surface.
  if (holding && (blocked || paintable)) {
    shownRef.current = true
  }

  if (!holding) {
    shownRef.current = false
  }

  const visible = holding && shownRef.current

  useEffect(() => {
    if (visible) {
      setPhase('in')

      return
    }

    setDetailsOpen(false)
    setPhase(current => (current === 'in' ? (reduceMotion ? 'gone' : 'out') : current))
  }, [visible, reduceMotion])

  useEffect(() => {
    if (phase !== 'out') {
      return
    }

    const id = window.setTimeout(() => setPhase('gone'), FADE_OUT_MS)

    return () => window.clearTimeout(id)
  }, [phase])

  if (phase === 'gone' && !visible) {
    return null
  }

  const reason = vpn.reason ?? 'failed'
  const notInstalled = blocked && reason === 'not-installed'
  const leaving = !visible

  return (
    <div
      aria-busy={!blocked}
      className={cn(
        'fixed inset-0 z-(--z-setup) flex items-center justify-center bg-(--ui-chat-surface-background) p-6 transition-opacity duration-200 ease-out motion-reduce:transition-none',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      // Masks the whole app while it waits for the tunnel — must stay filled
      // under window glass. Contract: `[data-glass-opaque]` in styles.css.
      data-glass-opaque=""
      role={blocked ? 'alert' : 'status'}
    >
      <div className="w-full max-w-[28rem] overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous">
        <div className="flex items-start gap-3 px-5 py-4">
          {blocked ? (
            <ErrorIcon className="mt-0.5" size="1.25rem" />
          ) : (
            <Loader className="mt-0.5 size-5 shrink-0" type="fourier-flow" />
          )}
          <div className="min-w-0">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">
              {blocked ? copy.blockedTitle : vpn.gate === 'checking' ? copy.checkingTitle : copy.connectingTitle}
            </h2>
            <p className="mt-1 text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">
              {blocked ? copy.blockedDescription : copy.waitingDescription}
            </p>
          </div>
        </div>

        <div className="grid gap-4 p-5 pt-0">
          {blocked && (
            <div className="grid gap-2">
              <ErrorBanner>{copy.reasons[reason]}</ErrorBanner>
              <p className="text-xs text-muted-foreground">{copy.hints[reason]}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {blocked && (
              <Button autoFocus onClick={() => void ensureVpn()}>
                <RefreshCw />
                {copy.retry}
              </Button>
            )}
            {blocked && (
              <Button onClick={() => void openMullvad()} variant="secondary">
                <ExternalLink />
                {notInstalled ? copy.getMullvad : copy.openMullvad}
              </Button>
            )}
            {/* The only action while connecting, so it is a real button; a quiet third
                action once a block has put Try again and Open Mullvad first. */}
            <Button onClick={() => void waiveVpnStartup()} variant={blocked ? 'ghost' : 'secondary'}>
              {copy.continueWithout}
            </Button>
          </div>

          <p className="-mt-2 text-xs text-muted-foreground">{copy.continueWithoutHint}</p>

          {blocked && vpn.message && (
            <div className="grid gap-2">
              <Button
                className="-ml-2 self-start font-medium"
                onClick={() => setDetailsOpen(open => !open)}
                size="xs"
                type="button"
                variant="text"
              >
                {copy.details}
              </Button>
              {detailsOpen && <LogView className="max-h-32">{vpn.message}</LogView>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
