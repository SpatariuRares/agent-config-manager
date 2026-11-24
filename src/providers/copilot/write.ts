// The writes: moving, copying and removing skills, agents and MCP servers, and putting backups back.
// Every write goes through the toolkit: version check against the view, backup first, then the change.
//
// MCP servers are written as JSON (editJsonFile), not with `copilot mcp add|remove`, because:
// - `copilot mcp add` takes flags, which cannot carry every field a server may have (cwd, deferTools, OAuth
//   settings), and it would put env and header values on a command line;
// - `copilot mcp remove` changes user-level servers only, so a move into or out of a project needs the file anyway;
// - the Copilot binary is often absent (`gh copilot` downloads it on first use), and the file write works without it.
// editJsonFile keeps every other key and server as it was, in the same 2-space format Copilot writes.
import type { Action, ActionRequest, ActionResult, Kind } from '../../adapters/view.ts'
import {
  argsHaveSecret,
  backupTarget,
  CHANGED,
  editJsonFile,
  isObject,
  isTrashName,
  itemKey,
  moveEntry,
  restoreFile,
  restoreTrash,
  tilde,
  trashEntry,
  urlHasSecret,
  versionOf,
  type Clock,
  type FileSystem,
  type Json
} from '../toolkit.ts'
import { OWNER, ownPlace, type CopilotPaths } from './paths.ts'
import { readCopilot, type Ref } from './read.ts'

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const fail = (reason: string, message: string): ActionResult => ({ ok: false, reason, message })

export async function runCopilotAction(fs: FileSystem, paths: CopilotPaths, clock: Clock, request: ActionRequest): Promise<ActionResult> {
  const { action, versions } = request
  const { view, refs } = await readCopilot(fs, paths)
  const where = (project: string | null) => (project === null ? 'global' : tilde(paths.home, project))

  if (action.type === 'restore') return restore(fs, paths, clock, view.projects, action.name, versions)
  if (action.type !== 'move' && action.type !== 'remove') return fail('unsupported', `${OWNER} cannot do "${action.type}" here.`)

  const item = view.items.find((candidate) => candidate.key === action.key)
  if (item === undefined) return fail('changed', 'That item is no longer there. The view was refreshed; try again.')
  const ref = refs.get(item.key)
  if (ref === undefined) return fail('not-movable', `"${item.name}" is read-only here. ${item.notMovableReason ?? ''}`.trim())

  if (action.type === 'remove') {
    if (ref.kind === 'mcp') return removeServer(fs, paths, clock, ref, versions)
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
    const moved = await moveServer(fs, paths, clock, ref, to.project, view.projects, versions, action.copy)
    return moved.ok ? done(itemKey('mcp', moved.file, ref.name)) : moved
  }

  const places = { owner: OWNER, projects: async () => view.projects, dirOf: (kind: Kind, project: string | null) => ownPlace(paths, kind, project) }
  const moved = await moveEntry(fs, places, ref.entry, to.project, action.copy)
  return moved.ok ? done(itemKey(ref.kind, moved.path)) : moved
}

/** Deletes one server from its file. The undo puts the whole file back from the backup made just before. */
async function removeServer(fs: FileSystem, paths: CopilotPaths, clock: Clock, ref: Ref & { kind: 'mcp' }, versions: Record<string, string>): Promise<ActionResult> {
  const written = await editJsonFile(fs, paths.store, { file: ref.file, version: versions[ref.file] ?? '', edit: (json) => deleteServer(json, ref) }, clock)
  if (!written.ok) return written
  const undo: Action | undefined = written.backup ? { type: 'restore', name: fileName(written.backup) } : undefined
  return { ok: true, message: `Removed "${ref.name}" from ${tilde(paths.home, ref.file)}. A backup was made first.`, undo }
}

/**
 * Adds the server, unchanged, to Copilot's MCP file of the destination, then (for a move) deletes it from its
 * own file. Both files are checked before either is written, so a stale view writes nothing.
 */
async function moveServer(
  fs: FileSystem,
  paths: CopilotPaths,
  clock: Clock,
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
  // A project file is shared through the repository: a literal token in env or headers must not land there.
  if (project !== null && hasLiteralSecret(ref.config)) {
    return {
      ok: false,
      reason: 'secret',
      message: `"${ref.name}" has literal env or header values. Replace them with \${VAR} references first: a project file is shared with the team.`
    }
  }
  if (project !== null && commandLineSecret(ref.config)) {
    return {
      ok: false,
      reason: 'secret',
      message: `"${ref.name}" has a secret-looking value in its args or url. Move it into an env value with a \${VAR} reference first: a project file is shared with the team.`
    }
  }
  for (const path of [file, ref.file]) {
    if (versionOf(await fs.readText(path)) !== (versions[path] ?? '')) return CHANGED
  }

  const added = await editJsonFile(fs, paths.store, { file, version: versions[file] ?? '', edit: (json) => addServer(json, ref, file) }, clock)
  if (!added.ok) return added
  if (copy) return { ok: true, file }
  const removed = await editJsonFile(fs, paths.store, { file: ref.file, version: versions[ref.file] ?? '', edit: (json) => deleteServer(json, ref) }, clock)
  if (!removed.ok) {
    return { ok: false, reason: 'partial', message: `Copied "${ref.name}" to ${file}, but it is still in ${ref.file}: ${removed.message}` }
  }
  return { ok: true, file }
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

/** True when the args or the url hold a value that looks like a credential (the toolkit's redaction rules). */
function commandLineSecret(config: Json): boolean {
  const words = [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter((word): word is string => typeof word === 'string')
  return argsHaveSecret(words) || (typeof config.url === 'string' && urlHasSecret(config.url))
}

/** True when env or headers hold a value that is not a `$VAR` / `${VAR}` reference. */
function hasLiteralSecret(config: Json): boolean {
  return ['env', 'headers'].some(
    (field) => isObject(config[field]) && Object.values(config[field]).some((value) => typeof value !== 'string' || !value.includes('$'))
  )
}

/**
 * Puts a backup back: a trashed skill or agent into its Copilot folder, or an MCP file this app writes.
 * restoreFile backs up the current file first, so a restore can itself be undone.
 */
async function restore(fs: FileSystem, paths: CopilotPaths, clock: Clock, projects: string[], name: string, versions: Record<string, string>): Promise<ActionResult> {
  const everywhere = [null, ...projects]
  if (isTrashName(name)) {
    const places = everywhere.flatMap((project) => [ownPlace(paths, 'skills', project), ownPlace(paths, 'agents', project)])
    const restored = await restoreTrash(fs, paths.store, name, places, OWNER)
    return restored.ok ? { ok: true, message: `Put ${tilde(paths.home, restored.target)} back.` } : restored
  }
  const writable = new Set(everywhere.map((project) => ownPlace(paths, 'mcp', project)))
  const target = backupTarget(paths.store, name) ?? ''
  const guard = async (file: string) => (writable.has(file) ? null : { ok: false as const, reason: 'refused', message: `${file} is not a file this app writes for ${OWNER}.` })
  const restored = await restoreFile(fs, paths.store, { name, version: versions[target] ?? '' }, clock, guard)
  if (!restored.ok) return restored
  return { ok: true, message: `Restored ${tilde(paths.home, target)} from the backup.`, undo: { type: 'restore', name: fileName(restored.backup) } }
}
