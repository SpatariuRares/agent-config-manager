// The only code that writes the Claude Code settings files. Every write is a guarded change (../../core/guarded-change.ts):
// it refuses a file that changed since the caller read it, backs the file up first, then writes it.
import type { BackupStore } from '../../core/backups.ts'
import { guardedChange, unreadable, versionRefusal, type ChangeDeps } from '../../core/guarded-change.ts'
import { isObject, parseObject, type Json } from '../../core/json.ts'
import type { Clock, FileSystem } from '../../core/ports.ts'
import { isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile, type ProjectScope } from './inventory.ts'
import type { ClaudePaths } from './ports.ts'

export type { Clock } from '../../core/ports.ts'

export type WriteResult =
  /** `backup` is null when nothing needed writing. */
  | { ok: true; backup: string | null }
  | { ok: false; reason: string; message: string }

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

/**
 * Claude Code's backups stay where this app always kept them, ~/.claude/backups/claude-config-manager, so every
 * backup made before the multi-agent change is still listed and restorable. `settings` names the user settings file.
 */
export const backupDir = (paths: ClaudePaths) => `${paths.claudeDir}/backups/claude-config-manager`
export const claudeBackups = (paths: ClaudePaths): BackupStore => ({ dir: backupDir(paths), aliases: { settings: settingsFile(paths) } })

/** The guarded change deps for Claude Code's files (JSON edits only: no CLI runs from here). */
const changeDeps = (fs: FileSystem, paths: ClaudePaths, clock: Clock): ChangeDeps => ({ fs, store: claudeBackups(paths), clock })

/** One guarded JSON edit of `file`, as a WriteResult. */
async function writeJson(fs: FileSystem, paths: ClaudePaths, file: string, version: string, edit: (json: Json) => string | void, clock: Clock): Promise<WriteResult> {
  const written = await guardedChange(changeDeps(fs, paths, clock), { files: [file], versions: { [file]: version }, steps: [{ effect: { kind: 'json', file, edit } }] })
  if (!written.ok) return { ok: false, reason: written.reason, message: written.message }
  return { ok: true, backup: written.backups.get(file) ?? null }
}

/** The file parsed after the version check (a missing file as `missing`), or the refusal: `changed`, or `unreadable`. */
async function readChecked(fs: FileSystem, file: string, version: string, missing: Json | null): Promise<{ ok: true; json: Json } | (WriteResult & { ok: false })> {
  const stale = await versionRefusal({ fs }, [file], { [file]: version })
  if (stale !== null) return stale
  const text = await fs.readText(file)
  const json = text === null ? missing : parseObject(text)
  return json === null ? unreadable(file) : { ok: true, json }
}

export async function setPluginEnabled(
  fs: FileSystem,
  paths: ClaudePaths,
  change: PluginToggle,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = settingsFile(paths)
  const read = await readChecked(fs, file, change.settingsVersion, null)
  if (!read.ok) return read
  if (!Object.hasOwn(read.json.enabledPlugins ?? {}, change.id)) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not in enabledPlugins.` }
  }
  return writeJson(fs, paths, file, change.settingsVersion, (settings) => void (settings.enabledPlugins[change.id] = change.enabled), clock)
}

/** Sets, or with `enabled: null` removes, a plugin's value in one project's settings file. A missing file is created. */
export async function setProjectPluginState(
  fs: FileSystem,
  paths: ClaudePaths,
  change: ProjectPluginChange,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const file = projectSettingsFile(change.project, change.scope)
  const refused = await projectFileRefusal(fs, paths, change.project, file)
  if (refused !== null) return refused
  const read = await readChecked(fs, file, change.version, {})
  if (!read.ok) return read
  if (!isObject(read.json.enabledPlugins ?? {})) return unreadable(file)
  if (!(await isKnownPlugin(fs, paths, change.id, read.json))) {
    return { ok: false, reason: 'unknown-plugin', message: `${change.id} is not a plugin of this setup.` }
  }
  return writeJson(
    fs,
    paths,
    file,
    change.version,
    (settings) => {
      const plugins: Json = settings.enabledPlugins ?? {}
      if (change.enabled === null && !Object.hasOwn(plugins, change.id)) return
      if (change.enabled === null) delete plugins[change.id]
      else plugins[change.id] = change.enabled
      settings.enabledPlugins = plugins
    },
    clock
  )
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
 * then one guarded JSON edit (version check, backup, 2-space JSON with a trailing newline). A missing file is created.
 */
export async function updateJsonFile(
  fs: FileSystem,
  paths: ClaudePaths,
  change: JsonFileEdit,
  clock: Clock = () => new Date()
): Promise<WriteResult> {
  const refused = await writeRefusal(fs, paths, change.project, change.file)
  if (refused !== null) return refused
  return writeJson(fs, paths, change.file, change.version, change.edit, clock)
}

/** Why this app must not write `file` as a file of `project` (null: the user settings file), or null when it may. */
export async function writeRefusal(fs: FileSystem, paths: ClaudePaths, project: string | null, file: string): Promise<WriteResult & { ok: false } | null> {
  if (project === null) return file === settingsFile(paths) ? null : { ok: false, reason: 'unknown-project', message: `${file} is not the user settings file.` }
  return projectFileRefusal(fs, paths, project, file)
}

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
