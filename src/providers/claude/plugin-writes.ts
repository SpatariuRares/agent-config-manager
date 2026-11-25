// The only code that writes plugin on/off values into Claude Code's settings files: the global switch, a project
// override (set or cleared), and a move or copy of a value between global and projects. Every write is a guarded
// change (toolkit guardedChange): it refuses a file that changed since the view read it, backs it up, then writes it.
// A move is one guarded change of both files, so a stale origin writes nothing.
import { guardedChange, isObject, parseObject, unreadable, versionRefusal, type Clock, type FileSystem, type Json } from '../toolkit.ts'
import { claudeBackups, projectSettingsFile, settingsFile, type ClaudePaths, type ProjectScope } from './inventory.ts'
import { writeRefusal, type Place } from './setup.ts'

export type WriteResult =
  /** `backup` is null when nothing needed writing. */
  | { ok: true; backup: string | null }
  | { ok: false; reason: string; message: string }

export interface ProjectPluginChange {
  id: string
  project: string
  scope: ProjectScope
  /** null removes the override, so the project follows the global value. */
  enabled: boolean | null
  /** The view's `versions` entry for that project file. */
  version: string
}

/** One guarded JSON edit of `file`, as a WriteResult. */
async function writeJson(fs: FileSystem, paths: ClaudePaths, file: string, version: string, edit: (json: Json) => string | void, clock: Clock): Promise<WriteResult> {
  const written = await guardedChange({ fs, store: claudeBackups(paths), clock }, { files: [file], versions: { [file]: version }, steps: [{ effect: { kind: 'json', file, edit } }] })
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

/** Turns a plugin listed in the user settings' enabledPlugins on or off. */
export async function setPluginEnabled(fs: FileSystem, paths: ClaudePaths, id: string, enabled: boolean, version: string, clock: Clock): Promise<WriteResult> {
  const file = settingsFile(paths)
  const read = await readChecked(fs, file, version, null)
  if (!read.ok) return read
  if (!Object.hasOwn(read.json.enabledPlugins ?? {}, id)) {
    return { ok: false, reason: 'unknown-plugin', message: `${id} is not in enabledPlugins.` }
  }
  return writeJson(fs, paths, file, version, (settings) => void (settings.enabledPlugins[id] = enabled), clock)
}

/** Sets, or with `enabled: null` removes, a plugin's value in one project's settings file. A missing file is created. */
export async function setProjectPluginState(fs: FileSystem, paths: ClaudePaths, change: ProjectPluginChange, clock: Clock): Promise<WriteResult> {
  const file = projectSettingsFile(change.project, change.scope)
  const refused = await writeRefusal(fs, paths, change.project, file)
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

/** A plugin this setup knows: in the user settings, installed, or already in the file being changed. */
async function isKnownPlugin(fs: FileSystem, paths: ClaudePaths, id: string, file: Json): Promise<boolean> {
  const user = parseObject((await fs.readText(settingsFile(paths))) ?? '{}') ?? {}
  const installed = parseObject((await fs.readText(`${paths.claudeDir}/plugins/installed_plugins.json`)) ?? '{}') ?? {}
  return [user.enabledPlugins, installed.plugins, file.enabledPlugins].some((map) => isObject(map) && Object.hasOwn(map, id))
}

export interface PluginMove {
  id: string
  from: Place
  to: Place
  /** The value to write at the destination. */
  enabled: boolean
  /** Keep the origin as it is (copy) instead of turning it off (global) or clearing it (override). */
  copy: boolean
  versions: Record<string, string>
}

export type PluginMoveResult =
  | { ok: true; backups: string[] }
  /** `partial` when the destination was written but the origin was not; the message names the backups. */
  | { ok: false; reason: string; message: string }

/**
 * Moves or copies a plugin's on/off value between global and projects. To a project: an override there; to global:
 * the global switch. One guarded change of one or two files (the destination, then for a move the origin, turned
 * off globally or its override cleared): every file is version checked before either is written, both are backed up
 * first, and a failed second write is `partial`, naming the backups.
 */
export async function movePlugin(fs: FileSystem, paths: ClaudePaths, move: PluginMove, clock: Clock): Promise<PluginMoveResult> {
  const { id, from, to, versions } = move
  const refuse = (reason: string, message: string): PluginMoveResult => ({ ok: false, reason, message })
  if (from.project === to.project && (from.project === null || from.scope === to.scope)) return refuse('same-place', `${id} is already there.`)
  const places = move.copy ? [to] : [to, from]
  const files = places.map((place) => placeSettings(paths, place))
  for (const [i, place] of places.entries()) {
    if (place.project === null) continue
    const refused = await writeRefusal(fs, paths, place.project, files[i])
    if (refused !== null) return refuse(refused.reason, refused.message)
  }
  const stale = await versionRefusal({ fs }, files, versions)
  if (stale !== null) return refuse(stale.reason, stale.message)

  // Everything a write could refuse is checked here, before either file is written: only a write that fails can
  // leave a move partial.
  const read: Json[] = []
  for (const file of files) {
    const text = await fs.readText(file)
    const json = text === null ? {} : parseObject(text)
    if (json === null || !isObject(json.enabledPlugins ?? {})) return refuse('unreadable', unreadable(file).message)
    read.push(json)
  }
  const [toFile, fromFile] = files
  const [target, origin] = read
  const existing: unknown = target.enabledPlugins?.[id]
  if (to.project !== null && typeof existing === 'boolean') {
    // Like every other class, a move never overwrites what the destination already has.
    return refuse('exists', `${toFile} already sets ${id} (${existing ? 'on' : 'off'}). Clear it first, or change it there.`)
  }
  if (!(await isKnownPlugin(fs, paths, id, to.project === null ? {} : target))) return refuse('unknown-plugin', `${id} is not a plugin of this setup.`)
  if (origin !== undefined && from.project === null && !Object.hasOwn(origin.enabledPlugins ?? {}, id)) {
    return refuse('unknown-plugin', `${id} is not in enabledPlugins.`)
  }

  const set = { effect: { kind: 'json' as const, file: toFile, edit: (json: Json) => void ((json.enabledPlugins ??= {})[id] = move.enabled) } }
  const clear = {
    effect: {
      kind: 'json' as const,
      file: fromFile,
      edit: (json: Json) => {
        if (from.project === null) json.enabledPlugins[id] = false
        else if (isObject(json.enabledPlugins)) delete json.enabledPlugins[id]
      }
    }
  }
  const written = await guardedChange({ fs, store: claudeBackups(paths), clock }, { files, versions, steps: move.copy ? [set] : [set, clear] })
  if (!written.ok) return { ok: false, reason: written.reason, message: written.message }
  return { ok: true, backups: [...written.backups.values()] }
}

/** The settings file of a place: the user settings globally, else the project's team or only-me file. */
const placeSettings = (paths: ClaudePaths, place: Place) => (place.project === null ? settingsFile(paths) : projectSettingsFile(place.project, scopeOf(place)))

const scopeOf = (place: Place): ProjectScope => (place.scope === 'project' ? 'project' : 'local')
