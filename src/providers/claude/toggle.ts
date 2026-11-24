// The only code that writes the Claude Code settings files. Every write backs up the previous file first
// and refuses when the file changed since the caller read it (the shared versioned write in core).
import * as store from '../../core/backups.ts'
import type { BackupStore } from '../../core/backups.ts'
import { isObject, parseObject, versionOf, type Json } from '../../core/json.ts'
import { CHANGED, editJsonFile, replaceJson, unreadable, type WriteResult } from '../../core/json-write.ts'
import type { Clock, FileSystem } from '../../core/ports.ts'
import { isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile, type ProjectScope } from './inventory.ts'
import type { ClaudePaths } from './ports.ts'

export type { WriteResult } from '../../core/json-write.ts'
export type { Clock } from '../../core/ports.ts'

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

/**
 * Claude Code's backups stay where this app always kept them, ~/.claude/backups/claude-config-manager, so every
 * backup made before the multi-agent change is still listed and restorable. `settings` names the user settings file.
 */
export const backupDir = (paths: ClaudePaths) => `${paths.claudeDir}/backups/claude-config-manager`
export const claudeBackups = (paths: ClaudePaths): BackupStore => ({ dir: backupDir(paths), aliases: { settings: settingsFile(paths) } })

export async function setPluginEnabled(
  fs: FileSystem,
  paths: ClaudePaths,
  change: PluginToggle,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = settingsFile(paths)
  const text = await fs.readText(file)
  if (versionOf(text) !== change.settingsVersion) return CHANGED
  const settings = parseObject(text ?? '')
  if (settings === null) return unreadable(file)
  if (!Object.hasOwn(settings.enabledPlugins ?? {}, change.id)) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not in enabledPlugins.` }
  }
  if (settings.enabledPlugins[change.id] === change.enabled) return { ok: true, backup: null }
  settings.enabledPlugins[change.id] = change.enabled
  return replaceJson(fs, claudeBackups(paths), file, text ?? '', settings, clock)
}

/** Sets, or with `enabled: null` removes, a plugin's value in one project's settings file. */
export async function setProjectPluginState(
  fs: FileSystem,
  paths: ClaudePaths,
  change: ProjectPluginChange,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = projectSettingsFile(change.project, change.scope)
  const refused = await projectFileRefusal(fs, paths, change.project, file)
  if (refused !== null) return refused
  const text = await fs.readText(file)
  if (versionOf(text) !== change.version) return CHANGED
  // A missing project file is created.
  const settings = text === null ? {} : parseObject(text)
  if (settings === null || !isObject(settings.enabledPlugins ?? {})) return unreadable(file)
  if (!(await isKnownPlugin(fs, paths, change.id, settings))) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not a plugin of this setup.` }
  }

  const plugins: Json = settings.enabledPlugins ?? {}
  if (change.enabled === null ? !Object.hasOwn(plugins, change.id) : plugins[change.id] === change.enabled) {
    return { ok: true, backup: null }
  }
  if (change.enabled === null) delete plugins[change.id]
  else plugins[change.id] = change.enabled
  settings.enabledPlugins = plugins
  return replaceJson(fs, claudeBackups(paths), file, text ?? '{}\n', settings, clock)
}

/** Backup file names, newest first. */
export const listBackups = (fs: FileSystem, paths: ClaudePaths): Promise<string[]> => store.listBackups(fs, claudeBackups(paths))

/** The file a backup belongs to. */
export const backupTarget = (paths: ClaudePaths, name: string): string | null => store.backupTarget(claudeBackups(paths), name)

/** Puts a backup back in place of the file it came from, after backing up that file. */
export async function restoreBackup(
  fs: FileSystem,
  paths: ClaudePaths,
  restore: BackupRestore,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const { name } = restore
  return store.restoreFile(fs, claudeBackups(paths), { name, version: restore.settingsVersion }, clock, async (target) => {
    if (target === paths.userConfigFile) {
      return {
        ok: false,
        reason: 'claude-owned',
        message: `Claude Code rewrites ${target} all the time, so it is never written here. To go back, quit Claude Code and copy ${backupDir(paths)}/${name} over it by hand.`
      }
    }
    if (target === settingsFile(paths)) return null
    const project = /^(.+)\/(?:\.claude\/settings(?:\.local)?\.json|\.mcp\.json)$/.exec(target)?.[1] ?? ''
    return projectFileRefusal(fs, paths, project, target)
  })
}

export interface JsonFileEdit {
  /** The project the file belongs to; null for the user settings file. */
  project: string | null
  file: string
  /** The inventory's version of the file ('' = it was missing). */
  version: string
  /** Changes the parsed file in place; returns a refusal message to write nothing. */
  edit: (json: Json) => string | void
}

/**
 * The general versioned write: refuses unknown projects and the user settings file through a project path,
 * refuses a file that changed since it was read, backs it up, then writes 2-space JSON with a trailing newline.
 * A missing file is created.
 */
export async function updateJsonFile(
  fs: FileSystem,
  paths: ClaudePaths,
  change: JsonFileEdit,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const { file } = change
  if (change.project === null && file !== settingsFile(paths)) {
    return { ok: false, reason: 'unknown-project', message: `${file} is not the user settings file.` }
  }
  if (change.project !== null) {
    const refused = await projectFileRefusal(fs, paths, change.project, file)
    if (refused !== null) return refused
  }
  return editJsonFile(fs, claudeBackups(paths), change, clock)
}

export const backUp = (fs: FileSystem, paths: ClaudePaths, file: string, text: string, clock: Clock): Promise<string> =>
  store.backUp(fs, claudeBackups(paths), file, text, clock)

/** Project writes only go to a project Claude Code still lists, and never to the user settings file. */
async function projectFileRefusal(fs: FileSystem, paths: ClaudePaths, project: string, file: string): Promise<WriteResult & { ok: false } | null> {
  if (!(await knownProjects(fs, paths)).includes(project)) {
    return { ok: false, reason: 'unknown-project', message: `${project || file} is not a project Claude Code knows.` }
  }
  if (await isUserSettingsFile(fs, paths, file)) {
    return {
      ok: false,
      reason: 'unknown-project',
      message: `${project} is your home folder: its team settings are the global settings. Use "Only me" or the global switch.`
    }
  }
  return null
}

/** A plugin this setup knows: in the user settings, installed, or already in the file being changed. */
export async function isKnownPlugin(fs: FileSystem, paths: ClaudePaths, id: string, file: Json): Promise<boolean> {
  const user = parseObject((await fs.readText(settingsFile(paths))) ?? '{}') ?? {}
  const installed = parseObject((await fs.readText(`${paths.claudeDir}/plugins/installed_plugins.json`)) ?? '{}') ?? {}
  return [user.enabledPlugins, installed.plugins, file.enabledPlugins].some((map) => isObject(map) && Object.hasOwn(map, id))
}
