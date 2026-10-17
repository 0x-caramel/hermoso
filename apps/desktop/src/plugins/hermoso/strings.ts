/**
 * Everything Hermoso says in the window, in one place. English only: the fork keeps its words out of the
 * app's own language files so an upstream update never has to be merged with them.
 */

/** An Electron accelerator in the words a person uses for it ("CommandOrControl" is Ctrl, or Cmd on a Mac). */
export function friendlyKey(accelerator: string): string {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

  return accelerator.replace('CommandOrControl', mac ? 'Cmd' : 'Ctrl')
}

export const STRINGS = {
  agentTools: {
    hint: 'The agent’s tools appear in its tool list while Hermoso is running, and disappear when it is not.',
    never: 'Not seen yet. The tools reach the agent at its next turn.',
    seen: (version: string, time: string) => `Connected · plugin ${version} · last seen ${time}`,
    title: 'Agent tools'
  },
  allowed: {
    empty: 'Nothing yet. When you choose “Always allow”, it is listed here.',
    hint: 'The agent may do these without asking you.',
    remove: 'Ask again',
    title: 'Allowed without asking'
  },
  aura: {
    blurb: 'Aura grows with what Hermoso does for you. It is just for fun: nothing depends on it.',
    chipTitle: (level: string, points: number) => `Aura: ${level} · ${points}`,
    levels: {
      beyond: 'Beyond jacked',
      glow: 'Glowing',
      jacked: 'AURA JACKED',
      quiet: 'Quiet',
      radiant: 'Radiant',
      strong: 'Strong'
    } as Record<string, string>,
    lines: {
      freezes: 'Agent held still when the VPN dropped',
      frozenHalfMinutes: 'Half minutes of standing guard',
      ghosts: 'Ghost windows opened',
      guardianAsked: 'Questions asked before risky actions',
      guardianRefused: 'Risky actions refused',
      rewinds: 'Projects rewound',
      teleports: 'Teleports'
    } as Record<string, string>,
    next: (left: number, level: string) => `${left} more for ${level}`,
    nothingYet: 'No aura yet. It grows when Hermoso steps in for you.',
    points: (n: number) => `${n} aura`,
    progressLabel: (level: string) => `Progress towards ${level}`,
    since: (date: string) => `Counting since ${date}.`,
    taglines: {
      beyond: 'Beyond jacked. A legend of the household.',
      glow: 'The first sparks: Hermoso has stepped in.',
      jacked: 'The big brother is in the room.',
      quiet: 'Calm. Nothing has needed protecting yet.',
      radiant: 'A steady glow. Hermoso keeps watch.',
      strong: 'Little gets past him.'
    } as Record<string, string>,
    title: 'Aura',
    top: 'The top. Nothing above this.'
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
  ghost: {
    banner: 'This is a ghost window: nothing is kept.',
    blurb:
      'A window that keeps nothing. Its chats, memories and logs live in a temporary folder that is deleted when the window closes, on the panic key, or at the next start if the computer went off first.',
    chipLabel: 'Ghost',
    chipTitle: 'Ghost window: nothing is kept',
    errors: {
      'no-launch': 'The ghost window could not start.',
      'no-setup': 'There is no model setup to copy yet. Set a model up first, then open a ghost.',
      unavailable: 'A ghost can be opened from the main window only.'
    } as Record<string, string>,
    limits:
      'Deleted is not shredded: a solid-state disk may keep traces. Your model’s provider still sees what you send it, and files the agent writes in a project folder stay there. Ghost keeps nothing of the conversation on this computer.',
    open: 'Open a ghost window',
    opened: 'The ghost window is opening…',
    panic: 'Panic: delete everything and close',
    panicHint: (key: string) => `Or press ${friendlyKey(key)} from anywhere.`,
    title: 'Ghost',
    whatItCopies:
      'Your model setup, keys and VPN choice are copied into the temporary folder for the session, and deleted with it. Your own chats and memories are not.'
  },
  guardian: {
    blurb: 'Before the agent does something that cannot be undone, Hermoso asks you, in this window, in plain words.',
    decisions: {
      allowed: 'Allowed once',
      always: 'Always allowed',
      blocked: 'Refused',
      denied: 'Denied',
      remembered: 'Allowed (remembered)',
      timeout: 'No answer'
    } as Record<string, string>,
    limits:
      'The guardian reads what the agent is about to run or write and recognises the risky kinds. It is a net with holes, not a sandbox: it catches honest mistakes and obvious attacks, and a determined program can find a way round a pattern.',
    nothingYet: 'Nothing risky has been tried yet.',
    offNote:
      'Even switched off, Hermoso never lets the agent wipe a disk or edit Hermoso’s own files. Everything else goes through without asking.',
    switchDescription:
      'Deleting folders, rewriting git history, running what was downloaded, reading keys, switching the VPN off, installing software, writing where programs start by themselves.',
    switchTitle: 'Review risky commands',
    title: 'Guardian',
    totals: (t: { allowed: number; asked: number; blocked: number; denied: number }) =>
      `${t.asked} asked · ${t.allowed} allowed · ${t.denied} denied · ${t.blocked} refused outright`
  },
  nav: 'Hermoso',
  timeMachine: {
    blurb:
      'Just before the agent first changes a file in a turn, Hermes saves a snapshot of the project folder. Here you can see what it changed, and put the project’s files back.',
    cancel: 'Cancel',
    chatLeft: 'The chat was left as it is, so the agent still knows what it did: tell it the files are back.',
    confirm: (when: string) =>
      `Put the project's files back to how they were at ${when}? Everything the agent changed after that is undone and the files it created are removed. Files you edited yourself are kept. The chat is left as it is.`,
    failed: (reason: string) => `It was not rewound: ${reason}`,
    failedPlain: 'It was not rewound.',
    keptEdits: (n: number) => `${n} file${n === 1 ? '' : 's'} you changed yourself ${n === 1 ? 'was' : 'were'} kept.`,
    limits:
      'Snapshots are Hermes’ own, kept outside your project. Folders that are too broad (your whole home) or hold too many files are not snapshotted, and files over 10 MB are left out.',
    looking: 'Looking…',
    noAnswer: 'Hermes did not answer. Try again in a moment.',
    noChanges: 'Nothing has changed since this snapshot.',
    noDiff: 'Hermes could not say what changed.',
    notOnForThisChat: 'Snapshots were not on when this chat started. They will be for the next one.',
    nothingYet:
      'No snapshots yet. One is taken just before the agent first changes a file in a turn, in a folder it can snapshot.',
    openAChat: 'Open a chat in a project folder to see its snapshots.',
    restartNote: 'This takes effect the next time Hermoso starts.',
    rewind: 'Rewind',
    rewindHere: 'Rewind to here',
    rewinding: 'Rewinding…',
    rewound: (n: number) => `Rewound: ${n} file${n === 1 ? '' : 's'} put back.`,
    stuck: (n: number) => `${n} file${n === 1 ? '' : 's'} could not be removed.`,
    seeChanges: 'See changes',
    switchDescription: 'Applies from the next start of Hermoso. Nothing in your own settings is changed.',
    switchTitle: 'Snapshot before the agent changes files',
    title: 'Time Machine'
  },
  palette: {
    open: 'Hermoso: open',
    teleport: 'Hermoso: teleport…'
  },
  shield: {
    alwaysDescription:
      'Mullvad blocks all internet traffic whenever the tunnel is not up. It is the only wall that really stops a leak while the tunnel is down.',
    alwaysFailed: 'Mullvad did not take the change. Is it installed, logged in and running?',
    alwaysTitle: 'Always require VPN',
    alwaysUnknown: 'Mullvad is not answering, so this cannot be read or changed now.',
    blurb: 'When the VPN tunnel drops, the agent stands still until it is back. Nothing it was about to do is lost.',
    chipFrozen: 'Frozen · VPN down',
    chipTitleFrozen: 'The agent is frozen: the VPN tunnel is down',
    chipTitleUp: 'Shield: the VPN tunnel is up and the agent is free to work',
    copied: 'Copied',
    copyReport: 'Copy report',
    frozen: 'The agent is frozen',
    frozenWhy: (since: string) =>
      `The VPN tunnel is down${since ? ` since ${since}` : ''}. The agent goes on by itself when the tunnel is back.`,
    limits:
      'Hermoso looks at the connections of this app and of everything it starts, every few seconds. A connection that opens and closes between two looks is not seen, and UDP is not listed. This is evidence, not a guarantee: only “Always require VPN” stops a leak.',
    lookNow: 'Look now',
    more: (n: number) => `…and ${n} more`,
    notRequired: 'The VPN is not required',
    notRequiredWhy:
      'Turn on “Use Mullvad VPN” and “Wait for the VPN before starting” in Settings → VPN, and Hermoso will hold the agent whenever the tunnel is down.',
    openShield: 'Open Shield',
    protectedNow: 'Protected',
    protectedWhy: 'The VPN tunnel is up. If it drops, the agent stops by itself.',
    radarClean: (seen: number) => `${seen} connection${seen === 1 ? '' : 's'} seen. None went outside the tunnel.`,
    radarError: (reason: string) => `Could not look at the connections (${reason}).`,
    radarNothing: 'No connections seen yet.',
    radarOutside: (seen: number, outside: number) =>
      `${seen} connection${seen === 1 ? '' : 's'} seen. ${outside} went OUTSIDE the tunnel.`,
    radarTitle: 'What this app is connected to',
    radarWaiting: 'Looking…',
    routes: { lan: 'Local network', loopback: 'This computer', outside: 'Outside', tunnel: 'Tunnel' },
    saveReport: 'Save report',
    startOver: 'Start over',
    title: 'Shield'
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
