// The only code that writes the Claude Code setup. Every write backs up the previous file first
// and refuses when the file changed since the caller read it.
import { settingsFile, versionOf } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'

export type WriteResult =
  /** `backup` is null when nothing needed writing. */
  | { ok: true; backup: string | null }
  | { ok: false; reason: 'changed' | 'unknown-plugin' | 'unreadable' | 'unknown-backup'; message: string }

export interface PluginToggle {
  id: string
  enabled: boolean
  /** The `settingsVersion` of the inventory the caller showed. */
  settingsVersion: string
}

export interface BackupRestore {
  name: string
  /** The `settingsVersion` of the inventory the caller showed. */
  settingsVersion: string
}

export type Clock = () => Date

const CHANGED = { ok: false, reason: 'changed', message: 'settings.json changed since it was read. Refresh and try again.' } as const

const backupDir = (paths: ClaudePaths) => `${paths.claudeDir}/backups/claude-config-manager`
const BACKUP_NAME = /^settings\.[0-9TZ-]+\.json$/

export async function setPluginEnabled(
  fs: FileSystem,
  paths: ClaudePaths,
  change: PluginToggle,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const text = await fs.readText(settingsFile(paths))
  if (versionOf(text) !== change.settingsVersion) return CHANGED
  let settings: Record<string, any>
  try {
    settings = JSON.parse(text ?? '')
  } catch {
    return { ok: false, reason: 'unreadable', message: 'settings.json is not valid JSON; it was left untouched.' }
  }
  if (!Object.hasOwn(settings.enabledPlugins ?? {}, change.id)) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not in enabledPlugins.` }
  }
  if (settings.enabledPlugins[change.id] === change.enabled) return { ok: true, backup: null }
  settings.enabledPlugins[change.id] = change.enabled
  const backup = await backUp(fs, paths, text ?? '', clock)
  await fs.writeText(settingsFile(paths), JSON.stringify(settings, null, 2) + '\n')
  return { ok: true, backup }
}

/** Backup file names, newest first. */
export async function listBackups(fs: FileSystem, paths: ClaudePaths): Promise<string[]> {
  return (await fs.listEntries(backupDir(paths))).filter((name) => BACKUP_NAME.test(name)).sort().reverse()
}

/** Puts a backup back as settings.json, after backing up the current file. */
export async function restoreBackup(
  fs: FileSystem,
  paths: ClaudePaths,
  restore: BackupRestore,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const { name } = restore
  const text = (await listBackups(fs, paths)).includes(name) ? await fs.readText(`${backupDir(paths)}/${name}`) : null
  if (text === null) return { ok: false, reason: 'unknown-backup', message: `${name} is not a known backup.` }
  const current = await fs.readText(settingsFile(paths))
  if (versionOf(current) !== restore.settingsVersion) return CHANGED
  const backup = await backUp(fs, paths, current ?? '', clock)
  await fs.writeText(settingsFile(paths), text)
  return { ok: true, backup }
}

async function backUp(fs: FileSystem, paths: ClaudePaths, text: string, clock: Clock): Promise<string> {
  const stamp = clock().toISOString().replace(/[:.]/g, '-')
  // Two writes in the same millisecond must not share a backup name.
  for (let n = 0; ; n++) {
    const path = `${backupDir(paths)}/settings.${stamp}${n === 0 ? '' : `-${n}`}.json`
    if ((await fs.readText(path)) === null) {
      await fs.writeText(path, text)
      return path
    }
  }
}
