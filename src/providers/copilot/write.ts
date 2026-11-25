// The writes: moving, copying and removing skills, agents and MCP servers. Every file write goes through the
// guarded change module (version check against the view, backup first, then the change); restore is the router's,
// from copilotBackups.
//
// MCP servers are written as JSON (a guarded JSON edit), not with `copilot mcp add|remove`, because:
// - `copilot mcp add` takes flags, which cannot carry every field a server may have (cwd, deferTools, OAuth
//   settings), and it would put env and header values on a command line;
// - `copilot mcp remove` changes user-level servers only, so a move into or out of a project needs the file anyway;
// - the Copilot binary is often absent (`gh copilot` downloads it on first use), and the file write works without it.
// The JSON edit keeps every other key and server as it was, in the same 2-space format Copilot writes.
import type { ActionRequest, ActionResult, Kind } from '../../adapters/view.ts'
import {
  admitMcp,
  guardedChange,
  GONE,
  isObject,
  itemKey,
  moveEntry,
  privateFile,
  teamFile,
  tilde,
  trashEntry,
  type BackupPlan,
  type Carries,
  type ChangeDeps,
  type Json,
  type ProviderDeps
} from '../toolkit.ts'
import { OWNER, ownPlace, type CopilotPaths } from './paths.ts'
import { copilotMcpConfig, readCopilot, type Ref } from './read.ts'

/**
 * What Copilot CLI's MCP files hold: `local`/`stdio` servers with command, args and env, `http`/`sse` servers
 * with url and headers ("Adding MCP servers for GitHub Copilot CLI", docs.github.com). The file is written as
 * JSON, so a move keeps every other key of the server (tools, cwd, OAuth settings) as it was.
 */
const COPILOT_MCP: Carries = { transports: ['stdio', 'http', 'sse'], fields: ['args', 'env', 'headers'], keeps: () => true }

/** A project's .github/mcp.json: shared with the team through the repository. */
export const COPILOT_TEAM_FILE = teamFile('a project .github/mcp.json', COPILOT_MCP)
/** ~/.copilot/mcp-config.json: the user's own file; no command line sees it. */
export const COPILOT_PRIVATE_FILE = privateFile('~/.copilot/mcp-config.json', COPILOT_MCP)

const fail = (reason: string, message: string): ActionResult => ({ ok: false, reason, message })

/** What every guarded change here works with: Copilot's store, and ~ for the home folder in messages. */
export const changeDeps = (deps: ProviderDeps, paths: CopilotPaths): ChangeDeps => ({
  fs: deps.fs,
  exec: deps.exec,
  store: paths.store,
  clock: deps.clock ?? (() => new Date()),
  say: (path) => tilde(paths.home, path)
})

/** What restore works with (the router runs it): the MCP files this app writes, and Copilot's own entry folders. */
export async function copilotBackups(deps: ProviderDeps, paths: CopilotPaths): Promise<BackupPlan> {
  const everywhere = [null, ...(await readCopilot(deps.fs, paths)).view.projects]
  return {
    owner: OWNER,
    store: paths.store,
    files: everywhere.map((project) => ownPlace(paths, 'mcp', project)),
    entryFolders: everywhere.flatMap((project) => [ownPlace(paths, 'skills', project), ownPlace(paths, 'agents', project)]),
    say: (path) => tilde(paths.home, path)
  }
}

