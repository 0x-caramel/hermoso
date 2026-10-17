/**
 * Everything Hermoso says in the window, in one place. English only: the fork keeps its words out of the
 * app's own language files so an upstream update never has to be merged with them.
 */

export const STRINGS = {
  agentTools: {
    hint: 'The agent’s tools appear in its tool list while Hermoso is running, and disappear when it is not.',
    never: 'Not seen yet. The tools reach the agent at its next turn.',
    seen: (version: string, time: string) => `Connected · plugin ${version} · last seen ${time}`,
    title: 'Agent tools'
  },
  allowed: {
    empty: 'Nothing yet. When you choose “Always allow” for a country, it is listed here.',
    hint: 'The agent may teleport to these countries without asking you.',
    remove: 'Ask again',
    title: 'Allowed without asking'
  },
  brand: {
    motto: 'The brother who protects.',
    name: 'Hermoso'
  },
  consent: {
    always: (label: string) => (label ? `Always allow ${label}` : 'Always allow'),
    deny: 'Deny',
    description: 'Hermoso is asking whether the agent may do this.',
    once: 'Allow once'
  },
  nav: 'Hermoso',
  palette: {
    open: 'Hermoso: open',
    teleport: 'Hermoso: teleport…'
  },
  teleport: {
    addTime: 'Add 10 min',
    agentAsked: 'The agent asked for this.',
    away: (place: string) => `Exiting from ${place}`,
    blurb: 'Move your whole computer’s exit to the internet to another country for a while. It comes back by itself.',
    chipHome: 'Teleport',
    chipTitleAway: (place: string, left: string) => `Teleported to ${place}, back home in ${left}`,
    chipTitleHome: 'Teleport: exit from another country for a while',
    city: 'City',
    cityAny: 'Any city',
    country: 'Country',
    countryPlaceholder: 'Choose a country',
    duration: 'Stay for',
    errors: {
      'already-there': 'Your connection already exits from there.',
      busy: 'The tunnel is changing state. Try again in a moment.',
      failed: 'The jump did not work.',
      'home-not-restorable':
        'Your current Mullvad location cannot be put back automatically. Pick a country in Mullvad first.',
      'return-incomplete': 'You are home, but the tunnel has not finished coming up.',
      timeout: 'The tunnel did not come up there in time. You are back home.',
      unavailable: 'Hermoso did not answer.',
      'unknown-destination': 'Mullvad has no server there.',
      'vpn-unavailable': 'Mullvad is not answering. Is it installed, logged in and running?'
    } as Record<string, string>,
    explain: 'Mullvad moves your whole connection, not only Hermoso: every app on this computer exits from there.',
    goingHome: 'Coming home…',
    home: (place: string) => `Now exiting from ${place}`,
    homeUnknown: 'Mullvad is not connected',
    jumping: 'Jumping…',
    minutes: (n: number) => `${n} min`,
    returnHome: 'Return home',
    since: (time: string) => `since ${time}`,
    title: 'Teleport',
    teleportTo: (place: string) => `Teleport to ${place}`,
    teleportNow: 'Teleport',
    backIn: (left: string) => `back home in ${left}`
  }
}

export type Strings = typeof STRINGS
