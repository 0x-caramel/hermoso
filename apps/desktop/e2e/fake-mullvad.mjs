#!/usr/bin/env node
/**
 * Scripted stand-in for the `mullvad` CLI, for the VPN-gate and Teleport e2e specs.
 *
 * The desktop runs it through HERMES_MULLVAD_CLI (a `.mjs` override is executed
 * with the app's own Node runtime, so this works on every platform). State lives
 * in the JSON file named by FAKE_MULLVAD_STATE so a spec can script a scenario
 * before launch and read what the app did afterwards:
 *
 *   {
 *     "tunnel": "disconnected" | "connecting" | "connected" | "blocked",
 *     "account": true,             // false → `account get` says not logged in
 *     "connectDelayMs": 1500,      // how long `connect` (or a relay change) takes to reach connected
 *     "failConnect": false,        // true → `connect` fails like a dead daemon
 *     "stuck": false,              // true → connect is accepted but never completes
 *     "relay": "country se",       // the exit location constraint, as `relay get` prints it
 *     "lockdown": false,          // "Always require VPN" (`lockdown-mode get|set`)
 *     "connectedAt": null,         // set by the script
 *     "log": []                    // every invocation, appended by the script
 *   }
 */
import fs from 'node:fs'

const statePath = process.env.FAKE_MULLVAD_STATE
const args = process.argv.slice(2)

