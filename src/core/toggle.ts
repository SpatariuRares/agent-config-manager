// The only code that writes the Claude Code setup. Every write backs up the previous file first
// and refuses when the file changed since the caller read it.
import { knownProjects, projectSettingsFile, settingsFile, versionOf, type ProjectScope } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'

export type WriteResult =
  /** `backup` is null when nothing needed writing. */
  | { ok: true; backup: string | null }
  | {
      ok: false
      reason: 'changed' | 'unknown-plugin' | 'unknown-project' | 'unreadable' | 'unknown-backup'
      message: string
    }

export interface PluginToggle {
  id: string
  enabled: boolean
  /** The `settingsVersion` of the inventory the caller showed. */
  settingsVersion: string
}

export interface ProjectPluginChange {
  id: string
  project: string
  scope: ProjectScope
  /** null removes the override, so the project follows the global value. */
  enabled: boolean | null
  /** The inventory's `versions` entry for that project file. */
  version: string
}

export interface BackupRestore {
  name: string
  /** The inventory's version of the file this backup belongs to. */
  settingsVersion: string
}

export type Clock = () => Date

type Json = Record<string, any>

const CHANGED = { ok: false, reason: 'changed', message: 'The settings file changed since it was read. Refresh and try again.' } as const

const backupDir = (paths: ClaudePaths) => `${paths.claudeDir}/backups/claude-config-manager`
/** `<slug>.<ISO stamp with - for : and .>[-n].json`; slug is `settings` for the user file, else the encoded path. */
const BACKUP_NAME = /^(settings|%2F[A-Za-z0-9%._~!*'()-]+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?)\.json$/

export async function setPluginEnabled(
  fs: FileSystem,
  paths: ClaudePaths,
  change: PluginToggle,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = settingsFile(paths)
  const text = await fs.readText(file)
  if (versionOf(text) !== change.settingsVersion) return CHANGED
  const settings = parse(text ?? '')
  if (settings === null) return unreadable(file)
  if (!Object.hasOwn(settings.enabledPlugins ?? {}, change.id)) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not in enabledPlugins.` }
  }
  if (settings.enabledPlugins[change.id] === change.enabled) return { ok: true, backup: null }
  settings.enabledPlugins[change.id] = change.enabled
  return replace(fs, paths, file, text ?? '', settings, clock)
}

/** Sets, or with `enabled: null` removes, a plugin's value in one project's settings file. */
export async function setProjectPluginState(
  fs: FileSystem,
  paths: ClaudePaths,
  change: ProjectPluginChange,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = projectSettingsFile(change.project, change.scope)
  if (!(await knownProjects(fs, paths)).includes(change.project) || file === settingsFile(paths)) {
    return { ok: false, reason: 'unknown-project', message: `${change.project} is not a project Claude Code knows.` }
  }
  const user = parse((await fs.readText(settingsFile(paths))) ?? '{}') ?? {}
  const text = await fs.readText(file)
  if (versionOf(text) !== change.version) return CHANGED
  // A missing project file is created.
  const settings = text === null ? {} : parse(text)
  if (settings === null) return unreadable(file)
  const known = Object.hasOwn(user.enabledPlugins ?? {}, change.id) || Object.hasOwn(settings.enabledPlugins ?? {}, change.id)
  if (!known) return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not a plugin of this setup.` }

  const plugins: Json = settings.enabledPlugins ?? {}
  if (change.enabled === null ? !Object.hasOwn(plugins, change.id) : plugins[change.id] === change.enabled) {
    return { ok: true, backup: null }
  }
  if (change.enabled === null) delete plugins[change.id]
  else plugins[change.id] = change.enabled
  settings.enabledPlugins = plugins
  return replace(fs, paths, file, text ?? '{}\n', settings, clock)
}

/** Backup file names, newest first. */
export async function listBackups(fs: FileSystem, paths: ClaudePaths): Promise<string[]> {
  const stampOf = (name: string) => BACKUP_NAME.exec(name)?.[2] ?? ''
  return (await fs.listEntries(backupDir(paths)))
    .filter((name) => BACKUP_NAME.test(name))
    .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a))
}

/** The file a backup belongs to. */
export function backupTarget(paths: ClaudePaths, name: string): string | null {
  const slug = BACKUP_NAME.exec(name)?.[1]
  if (slug === undefined) return null
  return slug === 'settings' ? settingsFile(paths) : decodeURIComponent(slug)
}

/** Puts a backup back in place of the file it came from, after backing up that file. */
export async function restoreBackup(
  fs: FileSystem,
  paths: ClaudePaths,
  restore: BackupRestore,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const { name } = restore
  const target = backupTarget(paths, name)
  const text =
    target !== null && (await listBackups(fs, paths)).includes(name) ? await fs.readText(`${backupDir(paths)}/${name}`) : null
  if (target === null || text === null) return { ok: false, reason: 'unknown-backup', message: `${name} is not a known backup.` }
  const current = await fs.readText(target)
  if (versionOf(current) !== restore.settingsVersion) return CHANGED
  const backup = await backUp(fs, paths, target, current ?? '{}\n', clock)
  await fs.writeText(target, text)
  return { ok: true, backup }
}

async function replace(fs: FileSystem, paths: ClaudePaths, file: string, previous: string, next: Json, clock: Clock) {
  const backup = await backUp(fs, paths, file, previous, clock)
  await fs.writeText(file, JSON.stringify(next, null, 2) + '\n')
  return { ok: true, backup } as const
}

export async function backUp(fs: FileSystem, paths: ClaudePaths, file: string, text: string, clock: Clock): Promise<string> {
  const slug = file === settingsFile(paths) ? 'settings' : encodeURIComponent(file)
  const stamp = clock().toISOString().replace(/[:.]/g, '-')
  // Two writes in the same millisecond must not share a backup name.
  for (let n = 0; ; n++) {
    const path = `${backupDir(paths)}/${slug}.${stamp}${n === 0 ? '' : `-${n}`}.json`
    if ((await fs.readText(path)) === null) {
      await fs.writeText(path, text)
      return path
    }
  }
}

function parse(text: string): Json | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function unreadable(file: string): WriteResult {
  return { ok: false, reason: 'unreadable', message: `${file} is not a valid JSON object; it was left untouched.` }
}
