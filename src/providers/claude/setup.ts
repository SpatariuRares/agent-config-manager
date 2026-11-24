// The whole setup per scope: every class globally and in each known project. Read-only.
import type { EntryKind } from '../../core/entries.ts'
import { sameFolder } from '../../core/paths.ts'
import type { FileSystem } from '../../core/ports.ts'
import {
  hookEntries,
  isObject,
  isUserSettingsFile,
  mcpServersOf,
  projectSettingsFile,
  readAgents,
  readInventory,
  readSkills,
  settingsFile,
  versionOf,
  type HookEntry,
  type Inventory,
  type Json,
  type McpServer,
  type ProjectScope,
  type Skill
} from './inventory.ts'
import type { ClaudePaths } from './ports.ts'

export { sameFolder } from '../../core/paths.ts'
export type { EntryKind } from '../../core/entries.ts'

export type Scope = 'user' | ProjectScope

/** Where an item lives: global (project null, scope user) or one project's team or only-me file. */
export interface Place {
  project: string | null
  scope: Scope
}

/** A skill folder or an agent file. */
export interface Entry extends Skill, Place {
  kind: EntryKind
  /** The skill folder or the agent file: what moves. */
  entry: string
  /** The symlink text when the entry is a symlink. */
  link: string | null
}

export interface ScopedMcp extends McpServer, Place {
  /** The file that holds it: ~/.claude.json (user and local) or <project>/.mcp.json. */
  file: string
  config: Json
}

export interface ScopedHook extends HookEntry, Place {
  file: string
}

export interface Setup {
  inventory: Inventory
  /** Plugin ids listed in the user settings' enabledPlugins. */
  globalPlugins: string[]
  entries: Entry[]
  mcpServers: ScopedMcp[]
  hooks: ScopedHook[]
  /** versionOf() of every file read, plus the project files a change could create ('' = missing). */
  versions: Record<string, string>
  problems: string[]
}

/** The folder of a class: ~/.claude/<kind> globally, <project>/.claude/<kind> in a project. */
export const entryDir = (paths: ClaudePaths, kind: EntryKind, project: string | null) =>
  project === null ? `${paths.claudeDir}/${kind}` : `${project}/.claude/${kind}`

export const mcpFile = (project: string) => `${project}/.mcp.json`

/** The settings file of a place: user settings, or a project's team or only-me file. */
export const placeFile = (paths: ClaudePaths, place: Place) =>
  place.project === null ? settingsFile(paths) : projectSettingsFile(place.project, place.scope === 'project' ? 'project' : 'local')

export async function readSetup(fs: FileSystem, paths: ClaudePaths): Promise<Setup> {
  const inventory = await readInventory(fs, paths)
  const problems = [...inventory.problems]
  const versions = { ...inventory.versions }
  const read = async (file: string, report: boolean): Promise<Json> => {
    const text = await fs.readText(file)
    versions[file] = versionOf(text)
    if (text === null) return {}
    try {
      const value = JSON.parse(text)
      if (isObject(value)) return value
      if (report) problems.push(`${file}: expected a JSON object`)
    } catch (error) {
      if (report) problems.push(`${file}: ${(error as Error).message}`)
    }
    return {}
  }

  // readInventory already reported problems in these three files.
  const settings = await read(settingsFile(paths), false)
  const userConfig = await read(paths.userConfigFile, false)
  const entries: Entry[] = [...(await readEntries(fs, paths, null))]
  const mcpServers: ScopedMcp[] = scopedMcp(userConfig.mcpServers, { project: null, scope: 'user' }, paths.userConfigFile)
  const hooks: ScopedHook[] = scopedHooks(settings, { project: null, scope: 'user' }, settingsFile(paths))

  for (const project of inventory.projects) {
    entries.push(...(await readEntries(fs, paths, project)))
    const mcp = await read(mcpFile(project), true)
    mcpServers.push(...scopedMcp(mcp.mcpServers, { project, scope: 'project' }, mcpFile(project)))
    const local = isObject(userConfig.projects?.[project]) ? userConfig.projects[project].mcpServers : undefined
    mcpServers.push(...scopedMcp(local, { project, scope: 'local' }, paths.userConfigFile))
    for (const scope of ['project', 'local'] as const) {
      const file = projectSettingsFile(project, scope)
      if (await isUserSettingsFile(fs, paths, file)) continue
      hooks.push(...scopedHooks(await read(file, false), { project, scope }, file))
    }
  }
  for (const entry of entries) versions[entry.path] = versionOf(await fs.readText(entry.path))

  return {
    inventory,
    globalPlugins: Object.keys(isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}),
    entries,
    mcpServers,
    hooks,
    versions,
    problems
  }
}

async function readEntries(fs: FileSystem, paths: ClaudePaths, project: string | null): Promise<Entry[]> {
  const place: Place = { project, scope: project === null ? 'user' : 'project' }
  const entries: Entry[] = []
  for (const kind of ['skills', 'agents'] as const) {
    const dir = entryDir(paths, kind, project)
    // The home folder listed as a project: its .claude folders are the global ones.
    if (project !== null && (await sameFolder(fs, dir, entryDir(paths, kind, null)))) continue
    const found: Skill[] = kind === 'skills' ? await readSkills(fs, dir) : await readAgents(fs, dir)
    for (const item of found) {
      const entry = kind === 'skills' ? item.path.slice(0, -'/SKILL.md'.length) : item.path
      entries.push({ ...item, ...place, kind, entry, link: await fs.linkTarget(entry) })
    }
  }
  return entries
}

function scopedMcp(map: unknown, place: Place, file: string): ScopedMcp[] {
  return mcpServersOf(map).map((server) => ({ ...server, ...place, file }))
}

function scopedHooks(settings: Json, place: Place, file: string): ScopedHook[] {
  return hookEntries(settings).map((hook) => ({ ...hook, ...place, file }))
}
