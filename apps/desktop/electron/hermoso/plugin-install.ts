/**
 * Puts the Hermoso plugin where the agent's backend looks for plugins (main process, Electron-free).
 *
 * The plugin's source ships inside the app (assets/hermoso-plugin). Before the app starts a backend for a Hermes
 * home it makes sure that home has the plugin, current and enabled:
 *
 *   <hermes home>/plugins/hermoso/        the files, replaced when the app's copy changed
 *   <hermes home>/plugins/hermoso/.hermoso-install.json   what was installed, and whether the app enabled it
 *
 * Enabling means listing it under `plugins.enabled` in that home's config.yaml. The common cases are edited
 * directly (a comment-preserving YAML edit: instant, and no second Hermes runtime to prepare for a home that does
 * not have one yet, which takes over a minute); anything unusual (a config that does not parse, an `enabled` key
 * that is missing while other plugins are installed and would need grandfathering) is left to Hermes' own
 * `hermes plugins enable hermoso`. It happens ONCE per home: a person who later turns the plugin off in
 * Capabilities -> Plugins is not overruled at the next launch. The plugin itself stays inert in any backend this
 * app did not start (see the plugin's bridge), so the official Hermes sharing the same data folder is unaffected.
 *
 * Nothing here may stop a backend from starting: every failure is reported and swallowed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { isMap, isSeq, parseDocument } from 'yaml'

// A byte-order mark at the start of a file written by another program (PowerShell 5 adds one).
const BOM_AT_START = new RegExp('^' + String.fromCharCode(0xfeff))

export const PLUGIN_NAME = 'hermoso'
const MARKER = '.hermoso-install.json'
// Files the app itself keeps beside the plugin (what was installed; where the running app can be reached): never
// part of the plugin's content, never removed as a leftover.
const STATE_FILES = new Set([MARKER, '.bridge.json'])
const SKIPPED_DIRS = new Set(['__pycache__', '.pytest_cache', 'tests'])
const ENABLE_TIMEOUT_MS = 90_000

export interface HermesRun {
  code: null | number
  output: string
}

export interface PluginInstallDeps {
  log?: (message: string) => void
  /** Run `hermes <args>` for this Hermes home (the app's own way of reaching the runtime's CLI). */
  runHermes: (args: string[], hermesHome: string, timeoutMs: number) => Promise<HermesRun>
}

interface PluginFile {
  bytes: Buffer
  rel: string
}

interface Marker {
  enabled: boolean
  hash: string
  version: null | string
}

export interface PluginInstallResult {
  /** Files were written (first install, or the app's copy changed). */
  changed: boolean
  enabled: 'already' | 'enabled-now' | 'failed'
  error?: string
}

function listFiles(root: string, dir = root): PluginFile[] {
  const files: PluginFile[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...listFiles(root, full))
      }
    } else if (entry.isFile() && !entry.name.endsWith('.pyc') && !STATE_FILES.has(entry.name)) {
      files.push({ bytes: fs.readFileSync(full), rel: path.relative(root, full).split(path.sep).join('/') })
    }
  }

  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

export function hashPluginFiles(files: PluginFile[]): string {
  const hash = crypto.createHash('sha256')

  for (const file of files) {
    hash.update(file.rel).update('\0').update(file.bytes).update('\0')
  }

  return hash.digest('hex').slice(0, 16)
}

function readMarker(dir: string): Marker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'))

    return typeof raw?.hash === 'string'
      ? { enabled: raw.enabled === true, hash: raw.hash, version: typeof raw.version === 'string' ? raw.version : null }
      : null
  } catch {
    return null
  }
}

function writeMarker(dir: string, marker: Marker): void {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8')
}

function pluginVersion(files: PluginFile[]): null | string {
  const manifest = files.find(file => file.rel === 'plugin.yaml')

  return manifest ? (/^version:\s*"?([^"\r\n]+?)"?\s*$/m.exec(manifest.bytes.toString('utf8'))?.[1] ?? null) : null
}

export type ConfigEnable = 'already-listed' | 'edited' | 'needs-cli'

/** Another plugin installed in this home (any folder with a manifest): the reason not to start a list from scratch. */
function hasOtherPlugins(hermesHome: string): boolean {
  try {
    return fs
      .readdirSync(path.join(hermesHome, 'plugins'), { withFileTypes: true })
      .some(
        entry =>
          entry.isDirectory() &&
          entry.name !== PLUGIN_NAME &&
          !entry.name.startsWith('.') &&
          (fs.existsSync(path.join(hermesHome, 'plugins', entry.name, 'plugin.yaml')) ||
            fs.existsSync(path.join(hermesHome, 'plugins', entry.name, 'plugin.json')))
      )
  } catch {
    return false
  }
}

/**
 * List the plugin under `plugins.enabled` in the home's config.yaml, keeping every comment and the layout.
 * Answers `needs-cli` (and writes nothing) for anything it should not guess about.
 */
