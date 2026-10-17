import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPluginInstaller,
  enableInConfig,
  hashPluginFiles,
  type HermesRun,
  installPlugin,
  PLUGIN_NAME
} from './plugin-install'

const dirs: string[] = []

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermoso-plugin-'))

  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function source(extra: Record<string, string> = {}): string {
  const dir = temp()

  const files: Record<string, string> = {
    '__init__.py': 'def register(ctx):\n    pass\n',
    'bridge.py': 'BRIDGE = 1\n',
    'plugin.yaml': 'name: hermoso\nversion: 0.1.0\n',
    ...extra
  }

  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }

  return dir
}

/** A Hermes home with this config.yaml (none when `config` is null). */
function homeWith(config: null | string, others: string[] = []): string {
  const home = temp()

  if (config !== null) {
    fs.writeFileSync(path.join(home, 'config.yaml'), config)
  }

  for (const name of others) {
    fs.mkdirSync(path.join(home, 'plugins', name), { recursive: true })
    fs.writeFileSync(path.join(home, 'plugins', name, 'plugin.yaml'), `name: ${name}\n`)
  }

  return home
}

const ok: HermesRun = { code: 0, output: '' }

function deps(run: HermesRun | ((args: string[], home: string) => HermesRun) = ok) {
  const runHermes = vi.fn(async (args: string[], home: string) => (typeof run === 'function' ? run(args, home) : run))
  const log = vi.fn()

  return { log, runHermes }
}

const installed = (home: string, rel = '') => path.join(home, 'plugins', PLUGIN_NAME, rel)
const marker = (home: string) => JSON.parse(fs.readFileSync(installed(home, '.hermoso-install.json'), 'utf8'))
const config = (home: string) => fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')

