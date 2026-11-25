// 'copyToAgent' for Copilot CLI: MCP servers and skills out to another agent, and in from one.
// Out: any skill or server the view shows, shared places included (an export only reads). In: through the same
// write path as a move (./write.ts): MCP servers into Copilot's own file with a guarded JSON edit (version check, backup
// first), skill folders into Copilot's own folder with moveEntry (never overwriting, a link kept as a link). No
// command line is involved: the server is admitted against COPILOT_PRIVATE_FILE or COPILOT_TEAM_FILE.
import type { ActionResult, Kind, Target } from '../../adapters/view.ts'
import {
  admitMcp,
  guardedChange,
  exportSkill,
  isObject,
  itemKey,
  mcpJson,
  moveEntry,
  portableMcp,
  skillEntry,
  tilde,
  type Exported,
  type FileSystem,
  type Json,
  type Portable,
  type ProviderDeps
} from '../toolkit.ts'
import { OWNER, ownPlace, type CopilotPaths } from './paths.ts'
import { copilotMcpConfig, readCopilot } from './read.ts'
import { changeDeps, COPILOT_PRIVATE_FILE, COPILOT_TEAM_FILE } from './write.ts'

const GONE = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' } as const

export async function exportCopilot(fs: FileSystem, paths: CopilotPaths, key: string): Promise<Exported> {
  const source = (await readCopilot(fs, paths)).sources.get(key)
  if (source === undefined) return GONE
  if (source.kind === 'skills') return exportSkill(fs, source.name, source.dir)
  return portableMcp(copilotMcpConfig(source.name, source.config))
}

export async function importCopilot(deps: ProviderDeps, paths: CopilotPaths, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult> {
  const { fs } = deps
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

  const admitted = admitMcp(item, project === null ? COPILOT_PRIVATE_FILE : COPILOT_TEAM_FILE)
  if (!admitted.ok) return admitted
  const file = ownPlace(paths, 'mcp', project)
  // `tools: ["*"]`: every tool, which is what the server had in the agent it comes from.
  const config = { ...mcpJson(admitted.server, 'local'), tools: ['*'] }
  const edit = (json: Json) => {
    if (json.mcpServers === undefined) json.mcpServers = {}
    if (!isObject(json.mcpServers)) return `"mcpServers" in ${file} is not an object; it was left untouched.`
    if (Object.hasOwn(json.mcpServers, item.name)) return `An MCP server named "${item.name}" is already in ${file}. Remove or rename one of them first.`
    json.mcpServers[item.name] = config
  }
  const written = await guardedChange(changeDeps(deps, paths), { files: [file], versions, steps: [{ effect: { kind: 'json', file, edit } }] })
  if (!written.ok) return written
  return {
    ok: true,
    message: `Copied MCP server "${item.name}" to ${tilde(paths.home, file)}. A backup was made first.`,
    undo: { type: 'remove', key: itemKey('mcp', file, item.name) }
  }
}