export function enableInConfig(hermesHome: string): ConfigEnable {
  const file = path.join(hermesHome, 'config.yaml')
  let text = ''

  try {
    text = fs.readFileSync(file, 'utf8').replace(BOM_AT_START, '')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      return 'needs-cli'
    }
  }

  const doc = parseDocument(text)

  if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
    return 'needs-cli'
  }

  const plugins = doc.get('plugins', true)

  if (plugins !== undefined && plugins !== null && !isMap(plugins)) {
    return 'needs-cli'
  }

  const enabled = doc.getIn(['plugins', 'enabled'], true)
  const disabled = doc.getIn(['plugins', 'disabled'], true)

  const listedAsDisabled =
    isSeq(disabled) && disabled.items.some(item => String((item as any)?.value ?? item) === PLUGIN_NAME)

  if (isSeq(enabled)) {
    const listed = enabled.items.some(item => String((item as any)?.value ?? item) === PLUGIN_NAME)

    if (listed && !listedAsDisabled) {
      return 'already-listed'
    }

    if (!listed) {
      doc.addIn(['plugins', 'enabled'], PLUGIN_NAME)
    }
  } else if (enabled === undefined || enabled === null) {
    // No list at all: Hermes treats other installed plugins specially in that case, so starting one is its job.
    if (hasOtherPlugins(hermesHome)) {
      return 'needs-cli'
    }

    doc.setIn(['plugins', 'enabled'], [PLUGIN_NAME])

    if (!doc.hasIn(['plugins', 'disabled'])) {
      doc.setIn(['plugins', 'disabled'], [])
    }
  } else {
    return 'needs-cli'
  }

  if (listedAsDisabled && isSeq(disabled)) {
    disabled.items = disabled.items.filter(item => String((item as any)?.value ?? item) !== PLUGIN_NAME)
  }

  writeFileAtomic(file, Buffer.from(doc.toString(), 'utf8'))

  return 'edited'
}

/** Write one file so that a reader never sees half of it: temp file in the same folder, then rename over. */
function writeFileAtomic(target: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })

  const temp = `${target}.${process.pid}.tmp`

  fs.writeFileSync(temp, bytes)
  fs.renameSync(temp, target)
}

function installFiles(files: PluginFile[], target: string): void {
  fs.mkdirSync(target, { recursive: true })

  for (const file of files) {
    writeFileAtomic(path.join(target, ...file.rel.split('/')), file.bytes)
  }

  // Files of an older version that no longer exist: removed, so a renamed module cannot linger and shadow.
  const wanted = new Set(files.map(file => file.rel))

  for (const old of listFiles(target)) {
    if (!wanted.has(old.rel)) {
      fs.rmSync(path.join(target, ...old.rel.split('/')), { force: true })
    }
  }
}

export async function installPlugin(
  sourceDir: string,
  hermesHome: string,
  deps: PluginInstallDeps
): Promise<PluginInstallResult> {
  const log = deps.log ?? (() => {})
  const target = path.join(hermesHome, 'plugins', PLUGIN_NAME)
  const files = listFiles(sourceDir)

  if (!files.some(file => file.rel === 'plugin.yaml') || !files.some(file => file.rel === '__init__.py')) {
    throw new Error(`the Hermoso plugin is missing from the app (${sourceDir})`)
  }

  const hash = hashPluginFiles(files)
  const marker = readMarker(target)

  const upToDate =
    marker?.hash === hash && files.every(file => fs.existsSync(path.join(target, ...file.rel.split('/'))))

  if (!upToDate) {
    installFiles(files, target)
    log(`[hermoso] plugin ${pluginVersion(files) ?? '?'} installed in ${target}`)
  }

  const next: Marker = { enabled: marker?.enabled === true, hash, version: pluginVersion(files) }

  if (next.enabled) {
    if (!upToDate) {
      writeMarker(target, next)
    }

    return { changed: !upToDate, enabled: 'already' }
  }

  let direct: ConfigEnable = 'needs-cli'

  try {
    direct = enableInConfig(hermesHome)
  } catch (error) {
    log(`[hermoso] could not edit the plugin list directly: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (direct !== 'needs-cli') {
    writeMarker(target, { ...next, enabled: true })
    log(direct === 'edited' ? '[hermoso] plugin enabled' : '[hermoso] plugin was already enabled')

    return { changed: !upToDate, enabled: direct === 'edited' ? 'enabled-now' : 'already' }
  }

  const ran = await deps.runHermes(['plugins', 'enable', PLUGIN_NAME], hermesHome, ENABLE_TIMEOUT_MS)

  if (ran.code === 0) {
    writeMarker(target, { ...next, enabled: true })
    log('[hermoso] plugin enabled')

    return { changed: !upToDate, enabled: 'enabled-now' }
  }

  // Files are in place; the next start tries to enable it again.
  writeMarker(target, next)

  const error = `hermes plugins enable ${PLUGIN_NAME} ended with ${ran.code}: ${ran.output.trim().split(/\r?\n/).slice(-3).join(' / ')}`

  log(`[hermoso] ${error}`)

  return { changed: !upToDate, enabled: 'failed', error }
}

/**
 * The installer as the app uses it: once per Hermes home per run, never throws, never blocks longer than the
 * enable command's timeout.
 */
export function createPluginInstaller(sourceDir: string, deps: PluginInstallDeps) {
  const prepared = new Map<string, Promise<PluginInstallResult | null>>()
  const log = deps.log ?? (() => {})

  return {
    prepare(hermesHome: string): Promise<PluginInstallResult | null> {
      const key = path.resolve(hermesHome).toLowerCase()
      let pending = prepared.get(key)

      if (!pending) {
        pending = installPlugin(sourceDir, hermesHome, deps).catch(error => {
          log(
            `[hermoso] could not install the plugin in ${hermesHome}: ${error instanceof Error ? error.message : String(error)}`
          )

          // A failure is not remembered: the next backend start tries again.
          prepared.delete(key)

          return null
        })
        prepared.set(key, pending)
      }

      return pending
    }
  }
}

export type PluginInstaller = ReturnType<typeof createPluginInstaller>