if (!statePath) {
  console.error('FAKE_MULLVAD_STATE is not set')
  process.exit(2)
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
state.log = [...(state.log ?? []), args.join(' ')]

// A spec edits the file while the app polls this script, so write back only what this
// invocation owns (the call log and the tunnel/relay it moved) over a fresh read, never the
// whole snapshot it started from.
const original = { connectedAt: state.connectedAt, lockdown: state.lockdown, relay: state.relay, tunnel: state.tunnel }

const save = () => {
  const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'))

  fresh.log = state.log

  if (state.tunnel !== original.tunnel || state.connectedAt !== original.connectedAt) {
    fresh.tunnel = state.tunnel
    fresh.connectedAt = state.connectedAt
  }

  if (state.relay !== original.relay) {
    fresh.relay = state.relay
  }

  if (state.lockdown !== original.lockdown) {
    fresh.lockdown = state.lockdown
  }

  fs.writeFileSync(statePath, JSON.stringify(fresh, null, 2))
}

// `connect` settles on a timer in the real daemon; model it lazily on each read.
if (state.tunnel === 'connecting' && !state.stuck && Date.now() - state.connectedAt >= (state.connectDelayMs ?? 1500)) {
  state.tunnel = 'connected'
}

// ── where the relay constraint puts the exit ──

const PLACES = {
  de: { city: 'Berlin', code: 'ber', country: 'Germany' },
  fr: { city: 'Paris', code: 'par', country: 'France' },
  no: { city: 'Oslo', code: 'osl', country: 'Norway' },
  se: { city: 'Gothenburg', code: 'got', country: 'Sweden' }
}

/** The exit relay a constraint such as `country de` or `city got, se` lands on. */
function exitOf(relay) {
  const text = String(relay ?? 'country se').trim().toLowerCase()
  const host = /hostname (\S+)/.exec(text)?.[1]
  const city = /^city (\w+), (\w\w)/.exec(text)
  const country = /^country (\w\w)$/.exec(text)
  const cc = host?.slice(0, 2) ?? city?.[2] ?? country?.[1] ?? 'se'
  const place = PLACES[cc] ?? PLACES.se
  const code = host?.split('-')[1] ?? city?.[1] ?? place.code

  return { city: place.city, code, country: place.country, host: host ?? `${cc}-${code}-wg-001` }
}

const printLocation = parts => {
  if (parts[0] === 'any') {
    return 'any'
  }

  if (parts.length === 1 && /^\w\w-\w+-\w+-\d+$/.test(parts[0])) {
    return `city ${parts[0].split('-')[1]}, ${parts[0].slice(0, 2)}, hostname ${parts[0]}`
  }

  if (parts.length === 1) {
    return `country ${parts[0]}`
  }

  return parts.length === 2 ? `city ${parts[1]}, ${parts[0]}` : `city ${parts[1]}, ${parts[0]}, hostname ${parts[2]}`
}

const [command, sub, third] = args

if (command === 'status') {
  save()

  const json = args.includes('--json') || args.includes('-j')
  const exit = exitOf(state.relay)

  if (json) {
    if (state.tunnel === 'connected') {
      console.log(
        JSON.stringify({
          details: {
            endpoint: { address: '198.51.100.1:51820', protocol: 'udp', tunnel_interface: 'Mullvad' },
            location: { city: exit.city, country: exit.country, hostname: exit.host, ipv4: '203.0.113.7' }
          },
          state: 'connected'
        })
      )
    } else if (state.tunnel === 'connecting') {
      // the real daemon prints nothing for a couple of seconds while a relay change reconnects
    } else if (state.tunnel === 'blocked') {
      console.log(JSON.stringify({ details: { cause: 'authentication failed' }, state: 'error' }))
    } else {
      console.log(JSON.stringify({ details: { location: { city: 'Naples', country: 'Italy' } }, state: 'disconnected' }))
    }
  } else if (state.tunnel === 'connected') {
    console.log('Connected')
    console.log(`    Relay:                ${exit.host}`)
    console.log(`    Visible location:     ${exit.country}, ${exit.city}. IPv4: 203.0.113.7`)
  } else if (state.tunnel === 'connecting') {
    console.log('Connecting to WireGuard 198.51.100.1:51820/UDP...')
  } else if (state.tunnel === 'blocked') {
    console.log('Blocked: Authentication failed')
  } else {
    console.log('Disconnected')
  }
} else if (command === 'account' && sub === 'get') {
  save()
  console.log(state.account === false ? 'Not logged in on any account' : 'Mullvad account: 1234 5678 9012 3456')
} else if (command === 'connect') {
  if (state.failConnect) {
    save()
    console.error('Error: Failed to connect to daemon')
    process.exit(1)
  }

  state.tunnel = 'connecting'
  state.connectedAt = Date.now()
  save()
} else if (command === 'disconnect') {
  state.tunnel = 'disconnected'
  save()
} else if (command === 'relay' && sub === 'list') {
  save()
  console.log('France (fr)')
  console.log('\tParis (par) @ 48.85°N, 2.35°E')
  console.log('\t\tfr-par-wg-001 (185.213.155.10, 2a03:1b20:6:f011::a01f) - WireGuard, hosted by Blix (rented)')
  console.log('Germany (de)')
  console.log('\tBerlin (ber) @ 52.52°N, 13.40°E')
  console.log('\t\tde-ber-wg-001 (185.213.155.73, 2a03:1b20:6:f011::a01f) - WireGuard, hosted by Blix (rented)')
  console.log('Norway (no)')
  console.log('\tOslo (osl) @ 59.91°N, 10.75°E')
  console.log('\t\tno-osl-wg-001 (185.213.155.20, 2a03:1b20:6:f011::a02f) - WireGuard, hosted by Blix (rented)')
  console.log('Sweden (se)')
  console.log('\tGothenburg (got) @ 57.71°N, 11.97°E')
  console.log('\t\tse-got-wg-001 (185.213.154.66, 2a03:1b20:5:f011::a01f) - WireGuard, hosted by 31173 (rented)')
  console.log('\tStockholm (sto) @ 59.33°N, 18.06°E')
  console.log('\t\tse-sto-wg-001 (185.65.135.66, 2a03:1b20:2:f011::a01f) - WireGuard, hosted by Blix (rented)')
} else if (command === 'relay' && sub === 'get') {
  save()
  console.log('Generic constraints')
  console.log(`    Location:               ${state.relay ?? 'country se'}`)
  console.log('    Provider(s):            any')
  console.log('    Ownership:              any')
  console.log('WireGuard constraints')
  console.log('    IP protocol:            any')
  console.log('    Multihop state:         disabled')
  console.log('    Multihop entry:         country it')
} else if (command === 'relay' && sub === 'set' && third === 'location') {
  state.relay = printLocation(args.slice(3))

  // A live tunnel reconnects by itself to the new relay.
  if (state.tunnel === 'connected') {
    state.tunnel = 'connecting'
    state.connectedAt = Date.now()
  }

  save()
} else if (command === 'relay' && sub === 'set') {
  save()
} else if (command === 'lockdown-mode' && sub === 'get') {
  save()
  console.log(`Block traffic when the VPN is disconnected: ${state.lockdown ? 'on' : 'off'}`)
} else if (command === 'lockdown-mode' && sub === 'set') {
  state.lockdown = third === 'on'
  save()
} else {
  save()
  console.error(`fake-mullvad: unsupported command: ${args.join(' ')}`)
  process.exit(1)
}
