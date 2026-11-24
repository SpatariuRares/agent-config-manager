// Reads the Claude Code setup into one read-only model. Never writes.
import type { ClaudePaths, FileSystem } from './ports.ts'

export interface PluginContributions {
  skills: string[]
  agents: string[]
  commands: string[]
  /** Hook event names, e.g. PreToolUse. */
  hooks: string[]
  mcpServers: string[]
}

export type ProjectScope = 'project' | 'local'

/** A plugin's on/off value set in one project's settings file. */
export interface Override {
  project: string
  /** project: .claude/settings.json (shared); local: .claude/settings.local.json (only me). */
  scope: ProjectScope
  enabled: boolean
}

/** One install record; a plugin can be installed for the user and for single projects. */
export interface Install {
  scope: string
  project: string | null
}

export interface Plugin {
  id: string
  name: string
  marketplace: string
  /** The global (user settings) value. */
  enabled: boolean
  /** Installed version, or null when the plugin is listed in settings but not installed. */
  version: string | null
  /** Ids of plugins with the same name from other marketplaces. */
  sharesNameWith: string[]
  contributes: PluginContributions
  overrides: Override[]
  installs: Install[]
}

export interface Skill {
  name: string
  description: string
  path: string
}

export type Agent = Skill

export interface McpServer {
  name: string
  transport: string
  target: string
}

export interface Hook {
  event: string
  matcher: string
  command: string
}

export interface Inventory {
  plugins: Plugin[]
  skills: Skill[]
  agents: Agent[]
  mcpServers: McpServer[]
  hooks: Hook[]
  /** Files that exist but could not be read; the rest of the inventory still loads. */
  problems: string[]
  /** Identifies the settings.json content this inventory was read from; '' when the file is missing. */
  settingsVersion: string
  /** Projects Claude Code has been used in that still exist, sorted. */
  projects: string[]
  /** versionOf() of every settings file read, by absolute path. */
  versions: Record<string, string>
}

export type Json = Record<string, any>

export async function readInventory(fs: FileSystem, paths: ClaudePaths): Promise<Inventory> {
  const problems: string[] = []
  const settingsText = await fs.readText(settingsFile(paths))
  const settings = await readJson(fs, settingsFile(paths), problems)
  const userConfig = await readJson(fs, paths.userConfigFile, problems)
  const installed = await readJson(fs, `${paths.claudeDir}/plugins/installed_plugins.json`, problems)
  const versions: Record<string, string> = { [settingsFile(paths)]: versionOf(settingsText) }
  const projects = await readProjects(fs, userConfig)
  const overrides: (Override & { id: string })[] = []
  for (const project of projects) {
    for (const scope of ['project', 'local'] as const) {
      const file = projectSettingsFile(project, scope)
      // For the home folder (however it is spelled), the "project" file is the user settings file itself.
      if (await isUserSettingsFile(fs, paths, file)) continue
      versions[file] = versionOf(await fs.readText(file))
      for (const [id, enabled] of Object.entries((await readJson(fs, file, problems)).enabledPlugins ?? {})) {
        overrides.push({ id, project, scope, enabled: enabled === true })
      }
    }
  }

  return {
    plugins: await readPlugins(fs, settings, installed, overrides, problems),
    skills: await readSkills(fs, `${paths.claudeDir}/skills`),
    agents: await readAgents(fs, `${paths.claudeDir}/agents`),
    mcpServers: readMcpServers(userConfig),
    hooks: readHooks(settings),
    problems,
    settingsVersion: versionOf(settingsText),
    projects,
    versions
  }
}

export const settingsFile = (paths: ClaudePaths) => `${paths.claudeDir}/settings.json`

export const projectSettingsFile = (project: string, scope: ProjectScope) =>
  `${project}/.claude/${scope === 'local' ? 'settings.local.json' : 'settings.json'}`

/** Whether a plugin runs in a project: local beats project beats the global value. */
export function effectiveState(plugin: Plugin, project: string): { enabled: boolean; from: 'user' | ProjectScope } {
  for (const scope of ['local', 'project'] as const) {
    const override = plugin.overrides.find((o) => o.project === project && o.scope === scope)
    if (override) return { enabled: override.enabled, from: scope }
  }
  return { enabled: plugin.enabled, from: 'user' }
}

/** Whether `file` is the user settings file, comparing real paths so aliases and symlinks count. */
export async function isUserSettingsFile(fs: FileSystem, paths: ClaudePaths, file: string): Promise<boolean> {
  const split = (path: string) => [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)]
  const [dir, name] = split(file)
  const [userDir, userName] = split(settingsFile(paths))
  // The file itself may be a link to the user settings (whatever its name), or sit in a folder that is one.
  const realFile = await fs.realPath(file)
  if (realFile !== null && realFile === (await fs.realPath(settingsFile(paths)))) return true
  if (name !== userName) return false
  const real = await fs.realPath(dir)
  return real !== null && real === (await fs.realPath(userDir))
}

