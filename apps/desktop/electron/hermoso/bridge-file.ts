/**
 * Where the running app tells the agent's plugin how to reach it (main process, Electron-free).
 *
 * `<hermes home>/plugins/hermoso/.bridge.json` holds the bridge's address and this run's secret. The plugin reads
 * it every time it needs the app, so a backend that outlives the app that started it (after a crash), or one that
 * another program started, finds the next Hermoso by itself; and with no Hermoso running there is no file, so the
 * plugin hides its tools from the model. The file is removed when the app quits; a stale one (a crash) holds a
 * dead port and a dead secret and is overwritten at the next start.
 */

import fs from 'node:fs'
import path from 'node:path'

export const BRIDGE_FILE = '.bridge.json'

export const bridgeFilePath = (hermesHome: string): string => path.join(hermesHome, 'plugins', 'hermoso', BRIDGE_FILE)

export interface BridgeAddress {
  token: string
  url: string
}

/** Publish the address for the plugin installed in this Hermes home (atomically: a reader never sees half of it). */
export function writeBridgeFile(hermesHome: string, address: BridgeAddress, now: () => number = Date.now): string {
  const file = bridgeFilePath(hermesHome)
  const temp = `${file}.${process.pid}.tmp`

  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    temp,
    JSON.stringify({ pid: process.pid, startedAt: now(), token: address.token, url: address.url }),
    'utf8'
  )
  fs.renameSync(temp, file)

  return file
}

/** Take the address back: only a file this process wrote (its pid) is removed. */
export function removeBridgeFile(hermesHome: string): void {
  const file = bridgeFilePath(hermesHome)

  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) {
      fs.rmSync(file, { force: true })
    }
  } catch {
    // nothing there, or not ours
  }
}
