import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ExternalLink, ShieldCheck } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $vpn,
  $vpnLoaded,
  disconnectVpn,
  ensureVpn,
  initVpnBridge,
  loadVpnRelays,
  loadVpnState,
  openMullvad,
  refreshVpn,
  saveVpnSettings,
  vpnPlace,
  type VpnRelayCountry,
  vpnStatusKey,
  type VpnStatusKey
} from '@/store/vpn'

import { CONTROL_TEXT } from './constants'
import { ListRow, Pill, SectionHeading, SettingsContent, ToggleRow } from './primitives'

const CAPTION = 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'

// Radix Select forbids an empty item value, so "no choice" gets a sentinel.
const KEEP = '__keep__'
const ANY = '__any__'

const STATUS_TONE: Record<VpnStatusKey, 'destructive' | 'muted' | 'success' | 'warn'> = {
  blocked: 'destructive',
  checking: 'warn',
  connected: 'success',
  connecting: 'warn',
  disconnected: 'warn',
  disconnecting: 'warn',
  notInstalled: 'destructive',
  off: 'muted',
  unknown: 'muted'
}

function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(CAPTION, className)}>{children}</p>
}

/**
 * Settings → VPN. Main is authoritative (it owns the tunnel and the saved
 * preference), so every control here writes through the bridge and paints the
 * state main answers with — see store/vpn.
 */
export function VpnSettings() {
  const { t } = useI18n()
  const copy = t.settings.vpn
  const status = t.vpn.status
  const vpn = useStore($vpn)
  const loaded = useStore($vpnLoaded)
  const [relays, setRelays] = useState<null | VpnRelayCountry[]>(null)
  const gateReady = vpn.gate === 'ready'

  useEffect(() => {
    initVpnBridge()
    void loadVpnState().then(() => refreshVpn())
  }, [])

  // The list only exists once Mullvad is installed and its service is up, so it is
  // re-read when the CLI turns up (e.g. the user just installed it).
  useEffect(() => {
    let cancelled = false

    void loadVpnRelays().then(list => {
      if (!cancelled) {
        setRelays(list)
      }
    })

    return () => {
      cancelled = true
    }
  }, [vpn.cliFound, gateReady])

  const { settings } = vpn
  const key = vpnStatusKey(vpn)
  const place = vpnPlace(vpn)
  const country = relays?.find(entry => entry.code === settings.country) ?? null
  const transitioning = key === 'checking' || key === 'connecting' || key === 'disconnecting'
  const canConnect = key === 'disconnected' || key === 'blocked' || key === 'unknown'

  return (
    <SettingsContent>
      <SectionHeading icon={ShieldCheck} title={copy.title} />
      <Caption className="mb-2 leading-(--conversation-caption-line-height)">{copy.intro}</Caption>

      <ToggleRow
        checked={settings.enabled}
        description={copy.enabledDesc}
        label={copy.enabledTitle}
        onChange={enabled => void saveVpnSettings({ enabled })}
      />

      {settings.enabled && loaded && (
        <>
          <ToggleRow
            checked={settings.block}
            description={copy.blockDesc}
            label={copy.blockTitle}
            onChange={block => void saveVpnSettings({ block })}
          />

          <ListRow
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Pill tone={STATUS_TONE[key]}>{status[key]}</Pill>
                {canConnect && (
                  <Button
                    onClick={() => {
                      triggerHaptic('selection')
                      void ensureVpn()
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {copy.connect}
                  </Button>
                )}
                {key === 'connected' && (
                  <Button
                    onClick={() => {
                      triggerHaptic('selection')
                      void disconnectVpn()
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {copy.disconnect}
                  </Button>
                )}
                <Button
                  disabled={transitioning}
                  onClick={() => void openMullvad()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <ExternalLink />
                  {key === 'notInstalled' ? copy.getApp : copy.openApp}
                </Button>
              </div>
            }
            below={key === 'connected' && place ? <Caption className="mt-1">{status.via(place)}</Caption> : null}
            description={copy.statusDesc}
            title={copy.statusTitle}
          />

          <ListRow
            action={
              relays && relays.length > 0 ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Select
                    onValueChange={value =>
                      void saveVpnSettings({ city: null, country: value === KEEP ? null : value })
                    }
                    value={settings.country ?? KEEP}
                  >
                    <SelectTrigger aria-label={copy.countryLabel} className={cn('min-w-44', CONTROL_TEXT)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={KEEP}>{copy.locationKeep}</SelectItem>
                      {relays.map(entry => (
                        <SelectItem key={entry.code} value={entry.code}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {country && (
                    <Select
                      onValueChange={value => void saveVpnSettings({ city: value === ANY ? null : value })}
                      value={settings.city ?? ANY}
                    >
                      <SelectTrigger aria-label={copy.cityLabel} className={cn('min-w-36', CONTROL_TEXT)}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>{copy.cityAny}</SelectItem>
                        {country.cities.map(city => (
                          <SelectItem key={city.code} value={city.code}>
                            {city.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              ) : null
            }
            below={
              relays && relays.length === 0 ? <Caption className="mt-1">{copy.locationUnavailable}</Caption> : null
            }
            description={copy.locationDesc}
            title={copy.locationTitle}
          />

          <Caption className="mt-3 leading-(--conversation-caption-line-height)">{copy.protectionHint}</Caption>
        </>
      )}
    </SettingsContent>
  )
}
