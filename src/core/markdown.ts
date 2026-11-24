// SKILL.md folders and agent .md files: names and descriptions from their YAML frontmatter. Read-only.
import type { FileSystem } from './ports.ts'

export interface Skill {
  name: string
  description: string
  /** The SKILL.md file, or the agent file. */
  path: string
}

export type Agent = Skill

/** Name and description from the YAML frontmatter, falling back to `fallbackName`. */
export function describe(fallbackName: string, path: string, text: string): Skill {
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

/** Skills in a folder of skill folders, each holding SKILL.md, sorted by name. */
export async function readSkills(fs: FileSystem, dir: string): Promise<Skill[]> {
  const skills: Skill[] = []
  for (const entry of await fs.listEntries(dir)) {
    const path = `${dir}/${entry}/SKILL.md`
    const text = await fs.readText(path)
    if (text !== null) skills.push(describe(entry, path, text))
  }
  return sortByName(skills)
}

/** Agents in a folder of `<name><suffix>` files (suffix `.md`, or e.g. `.agent.md`), sorted by name. */
export async function readAgents(fs: FileSystem, dir: string, suffix = '.md'): Promise<Agent[]> {
  const agents: Agent[] = []
  for (const entry of await fs.listEntries(dir)) {
    if (!entry.endsWith(suffix)) continue
    const path = `${dir}/${entry}`
    const text = await fs.readText(path)
    if (text !== null) agents.push(describe(entry.slice(0, -suffix.length), path, text))
  }
  return sortByName(agents)
}

export function sortByName<T extends { name: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.name.localeCompare(b.name))
}
