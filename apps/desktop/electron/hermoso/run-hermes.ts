/**
 * Runs a `hermes` subcommand through the runtime's own Python, for one Hermes home (main process).
 *
 * The same way the app already reaches the CLI for the uninstall summary: `python -m hermes_cli.main <args>` from
 * the runtime's folder, no window, output collected, a hard timeout (the whole tree is stopped when it is hit).
 * HERMES_DISABLE_LAZY_INSTALLS keeps a home that has no runtime of its own from preparing one just for this.
 */

import { type ChildProcess, spawn } from 'node:child_process'

import { hiddenWindowsChildOptions } from '../windows-child-options'

import type { HermesRun } from './plugin-install'

export interface HermesRunnerDeps {
  /** The runtime's working directory (its checkout). */
  cwd: () => string
  python: () => null | string
}

const OUTPUT_LIMIT = 64 * 1024

export function createHermesRunner(deps: HermesRunnerDeps) {
  return (args: string[], hermesHome: string, timeoutMs: number): Promise<HermesRun> =>
    new Promise(resolve => {
      const python = deps.python()

      if (!python) {
        return resolve({ code: null, output: 'no Hermes runtime to run the command with' })
      }

      let output = ''
      let settled = false
      let child: ChildProcess

      const done = (run: HermesRun) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(run)
        }
      }

      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-OUTPUT_LIMIT)
      }

      try {
        child = spawn(
          python,
          ['-m', 'hermes_cli.main', ...args],
          hiddenWindowsChildOptions({
            cwd: deps.cwd(),
            env: { ...process.env, HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_HOME: hermesHome, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
          })
        )
      } catch (error) {
        return resolve({ code: null, output: error instanceof Error ? error.message : String(error) })
      }

      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', error => done({ code: null, output: error.message }))
      child.on('exit', code => done({ code, output }))

      const timer = setTimeout(() => {
        // The command's own children (a runtime being prepared) go with it.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], hiddenWindowsChildOptions({ stdio: 'ignore' }))
        } else {
          child.kill('SIGKILL')
        }

        done({ code: null, output: `${output}\n(timed out after ${Math.round(timeoutMs / 1000)}s)` })
      }, timeoutMs)

      timer.unref?.()
    })
}