describe('installing the plugin into a Hermes home', () => {
  it('copies the files, lists the plugin in config.yaml, and remembers it did', async () => {
    const home = homeWith('model:\n  default: x\n')
    const d = deps()
    const result = await installPlugin(source(), home, d)

    expect(result).toEqual({ changed: true, enabled: 'enabled-now' })
    expect(fs.readFileSync(installed(home, 'bridge.py'), 'utf8')).toBe('BRIDGE = 1\n')
    expect(fs.existsSync(installed(home, '__init__.py'))).toBe(true)
    expect(config(home)).toContain('- hermoso')
    expect(d.runHermes).not.toHaveBeenCalled()
    expect(marker(home)).toMatchObject({ enabled: true, version: '0.1.0' })
  })

  it('does nothing the second time: same files, config untouched', async () => {
    const home = homeWith('model:\n  default: x\n')
    const src = source()

    await installPlugin(src, home, deps())

    const before = config(home)
    const second = await installPlugin(src, home, deps())

    expect(second).toEqual({ changed: false, enabled: 'already' })
    expect(config(home)).toBe(before)
  })

  it("replaces the files when the app's copy changed, and drops the ones that are gone", async () => {
    const home = homeWith(null)

    await installPlugin(source({ 'old_module.py': 'X = 1\n' }), home, deps())
    expect(fs.existsSync(installed(home, 'old_module.py'))).toBe(true)

    const result = await installPlugin(
      source({ 'bridge.py': 'BRIDGE = 2\n', 'new_module.py': 'Y = 1\n' }),
      home,
      deps()
    )

    expect(result).toEqual({ changed: true, enabled: 'already' })
    expect(fs.readFileSync(installed(home, 'bridge.py'), 'utf8')).toBe('BRIDGE = 2\n')
    expect(fs.existsSync(installed(home, 'new_module.py'))).toBe(true)
    expect(fs.existsSync(installed(home, 'old_module.py'))).toBe(false)
  })

  it('leaves the files the app itself keeps beside the plugin alone (the bridge address)', async () => {
    const home = homeWith(null)

    await installPlugin(source(), home, deps())
    fs.writeFileSync(installed(home, '.bridge.json'), '{"url":"http://127.0.0.1:1","token":"t"}')

    // the app's copy changes: files are replaced and leftovers dropped, but not the address the app published
    await installPlugin(source({ 'bridge.py': 'BRIDGE = 2\n' }), home, deps())
    expect(fs.readFileSync(installed(home, '.bridge.json'), 'utf8')).toContain('"token":"t"')
    expect(fs.readFileSync(installed(home, 'bridge.py'), 'utf8')).toBe('BRIDGE = 2\n')
  })

  it('repairs a file someone deleted', async () => {
    const home = homeWith(null)
    const src = source()

    await installPlugin(src, home, deps())
    fs.rmSync(installed(home, 'bridge.py'))

    const result = await installPlugin(src, home, deps())

    expect(result.changed).toBe(true)
    expect(fs.existsSync(installed(home, 'bridge.py'))).toBe(true)
  })

  it('enables it once, never again: a person who switches it off in Hermes is not overruled', async () => {
    const home = homeWith('plugins:\n  enabled: []\n  disabled: []\n')
    const src = source()

    await installPlugin(src, home, deps())
    expect(config(home)).toContain('hermoso')

    // the person turns it off in Capabilities -> Plugins
    fs.writeFileSync(path.join(home, 'config.yaml'), 'plugins:\n  enabled: []\n  disabled:\n    - hermoso\n')

    const again = await installPlugin(src, home, deps())

    expect(again).toEqual({ changed: false, enabled: 'already' })
    expect(config(home)).toBe('plugins:\n  enabled: []\n  disabled:\n    - hermoso\n')
  })

  it('does not copy bytecode caches or tests', async () => {
    const home = homeWith(null)

    await installPlugin(
      source({ '__pycache__/x.cpython-311.pyc': 'bytecode', 'tests/test_x.py': 'pass\n', 'x.pyc': 'b' }),
      home,
      deps()
    )

    expect(fs.existsSync(installed(home, '__pycache__'))).toBe(false)
    expect(fs.existsSync(installed(home, 'tests'))).toBe(false)
    expect(fs.existsSync(installed(home, 'x.pyc'))).toBe(false)
  })

  it('refuses a source that is not the plugin', async () => {
    await expect(installPlugin(temp(), temp(), deps())).rejects.toThrow(/missing from the app/)
  })

  it('hashes by name and content, not by order or time', () => {
    const a = [
      { bytes: Buffer.from('1'), rel: 'a.py' },
      { bytes: Buffer.from('2'), rel: 'b.py' }
    ]

    expect(hashPluginFiles(a)).toBe(hashPluginFiles([...a]))
    expect(hashPluginFiles(a)).not.toBe(hashPluginFiles([{ bytes: Buffer.from('1'), rel: 'a.py' }]))
    expect(hashPluginFiles(a)).not.toBe(hashPluginFiles([{ ...a[0], rel: 'c.py' }, a[1]]))
  })
})

