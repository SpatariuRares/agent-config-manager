// Moves or copies a plugin's on/off value between global and projects, through the versioned writes
// of toggle.ts. To a project: an override there; to global: the global switch.
import { settingsFile, projectSettingsFile, type ProjectScope } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'
import type { Place } from './setup.ts'
import { isKnownPlugin, setPluginEnabled, setProjectPluginState, updateJsonFile, type Clock, type WriteResult } from './toggle.ts'

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
  | { ok: false; reason: string; message: string; backups: string[]; partial: boolean }

export async function movePlugin(fs: FileSystem, paths: ClaudePaths, move: PluginMove, clock: Clock): Promise<PluginMoveResult> {
  const { id, from, to, versions } = move
  if (from.project === to.project && (from.project === null || from.scope === to.scope)) {
    return { ok: false, reason: 'same-place', message: `${id} is already there.`, backups: [], partial: false }
  }
  if (to.project !== null) {
    // Like every other class, a move never overwrites what the destination already has.
    const file = projectSettingsFile(to.project, scopeOf(to))
    let existing: unknown
    try {
      existing = JSON.parse((await fs.readText(file)) ?? '{}')?.enabledPlugins?.[id]
    } catch {
      existing = undefined
    }
    if (typeof existing === 'boolean') {
      return {
        ok: false,
        reason: 'exists',
        message: `${file} already sets ${id} (${existing ? 'on' : 'off'}). Clear it first, or change it there.`,
        backups: [],
        partial: false
      }
    }
  }
  const written =
    to.project === null
      ? await setGlobalPlugin(fs, paths, id, move.enabled, versions[settingsFile(paths)] ?? '', clock)
      : await setProjectPluginState(
          fs,
          paths,
          { id, project: to.project, scope: scopeOf(to), enabled: move.enabled, version: versions[projectSettingsFile(to.project, scopeOf(to))] ?? '' },
          clock
        )
  if (!written.ok) return { ok: false, reason: written.reason, message: written.message, backups: [], partial: false }
  const backups = written.backup === null ? [] : [written.backup]
  if (move.copy) return { ok: true, backups }

  const cleared =
    from.project === null
      ? await setPluginEnabled(fs, paths, { id, enabled: false, settingsVersion: versions[settingsFile(paths)] ?? '' }, clock)
      : await setProjectPluginState(
          fs,
          paths,
          { id, project: from.project, scope: scopeOf(from), enabled: null, version: versions[projectSettingsFile(from.project, scopeOf(from))] ?? '' },
          clock
        )
  if (!cleared.ok) return { ok: false, reason: cleared.reason, message: cleared.message, backups, partial: true }
  return { ok: true, backups: cleared.backup === null ? backups : [...backups, cleared.backup] }
}

/** Sets the global value, adding the plugin to enabledPlugins when this setup knows it but does not list it. */
async function setGlobalPlugin(
  fs: FileSystem,
  paths: ClaudePaths,
  id: string,
  enabled: boolean,
  version: string,
  clock: Clock
): Promise<WriteResult> {
  if (!(await isKnownPlugin(fs, paths, id, {}))) {
    return { ok: false, reason: 'unknown-plugin', message: `${id} is not a plugin of this setup.` }
  }
  return updateJsonFile(
    fs,
    paths,
    {
      project: null,
      file: settingsFile(paths),
      version,
      edit: (json) => {
        json.enabledPlugins ??= {}
        if (typeof json.enabledPlugins !== 'object' || Array.isArray(json.enabledPlugins)) {
          return 'Its enabledPlugins is not an object; it was left untouched.'
        }
        json.enabledPlugins[id] = enabled
      }
    },
    clock
  )
}

const scopeOf = (place: Place): ProjectScope => (place.scope === 'project' ? 'project' : 'local')
