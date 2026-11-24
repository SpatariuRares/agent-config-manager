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

export interface Plugin {
  id: string
  name: string
  marketplace: string
  enabled: boolean
  /** Installed version, or null when the plugin is listed in settings but not installed. */
  version: string | null
  /** Ids of plugins with the same name from other marketplaces. */
  sharesNameWith: string[]
  contributes: PluginContributions
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
}

type Json = Record<string, any>

export async function readInventory(fs: FileSystem, paths: ClaudePaths): Promise<Inventory> {
  const problems: string[] = []
  const settings = await readJson(fs, `${paths.claudeDir}/settings.json`, problems)
  const userConfig = await readJson(fs, paths.userConfigFile, problems)
  const installed = await readJson(fs, `${paths.claudeDir}/plugins/installed_plugins.json`, problems)

  return {
    plugins: await readPlugins(fs, settings, installed, problems),
    skills: await readSkills(fs, `${paths.claudeDir}/skills`),
    agents: await readAgents(fs, `${paths.claudeDir}/agents`),
    mcpServers: readMcpServers(userConfig),
    hooks: readHooks(settings),
    problems
  }
}

async function readJson(fs: FileSystem, path: string, problems: string[]): Promise<Json> {
  const text = await fs.readText(path)
  if (text === null) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    problems.push(`${path}: ${(error as Error).message}`)
    return {}
  }
}

async function readPlugins(fs: FileSystem, settings: Json, installed: Json, problems: string[]): Promise<Plugin[]> {
  const ids = Object.keys(settings.enabledPlugins ?? {})
  const nameOf = (id: string) => (id.lastIndexOf('@') === -1 ? id : id.slice(0, id.lastIndexOf('@')))
  const plugins: Plugin[] = []
  for (const id of ids) {
    const at = id.lastIndexOf('@')
    const install: Json | undefined = installed.plugins?.[id]?.[0]
    plugins.push({
      id,
      name: nameOf(id),
      marketplace: at === -1 ? '' : id.slice(at + 1),
      enabled: settings.enabledPlugins[id] === true,
      version: install?.version ?? null,
      sharesNameWith: ids.filter((other) => other !== id && nameOf(other) === nameOf(id)).sort(),
      contributes: install?.installPath
        ? await readContributions(fs, install.installPath, problems)
        : { skills: [], agents: [], commands: [], hooks: [], mcpServers: [] }
    })
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id))
}

async function readContributions(fs: FileSystem, root: string, problems: string[]): Promise<PluginContributions> {
  const manifest = await readJson(fs, `${root}/.claude-plugin/plugin.json`, problems)
  // plugin.json may point at extra component paths (a string or a list); they add to the default folders.
  const at = (key: string, fallback: string): string[] => {
    const value = manifest[key]
    const declared: string[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
    return [fallback, ...declared].map((path) => `${root}/${path.replace(/^\.\//, '').replace(/\/$/, '')}`)
  }
  const inline = async (key: string, file: string): Promise<Json> => {
    const value = manifest[key]
    if (typeof value === 'object' && value !== null) return value
    return readJson(fs, `${root}/${typeof value === 'string' ? value.replace(/^\.\//, '') : file}`, problems)
  }
  const hooksFile = await inline('hooks', 'hooks/hooks.json')
  const mcpFile = await inline('mcpServers', '.mcp.json')
  const mcpDefault = typeof manifest.mcpServers === 'object' ? await readJson(fs, `${root}/.mcp.json`, problems) : {}

  return {
    skills: unique(await skillNames(fs, at('skills', 'skills'))),
    agents: unique((await markdownFiles(fs, at('agents', 'agents'))).map(({ name, path, text }) => describe(name, path, text).name)),
    commands: unique((await markdownFiles(fs, at('commands', 'commands'))).map(({ name }) => name)),
    hooks: unique(Object.keys(hooksFile.hooks ?? hooksFile).filter((key) => key !== 'description')),
    // .mcp.json is written both with and without the mcpServers wrapper.
    mcpServers: unique([mcpFile, mcpDefault].flatMap((file) => Object.keys(file.mcpServers ?? file)))
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

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

async function readSkills(fs: FileSystem, dir: string): Promise<Skill[]> {
  const skills: Skill[] = []
  for (const entry of await fs.listEntries(dir)) {
    const path = `${dir}/${entry}/SKILL.md`
    const text = await fs.readText(path)
    if (text !== null) skills.push(describe(entry, path, text))
  }
  return sortByName(skills)
}

async function readAgents(fs: FileSystem, dir: string): Promise<Agent[]> {
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
  return sortByName(
    Object.entries(userConfig.mcpServers ?? {}).map(([name, server]: [string, Json]) => ({
      name,
      transport: server.type ?? (server.url ? 'http' : 'stdio'),
      target: server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    }))
  )
}

function readHooks(settings: Json): Hook[] {
  const hooks: Hook[] = []
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of (groups as Json[]) ?? []) {
      for (const hook of group.hooks ?? []) {
        hooks.push({ event, matcher: group.matcher || '*', command: hook.command ?? hook.type ?? '' })
      }
    }
  }
  return hooks.sort((a, b) => a.event.localeCompare(b.event))
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
