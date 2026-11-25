// 'copyToAgent' for Copilot CLI: MCP servers and skills out to another agent, and in from one.
// Out: any skill or server the view shows, shared places included (an export only reads). In: through the same
// write path as a move (./write.ts): MCP servers into Copilot's own file with editJsonFile (version check, backup
// first), skill folders into Copilot's own folder with moveEntry (never overwriting, a link kept as a link). No
// command line is involved, so only a project file, which the team shares, refuses literal values and secrets.
import type { ActionResult, Kind, Target } from '../../adapters/view.ts'
import {
  editJsonFile,
  exportSkill,
  isObject,
  itemKey,
  mcpJson,
  moveEntry,
  portableMcp,
  secretRefusal,
  skillEntry,
  tilde,
  type Clock,
  type Exported,
  type FileSystem,
  type Portable
} from '../toolkit.ts'
import { OWNER, ownPlace, type CopilotPaths } from './paths.ts'
import { readCopilot } from './read.ts'

const GONE = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' } as const

export async function exportCopilot(fs: FileSystem, paths: CopilotPaths, key: string): Promise<Exported> {
  const source = (await readCopilot(fs, paths)).sources.get(key)
  if (source === undefined) return GONE
  if (source.kind === 'skills') return exportSkill(fs, source.name, source.dir)
  const { type, command, args, env, url, headers, tools, ...rest } = source.config
  const extra = Object.keys(rest)
  // `tools: ["*"]` (every tool) is what other agents do anyway; a narrower list cannot be carried.
  if (tools !== undefined && !(Array.isArray(tools) && tools.length === 1 && tools[0] === '*')) extra.push('tools')
  // Copilot calls stdio `local`; without a type, a url means http.
  const transport = type === undefined ? (typeof url === 'string' ? 'http' : 'stdio') : type === 'local' ? 'stdio' : String(type)
  return portableMcp(source.name, { transport, command, args, url, env, headers }, extra)
}

export async function importCopilot(
  fs: FileSystem,
  paths: CopilotPaths,
  clock: Clock,
  item: Portable,
  to: Target,
  versions: Record<string, string>
): Promise<ActionResult> {
  const { view } = await readCopilot(fs, paths)
  const project = to.project
  if (project !== null && !view.projects.includes(project)) {
    return { ok: false, reason: 'unknown-project', message: `${project} is not a folder ${OWNER} trusts.` }
  }
  if (project !== null && to.scope === 'local') {
    return { ok: false, reason: 'unsupported', message: `${OWNER} has no only-me place in a project. Choose Team.` }
  }

  if (item.kind === 'skills') {
    const places = { owner: OWNER, projects: async () => view.projects, dirOf: (kind: Kind, at: string | null) => ownPlace(paths, kind, at) }
    const copied = await moveEntry(fs, places, skillEntry(item), project, true)
    if (!copied.ok) return copied
    return { ok: true, message: `Copied skill "${item.name}" to ${tilde(paths.home, copied.path)}.`, undo: { type: 'remove', key: itemKey('skills', copied.path) } }
  }

  const refused = secretRefusal(item, { commandLine: null, teamFile: project !== null })
  if (refused !== null) return refused
  const file = ownPlace(paths, 'mcp', project)
  // `tools: ["*"]`: every tool, which is what the server had in the agent it comes from.
  const config = { ...mcpJson(item, 'local'), tools: ['*'] }
  const written = await editJsonFile(
    fs,
    paths.store,
    {
      file,
      version: versions[file] ?? '',
      edit: (json) => {
        if (json.mcpServers === undefined) json.mcpServers = {}
        if (!isObject(json.mcpServers)) return `"mcpServers" in ${file} is not an object; it was left untouched.`
        if (Object.hasOwn(json.mcpServers, item.name)) return `An MCP server named "${item.name}" is already in ${file}. Remove or rename one of them first.`
        json.mcpServers[item.name] = config
      }
    },
    clock
  )
  if (!written.ok) return written
  return {
    ok: true,
    message: `Copied MCP server "${item.name}" to ${tilde(paths.home, file)}. A backup was made first.`,
    undo: { type: 'remove', key: itemKey('mcp', file, item.name) }
  }
}