describe('listing the plugin in config.yaml', () => {
  it('adds it to an existing list and keeps every comment and every other setting', () => {
    const home = homeWith(
      '# my settings\nmodel:\n  default: x # keep me\nplugins:\n  enabled:\n    - alpha\n  disabled: []\n'
    )

    expect(enableInConfig(home)).toBe('edited')

    const text = config(home)

    expect(text).toContain('# my settings')
    expect(text).toContain('# keep me')
    expect(text).toMatch(/enabled:\n\s+- alpha\n\s+- hermoso\n/)
    expect(text).toContain('default: x')
  })

  it('takes it off the disabled list when it was there', () => {
    const home = homeWith('plugins:\n  enabled:\n    - alpha\n  disabled:\n    - hermoso\n    - beta\n')

    expect(enableInConfig(home)).toBe('edited')
    expect(config(home)).toMatch(/disabled:\n\s+- beta\n/)
    expect(config(home)).not.toMatch(/disabled:[\s\S]*hermoso/)
  })

  it('starts the list when there is none and no other plugin needs grandfathering', () => {
    const home = homeWith('model:\n  default: x\n')

    expect(enableInConfig(home)).toBe('edited')
    expect(config(home)).toMatch(/plugins:\n\s+enabled:\n\s+- hermoso\n\s+disabled: \[\]/)
  })

  it('creates config.yaml when the home has none', () => {
    const home = homeWith(null)

    expect(enableInConfig(home)).toBe('edited')
    expect(config(home)).toContain('- hermoso')
  })

  it('writes nothing when it is already listed', () => {
    const text = 'plugins:\n  enabled:\n    - hermoso\n'
    const home = homeWith(text)

    expect(enableInConfig(home)).toBe('already-listed')
    expect(config(home)).toBe(text)
  })

  it('reads a config that starts with a byte-order mark', () => {
    const home = homeWith(`${String.fromCharCode(0xfeff)}model:\n  default: x\n`)

    expect(enableInConfig(home)).toBe('edited')
    expect(config(home)).toContain('- hermoso')
  })

  it('leaves to Hermes anything it should not guess about, and writes nothing', () => {
    const cases: [string, null | string, string[]][] = [
      ['a config that does not parse', 'model: [unclosed\n  default: x\n', []],
      ['a config that is not a mapping', '- just\n- a list\n', []],
      ['plugins that are not a mapping', 'plugins: yes\n', []],
      ['an enabled that is not a list', 'plugins:\n  enabled: all\n', []],
      ['no list while other plugins are installed (they need grandfathering)', 'model:\n  default: x\n', ['alpha']]
    ]

    for (const [why, text, others] of cases) {
      const home = homeWith(text, others)

      expect(enableInConfig(home), why).toBe('needs-cli')
      expect(config(home), why).toBe(text)
    }
  })
})

describe('when Hermes has to do the enabling', () => {
  it('asks its own command, and remembers it worked', async () => {
    const home = homeWith('model: [unclosed\n')
    const d = deps()
    const result = await installPlugin(source(), home, d)

    expect(result).toEqual({ changed: true, enabled: 'enabled-now' })
    expect(d.runHermes).toHaveBeenCalledTimes(1)
    expect(d.runHermes.mock.calls[0][0]).toEqual(['plugins', 'enable', 'hermoso'])
    expect(d.runHermes.mock.calls[0][1]).toBe(home)
    expect(marker(home).enabled).toBe(true)
  })

  it('keeps the files and tries again next time when the command fails', async () => {
    const home = homeWith('model: [unclosed\n')
    const src = source()
    const first = await installPlugin(src, home, deps({ code: 1, output: 'boom\nsecond line' }))

    expect(first).toMatchObject({ changed: true, enabled: 'failed' })
    expect(first.error).toContain('second line')
    expect(marker(home).enabled).toBe(false)
    expect(fs.existsSync(installed(home, '__init__.py'))).toBe(true)

    const working = deps()
    const second = await installPlugin(src, home, working)

    expect(second).toEqual({ changed: false, enabled: 'enabled-now' })
    expect(working.runHermes).toHaveBeenCalledTimes(1)
    expect(marker(home).enabled).toBe(true)
  })
})

describe('the installer the app uses', () => {
  it('prepares each home once per run and never throws', async () => {
    const home = homeWith(null)
    const d = deps()
    const installer = createPluginInstaller(source(), d)

    const results = await Promise.all([installer.prepare(home), installer.prepare(home), installer.prepare(home)])

    expect(new Set(results).size).toBe(1)
    expect(results[0]).toMatchObject({ enabled: 'enabled-now' })
    expect(await installer.prepare(home)).toBe(results[0])
  })

  it('reports a home it cannot install into and tries again at the next start', async () => {
    const d = deps()
    const installer = createPluginInstaller(temp(), d) // not the plugin: always fails

    expect(await installer.prepare(temp())).toBeNull()
    expect(d.log.mock.calls.join('\n')).toContain('could not install')

    // a failure is not remembered
    expect(await installer.prepare(temp())).toBeNull()
  })
})
