// Reads the Claude Code setup into one read-only model. Never writes.
import type { ClaudePaths, FileSystem } from './ports.ts'

export interface Plugin {
  id: string
  name: string
  marketplace: string
  enabled: boolean
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

  return {
    plugins: readPlugins(settings),
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

function readPlugins(settings: Json): Plugin[] {
  return Object.entries(settings.enabledPlugins ?? {})
    .map(([id, enabled]) => {
      const at = id.lastIndexOf('@')
      return {
        id,
        name: at === -1 ? id : id.slice(0, at),
        marketplace: at === -1 ? '' : id.slice(at + 1),
        enabled: enabled === true
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
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
