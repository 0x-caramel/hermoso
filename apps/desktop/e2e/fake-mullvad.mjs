#!/usr/bin/env node
/**
 * Scripted stand-in for the `mullvad` CLI, for the VPN-gate e2e spec.
 *
 * The desktop runs it through HERMES_MULLVAD_CLI (a `.mjs` override is executed
 * with the app's own Node runtime, so this works on every platform). State lives
 * in the JSON file named by FAKE_MULLVAD_STATE so a spec can script a scenario
 * before launch and read what the app did afterwards:
 *
 *   {
 *     "tunnel": "disconnected" | "connecting" | "connected" | "blocked",
 *     "account": true,             // false → `account get` says not logged in
 *     "connectDelayMs": 1500,      // how long `connect` takes to reach connected
 *     "failConnect": false,        // true → `connect` fails like a dead daemon
 *     "stuck": false,              // true → connect is accepted but never completes
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
// invocation owns (the call log and the tunnel it moved) over a fresh read, never the
// whole snapshot it started from.
const original = { connectedAt: state.connectedAt, tunnel: state.tunnel }

const save = () => {
  const fresh = JSON.parse(fs.readFileSync(statePath, 'utf8'))

  fresh.log = state.log

  if (state.tunnel !== original.tunnel || state.connectedAt !== original.connectedAt) {
    fresh.tunnel = state.tunnel
    fresh.connectedAt = state.connectedAt
  }

  fs.writeFileSync(statePath, JSON.stringify(fresh, null, 2))
}

// `connect` settles on a timer in the real daemon; model it lazily on each read.
if (state.tunnel === 'connecting' && !state.stuck && Date.now() - state.connectedAt >= (state.connectDelayMs ?? 1500)) {
  state.tunnel = 'connected'
}

const [command, sub] = args

if (command === 'status') {
  save()

  if (state.tunnel === 'connected') {
    console.log('Connected')
    console.log('    Relay:                se-got-wg-001')
    console.log('    Visible location:     Sweden, Gothenburg. IPv4: 203.0.113.7')
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
  console.log('Germany (de)')
  console.log('\tBerlin (ber) @ 52.52°N, 13.40°E')
  console.log('\t\tde-ber-wg-001 (185.213.155.73, 2a03:1b20:6:f011::a01f) - WireGuard, hosted by Blix (rented)')
  console.log('Sweden (se)')
  console.log('\tGothenburg (got) @ 57.71°N, 11.97°E')
  console.log('\t\tse-got-wg-001 (185.213.154.66, 2a03:1b20:5:f011::a01f) - WireGuard, hosted by 31173 (rented)')
  console.log('\tStockholm (sto) @ 59.33°N, 18.06°E')
  console.log('\t\tse-sto-wg-001 (185.65.135.66, 2a03:1b20:2:f011::a01f) - WireGuard, hosted by Blix (rented)')
} else if (command === 'relay' && sub === 'set') {
  save()
} else {
  save()
  console.error(`fake-mullvad: unsupported command: ${args.join(' ')}`)
  process.exit(1)
}
