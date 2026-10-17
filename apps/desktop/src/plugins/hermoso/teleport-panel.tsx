/**
 * Teleport, as the person uses it: where the connection exits now, a country and a length to go to, and (when
 * away) a way home with the time left. The same panel sits in the status bar's popover and on the Hermoso page.
 */

import {
  Button,
  cn,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useValue
} from '@hermes/plugin-sdk'
import { IconHome, IconPlus, IconWorldBolt } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'

import { $destinations, $exit, $teleport, loadDestinations, teleportHome, teleportTo } from './store'
import { STRINGS } from './strings'

const T = STRINGS.teleport

const CAPTION = 'text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)'
const LABEL = 'text-[0.6875rem] font-medium text-(--ui-text-secondary)'

/** A city sentinel: Radix Select forbids an empty value. */
const ANY_CITY = '__any__'

const DURATIONS = [5, 10, 30, 60] as const

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Milliseconds left until `until`, repainted every second; null when there is no end. */
export function useCountdown(until: null | number): null | number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (until === null) {
      return
    }

    setNow(Date.now())

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [until])

  return until === null ? null : Math.max(0, until - now)
}

export function placeName(trip: { city: null | string; countryName: null | string; country: string }): string {
  const country = trip.countryName ?? trip.country.toUpperCase()

  return trip.city ? `${country} (${trip.city.toUpperCase()})` : country
}

function Away() {
  const state = useValue($teleport)
  const trip = state.trip!
  const left = useCountdown(trip.until)
  const total = Math.max(1, trip.until - trip.since)
  const working = state.phase === 'jumping' || state.phase === 'returning'
  const minutesLeft = Math.ceil((left ?? 0) / 60_000)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={CAPTION}>
            {state.phase === 'jumping' ? T.jumping : state.phase === 'returning' ? T.goingHome : T.title}
          </div>
          <div className="truncate text-sm font-medium">{T.away(placeName(trip))}</div>
          <div className={cn(CAPTION, 'tabular-nums')}>{left !== null && T.backIn(clock(left))}</div>
        </div>
        <Button disabled={working} onClick={() => void teleportHome()} size="sm" type="button" variant="outline">
          <IconHome className="size-3.5" />
          {T.returnHome}
        </Button>
      </div>

      <div
        aria-hidden
        className="h-1 overflow-hidden rounded-full bg-(--ui-bg-tertiary)"
        title={left === null ? undefined : clock(left)}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.min(100, Math.round(((left ?? 0) / total) * 100))}%` }}
        />
      </div>

      {trip.by === 'agent' && (
        <p className={CAPTION}>
          {T.agentAsked}
          {trip.reason ? ` “${trip.reason}”` : ''}
        </p>
      )}

      <div>
        <Button
          disabled={working}
          onClick={() =>
            void teleportTo({ city: trip.city, country: trip.country, minutes: Math.min(60, minutesLeft + 10) })
          }
          size="xs"
          type="button"
          variant="ghost"
        >
          <IconPlus className="size-3" />
          {T.addTime}
        </Button>
      </div>
    </div>
  )
}

function Choose({ onDone }: { onDone?: () => void }) {
  const destinations = useValue($destinations)
  const exit = useValue($exit)
  const state = useValue($teleport)
  const [country, setCountry] = useState('')
  const [city, setCity] = useState(ANY_CITY)
  const [minutes, setMinutes] = useState<number>(10)
  const [message, setMessage] = useState<null | string>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadDestinations()
  }, [])

  const chosen = useMemo(() => destinations.find(entry => entry.code === country) ?? null, [country, destinations])

  const go = async () => {
    if (!chosen) {
      return
    }

    setBusy(true)
    setMessage(null)

    const result = await teleportTo({ city: city === ANY_CITY ? null : city, country: chosen.code, minutes })

    setBusy(false)

    if (result.ok) {
      onDone?.()
    } else {
      setMessage(T.errors[result.code] ?? result.message)
    }
  }

  const exitPlace = exit.up && exit.country ? (exit.city ? `${exit.country}, ${exit.city}` : exit.country) : null

  return (
    <div className="flex flex-col gap-3">
      <p className={CAPTION}>{exitPlace ? T.home(exitPlace) : T.homeUnknown}</p>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>{T.country}</span>
        <Select
          onValueChange={value => {
            setCountry(value)
            setCity(ANY_CITY)
          }}
          value={country}
        >
          <SelectTrigger>
            <SelectValue placeholder={T.countryPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {destinations.map(entry => (
              <SelectItem key={entry.code} value={entry.code}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {chosen && chosen.cities.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{T.city}</span>
          <Select onValueChange={setCity} value={city}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_CITY}>{T.cityAny}</SelectItem>
              {chosen.cities.map(entry => (
                <SelectItem key={entry.code} value={entry.code}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className={LABEL}>{T.duration}</span>
        <SegmentedControl
          onChange={value => setMinutes(Number(value))}
          options={DURATIONS.map(value => ({ id: String(value), label: T.minutes(value) }))}
          value={String(minutes)}
        />
      </div>

      <Button disabled={!chosen || busy || state.phase !== 'idle'} onClick={() => void go()} type="button">
        <IconWorldBolt className="size-4" />
        {busy ? T.jumping : chosen ? T.teleportTo(chosen.name) : T.teleportNow}
      </Button>

      {message && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  )
}

export function TeleportPanel({ className, onDone }: { className?: string; onDone?: () => void }) {
  const state = useValue($teleport)
  const away = state.trip !== null && state.phase !== 'idle'

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center gap-2">
        <IconWorldBolt className="size-4 shrink-0 text-(--ui-text-secondary)" />
        <span className="text-sm font-medium">{T.title}</span>
      </div>

      {away ? <Away /> : <Choose onDone={onDone} />}

      {state.error && !away && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {T.errors[state.error.code] ?? state.error.message}
        </p>
      )}

      <p className={CAPTION}>{T.explain}</p>
    </div>
  )
}
