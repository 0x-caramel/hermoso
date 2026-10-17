/**
 * Runs a command and collects its output (main process, Electron-free): what the radar uses to read the
 * machine's connections and process list. No console window flashes on Windows, a hard timeout, output capped.
 */

import { execFile } from 'node:child_process'

import { hiddenWindowsChildOptions } from '../windows-child-options'

export function runCommand(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: null | number; stdout: string }> {
  return new Promise(resolve => {
    try {
      execFile(
        file,
        args,
        hiddenWindowsChildOptions({ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }),
        (error: any, stdout: unknown) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            stdout: String(stdout ?? '')
          })
        }
      )
    } catch {
      resolve({ code: null, stdout: '' })
    }
  })
}