/** Projects Claude Code has been used in that still exist. */
export async function knownProjects(fs: FileSystem, paths: ClaudePaths): Promise<string[]> {
  return readProjects(fs, await readJson(fs, paths.userConfigFile, []))
}

async function readProjects(fs: FileSystem, userConfig: Json): Promise<string[]> {
  const projects: string[] = []
  for (const path of Object.keys(isObject(userConfig.projects) ? userConfig.projects : {})) {
    if (path.startsWith('/') && (await fs.realPath(path)) !== null) projects.push(path)
  }
  return projects.sort()
}

/** FNV-1a of the file text: cheap, stable, and enough to notice that the file changed. */
export function versionOf(text: string | null): string {
  if (text === null) return ''
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}-${hash.toString(16)}`
}

async function readJson(fs: FileSystem, path: string, problems: string[]): Promise<Json> {
  const text = await fs.readText(path)
  if (text === null) return {}
  try {
    const value = JSON.parse(text)
    if (isObject(value)) return value
    problems.push(`${path}: expected a JSON object`)
    return {}
  } catch (error) {
    problems.push(`${path}: ${(error as Error).message}`)
    return {}
  }
}

async function readPlugins(
  fs: FileSystem,
  settings: Json,
  installed: Json,
  overrides: (Override & { id: string })[],
  problems: string[]
): Promise<Plugin[]> {
  const ids = [...new Set([...Object.keys(settings.enabledPlugins ?? {}), ...overrides.map((o) => o.id)])]
  const nameOf = (id: string) => (id.lastIndexOf('@') === -1 ? id : id.slice(0, id.lastIndexOf('@')))
  const plugins: Plugin[] = []
  for (const id of ids) {
    const at = id.lastIndexOf('@')
    const records: Json[] = (Array.isArray(installed.plugins?.[id]) ? installed.plugins[id] : []).filter(isObject)
    const install = records.find((record) => record.scope === 'user') ?? records[0]
    plugins.push({
      id,
      name: nameOf(id),
      marketplace: at === -1 ? '' : id.slice(at + 1),
      enabled: settings.enabledPlugins?.[id] === true,
      version: install?.version ?? null,
      sharesNameWith: ids.filter((other) => other !== id && nameOf(other) === nameOf(id)).sort(),
      contributes: install?.installPath
        ? await readContributions(fs, install.installPath, problems)
        : { skills: [], agents: [], commands: [], hooks: [], mcpServers: [] },
      overrides: overrides.filter((o) => o.id === id).map(({ project, scope, enabled }) => ({ project, scope, enabled })),
      installs: records.map((record) => ({ scope: String(record.scope ?? 'user'), project: record.projectPath ?? null }))
    })
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id))
}

async function readContributions(fs: FileSystem, root: string, problems: string[]): Promise<PluginContributions> {
  const manifest = await readJson(fs, `${root}/.claude-plugin/plugin.json`, problems)
  // plugin.json may point at extra component paths (a string or a list); they add to the default folders.
  // Only paths inside the plugin folder count: no absolute paths, no `..`.
  const inside = (path: unknown): path is string =>
    typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..')
  const resolve = (path: string) => `${root}/${path.replace(/^\.\//, '').replace(/\/$/, '')}`
  const at = (key: string, fallback: string): string[] => {
    const value = manifest[key]
    const declared: unknown[] = Array.isArray(value) ? value : [value]
    return [fallback, ...declared.filter(inside)].map(resolve)
  }
  const inline = async (key: string, file: string): Promise<Json> => {
    const value = manifest[key]
    if (isObject(value)) return value
    return readJson(fs, resolve(inside(value) ? value : file), problems)
  }
  const hooksFile = await inline('hooks', 'hooks/hooks.json')
  const mcpFile = await inline('mcpServers', '.mcp.json')
  const mcpDefault = isObject(manifest.mcpServers) ? await readJson(fs, `${root}/.mcp.json`, problems) : {}
  const keysOf = (value: unknown) => (isObject(value) ? Object.keys(value) : [])

  return {
    skills: unique(await skillNames(fs, at('skills', 'skills'))),
    agents: unique((await markdownFiles(fs, at('agents', 'agents'))).map(({ name, path, text }) => describe(name, path, text).name)),
    commands: unique((await markdownFiles(fs, at('commands', 'commands'))).map(({ name }) => name)),
    hooks: unique(keysOf('hooks' in hooksFile ? hooksFile.hooks : hooksFile).filter((key) => key !== 'description')),
    // .mcp.json is written both with and without the mcpServers wrapper.
    mcpServers: unique([mcpFile, mcpDefault].flatMap((file) => keysOf('mcpServers' in file ? file.mcpServers : file)))
  }
}

/** A path is either one skill folder (it holds SKILL.md) or a folder of skill folders. */
async function skillNames(fs: FileSystem, dirs: string[]): Promise<string[]> {
  const names: string[] = []
  for (const dir of dirs) {
    const own = await fs.readText(`${dir}/SKILL.md`)
    if (own !== null) names.push(describe(dir.split('/').pop() ?? dir, dir, own).name)
    else names.push(...(await readSkills(fs, dir)).map((skill) => skill.name))
  }
  return names
}

/** A path is either one .md file or a folder of .md files. */
async function markdownFiles(fs: FileSystem, paths: string[]): Promise<{ name: string; path: string; text: string }[]> {
  const files: { name: string; path: string; text: string }[] = []
  for (const path of paths) {
    const candidates = path.endsWith('.md')
      ? [path]
      : (await fs.listEntries(path)).filter((entry) => entry.endsWith('.md')).map((entry) => `${path}/${entry}`)
    for (const file of candidates) {
      const text = await fs.readText(file)
      if (text !== null) files.push({ name: (file.split('/').pop() ?? file).slice(0, -3), path: file, text })
    }
  }
  return files
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

/** Skills in a folder of skill folders, each holding SKILL.md. */
export async function readSkills(fs: FileSystem, dir: string): Promise<Skill[]> {
  const skills: Skill[] = []
  for (const entry of await fs.listEntries(dir)) {
    const path = `${dir}/${entry}/SKILL.md`
    const text = await fs.readText(path)
    if (text !== null) skills.push(describe(entry, path, text))
  }
  return sortByName(skills)
}

/** Agents in a folder of .md files. */
export async function readAgents(fs: FileSystem, dir: string): Promise<Agent[]> {
  const agents: Agent[] = []
  for (const entry of await fs.listEntries(dir)) {
    if (!entry.endsWith('.md')) continue
    const path = `${dir}/${entry}`
    const text = await fs.readText(path)
    if (text !== null) agents.push(describe(entry.slice(0, -3), path, text))
  }
  return sortByName(agents)
}

function readMcpServers(userConfig: Json): McpServer[] {
  return mcpServersOf(userConfig.mcpServers).map(({ name, transport, target }) => ({ name, transport, target }))
}

/** The servers of one `mcpServers` map, sorted by name, each with its config as written. */
export function mcpServersOf(map: unknown): (McpServer & { config: Json })[] {
  return sortByName(
    Object.entries(isObject(map) ? map : {})
      .filter((entry): entry is [string, Json] => isObject(entry[1]))
      .map(([name, server]) => ({
        name,
        transport: server.type ?? (server.url ? 'http' : 'stdio'),
        target: server.url ?? [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean).join(' '),
        config: server
      }))
  )
}

function readHooks(settings: Json): Hook[] {
  return hookEntries(settings)
    .map(({ event, matcher, command }) => ({ event, matcher, command }))
    .sort((a, b) => a.event.localeCompare(b.event))
}

/** One hook command in a settings file, with what it takes to find it again. */
export interface HookEntry extends Hook {
  /** The matcher as written ('' when absent); `matcher` shows it, with '*' for none. */
  rawMatcher: string
  /** Which of the hooks with the same event, raw matcher and command this is, in file order. */
  n: number
  /** Position in the file: `hooks[event][group].hooks[index]`. */
  group: number
  index: number
  /** The hook object as written. */
  hook: Json
}

/** Every hook in a settings object, in file order. Malformed parts are skipped. */
export function hookEntries(settings: Json): HookEntry[] {
  const entries: HookEntry[] = []
  for (const [event, groups] of Object.entries(isObject(settings.hooks) ? settings.hooks : {})) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group: unknown, groupIndex) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return
      const rawMatcher = typeof group.matcher === 'string' ? group.matcher : ''
      group.hooks.forEach((hook: unknown, index) => {
        if (!isObject(hook)) return
        const command = String(hook.command ?? hook.type ?? '')
        const n = entries.filter((e) => e.event === event && e.rawMatcher === rawMatcher && e.command === command).length
        entries.push({ event, matcher: rawMatcher || '*', rawMatcher, command, n, group: groupIndex, index, hook })
      })
    })
  }
  return entries
}

/** Name and description from the YAML frontmatter, falling back to the file name. */
function describe(fallbackName: string, path: string, text: string): Skill {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (key: string) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$((?:\\r?\\n[ \\t]+.*)*)`, 'm').exec(frontmatter)
    if (!match) return ''
    const head = match[1].trim()
    // A block scalar (>, >-, |, |-) keeps its text on the indented lines below the key.
    const value = /^[>|][+-]?$/.test(head) ? match[2] : `${head}${match[2]}`
    return value.trim().split(/\s*\r?\n\s*/).join(' ').replace(/^(["'])(.*)\1$/, '$2')
  }
  return { name: field('name') || fallbackName, description: field('description'), path }
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.name.localeCompare(b.name))
}
