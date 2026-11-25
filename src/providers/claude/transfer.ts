// 'copyToAgent' for Claude Code: MCP servers and skills out to another agent, and in from one.
// Out: any server or skill the view shows (an export only reads). In: through the same write paths as a move.
// - An MCP server goes through `claude mcp add-json` (./mcp.ts addMcp) as a guarded change: ~/.claude.json is never
//   written here, the target file is version checked and backed up first, and read again after. The server is admitted against CLAUDE_ADD_JSON (or its
//   team twin for a project .mcp.json) by the MCP server policy (../mcp-policy.ts), as a move is.
// - A skill folder is copied into ~/.claude/skills or <project>/.claude/skills with the toolkit's moveEntry.
import type { ActionResult, Target } from '../../adapters/view.ts'
import { moveEntry } from '../../core/entries.ts'
import { exportSkill, portableMcp, skillEntry, type Exported, type Portable } from '../toolkit.ts'
import { entryKey, mcpKey, read } from './actions.ts'
import { claudeEntryPlaces } from './entries.ts'
import { claudeMcpConfig, knownProjects } from './inventory.ts'
import { addMcp, admitClaude, claudeJson } from './mcp.ts'
import type { ClaudeDeps } from './ports.ts'
import type { Place } from './setup.ts'

const GONE = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' } as const
const NOTE = 'Changes apply to new Claude Code sessions.'

export async function exportClaude(deps: ClaudeDeps, key: string): Promise<Exported> {
  const ref = (await read(deps)).refs.get(key)
  if (ref?.kind === 'entry' && ref.entry.kind === 'skills') return exportSkill(deps.fs, ref.entry.name, ref.entry.entry)
  if (ref?.kind !== 'mcp') return GONE
  return portableMcp(claudeMcpConfig(ref.server.name, ref.server.config))
}

export async function importClaude(deps: ClaudeDeps, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult> {
  const { fs, paths } = deps
  const project = to.project
  if (project !== null && !(await knownProjects(fs, paths)).includes(project)) {
    return { ok: false, reason: 'unknown-project', message: `${project} is not a project Claude Code knows.` }
  }

  if (item.kind === 'skills') {
    const copied = await moveEntry(fs, claudeEntryPlaces(fs, paths), skillEntry(item), project, true)
    if (!copied.ok) return copied
    return { ok: true, message: `Copied skill "${item.name}" to ${copied.path}. ${NOTE}`, undo: { type: 'remove', key: entryKey('skills', copied.path) } }
  }

  // Only me stays the default in a project, as for a move (CLAUDE_PROJECT_SCOPES).
  const place: Place = { project, scope: project === null ? 'user' : to.scope === 'project' ? 'project' : 'local' }
  const admitted = admitClaude(item, place)
  if (!admitted.ok) return admitted
  const added = await addMcp(deps, item.name, claudeJson(admitted.server), place, versions, deps.clock ?? (() => new Date()))
  const where = project === null ? 'global' : `${project} (${place.scope === 'project' ? 'team' : 'only me'})`
  if (!added.ok) return { ok: false, reason: added.reason, message: added.message }
  return {
    ok: true,
    message: `Copied MCP server "${item.name}" to ${where} with claude mcp add-json. ${NOTE}`,
    undo: { type: 'remove', key: mcpKey(project, place.scope, item.name) }
  }
}