export async function runCopilotAction(deps: ProviderDeps, paths: CopilotPaths, request: ActionRequest): Promise<ActionResult> {
  const { fs } = deps
  const clock = deps.clock ?? (() => new Date())
  const { action, versions } = request
  const { view, index } = await readCopilot(fs, paths)
  const where = (project: string | null) => (project === null ? 'global' : tilde(paths.home, project))

  if (action.type !== 'move' && action.type !== 'remove') return fail('unsupported', `${OWNER} cannot do "${action.type}" here.`)

  const item = index.item(action.key)
  if (item === undefined) return GONE
  const found = index.lookup(item.key)
  if (!found.ok || !item.movable) return fail('not-movable', `"${item.name}" is read-only here. ${item.notMovableReason ?? ''}`.trim())
  const { ref } = found

  if (action.type === 'remove') {
    if (ref.kind === 'mcp') return removeServer(changeDeps(deps, paths), paths, ref, versions)
    const trashed = await trashEntry(fs, paths.store, ref.entry.entry, clock)
    if (!trashed.ok) return trashed
    return { ok: true, message: `Removed "${item.name}" from ${where(ref.project)}. It is kept in the backups.`, undo: { type: 'restore', name: trashed.name } }
  }

  const to = isObject(action.to) && (action.to.project === null || typeof action.to.project === 'string') ? action.to : null
  if (to === null) return fail('invalid', 'The move names no destination.')
  const done = (key: string): ActionResult => ({
    ok: true,
    message: `${action.copy ? 'Copied' : 'Moved'} "${item.name}" to ${where(to.project)}.`,
    undo: action.copy ? { type: 'remove', key } : { type: 'move', key, to: { project: ref.project, scope: 'project' }, copy: false }
  })

  if (ref.kind === 'mcp') {
    if (to.project !== null && to.scope === 'local') {
      return fail('unsupported', `${OWNER} has no only-me MCP file in a project. Choose Team to write ${to.project}/.github/mcp.json.`)
    }
    const moved = await moveServer(changeDeps(deps, paths), paths, ref, to.project, view.projects, versions, action.copy)
    return moved.ok ? done(itemKey('mcp', moved.file, ref.name)) : moved
  }

  const places = { owner: OWNER, projects: async () => view.projects, dirOf: (kind: Kind, project: string | null) => ownPlace(paths, kind, project) }
  const moved = await moveEntry(fs, places, ref.entry, to.project, action.copy)
  return moved.ok ? done(itemKey(ref.kind, moved.path)) : moved
}

/** Deletes one server from its file. The undo puts the whole file back from the backup made just before. */
async function removeServer(deps: ChangeDeps, paths: CopilotPaths, ref: Ref & { kind: 'mcp' }, versions: Record<string, string>): Promise<ActionResult> {
  const written = await guardedChange(deps, { files: [ref.file], versions, steps: [{ effect: { kind: 'json', file: ref.file, edit: (json) => deleteServer(json, ref) } }] })
  if (!written.ok) return written
  return { ok: true, message: `Removed "${ref.name}" from ${tilde(paths.home, ref.file)}. A backup was made first.`, undo: written.restore(ref.file) }
}

/**
 * Adds the server, unchanged, to Copilot's MCP file of the destination, then (for a move) deletes it from its
 * own file: one guarded change, so a stale view writes nothing and a failed delete is `partial`.
 */
async function moveServer(
  deps: ChangeDeps,
  paths: CopilotPaths,
  ref: Ref & { kind: 'mcp' },
  project: string | null,
  projects: string[],
  versions: Record<string, string>,
  copy: boolean
): Promise<{ ok: true; file: string } | (ActionResult & { ok: false })> {
  if (project !== null && !projects.includes(project)) {
    return { ok: false, reason: 'unknown-project', message: `${project} is not a folder ${OWNER} trusts.` }
  }
  const file = ownPlace(paths, 'mcp', project)
  if (file === ref.file) return { ok: false, reason: 'same-place', message: `"${ref.name}" is already there.` }
  // The file is written as JSON, not through a command line; a project file is shared through the repository.
  const admitted = admitMcp(copilotMcpConfig(ref.name, ref.config), project === null ? COPILOT_PRIVATE_FILE : COPILOT_TEAM_FILE)
  if (!admitted.ok) return admitted.reason === 'secret' ? admitted : { ok: false, reason: 'not-movable', message: admitted.message }
  const add = { effect: { kind: 'json' as const, file, edit: (json: Json) => addServer(json, ref, file) } }
  const remove = { effect: { kind: 'json' as const, file: ref.file, edit: (json: Json) => deleteServer(json, ref) } }
  const written = await guardedChange(deps, { files: copy ? [file] : [file, ref.file], versions, steps: copy ? [add] : [add, remove] })
  return written.ok ? { ok: true, file } : written
}

function addServer(json: Json, ref: Ref & { kind: 'mcp' }, file: string): string | void {
  if (json.mcpServers === undefined) json.mcpServers = {}
  if (!isObject(json.mcpServers)) return `"mcpServers" in ${file} is not an object; it was left untouched.`
  if (Object.hasOwn(json.mcpServers, ref.name)) return `An MCP server named "${ref.name}" is already in ${file}. Remove or rename one of them first.`
  json.mcpServers[ref.name] = ref.config
}

function deleteServer(json: Json, ref: Ref & { kind: 'mcp' }): string | void {
  if (!isObject(json.mcpServers) || !Object.hasOwn(json.mcpServers, ref.name)) return `"${ref.name}" is no longer in ${ref.file}.`
  delete json.mcpServers[ref.name]
}
