// Codex writes. config.toml is never written by this app: MCP changes go through `codex mcp add/remove`
// (format-preserving toml_edit inside Codex), after a backup of config.toml. Skill folders and agent files are
// moved, copied and trashed through the core toolkit.
import type { Action, ActionRequest, ActionResult } from '../../adapters/view.ts'
import {
  backUp,
  backupTarget,
  CHANGED,
  redactCommand,
  isObject,
  isTrashName,
  itemKey,
  listBackups,
  moveEntry,
  optionLikeRefusal,
  restoreTrash,
  tilde,
  trashEntry,
  versionOf,
  type EntryPlaces,
  type ProviderDeps
} from '../toolkit.ts'
import { parse } from 'smol-toml'
import { agentDir, codexBackups, codexPaths, destinationDir, copyableServer, readCodex, skillDirs, usableServerName, type CodexRead, type Ref } from './read.ts'
import type { Json } from '../toolkit.ts'

/** `codex mcp add/remove` can take a while on first run; never wait forever. */
const CLI_TIMEOUT_MS = 60_000

const GONE: ActionResult = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' }
const refuse = (reason: string, message: string): ActionResult => ({ ok: false, reason, message })
const clockOf = (deps: ProviderDeps) => deps.clock ?? (() => new Date())
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export async function codexAction(deps: ProviderDeps, request: ActionRequest): Promise<ActionResult> {
  const read = await readCodex(deps)
  const { action, versions } = request
  const refOf = (key: string) => read.refs.get(key)
  switch (action.type) {
    case 'move': {
      const ref = refOf(action.key)
      if (ref === undefined) return addBackFromBackup(deps, action, versions)
      return ref.kind === 'mcp' ? copyServer(deps, read, ref, action, versions) : moveFile(deps, read, ref, action, versions)
    }
    case 'remove': {
      const ref = refOf(action.key)
      if (ref === undefined) return GONE
      return ref.kind === 'mcp' ? removeServer(deps, ref, versions) : trashFile(deps, ref, versions)
    }
    case 'restore':
      return restore(deps, read, action.name)
    case 'snapshot':
      return snapshot(deps)
    default:
      return refuse('unsupported', `Codex cannot do "${action.type}" here.`)
  }
}

/** The view's version of `file` still matches the disk. */
async function fresh(deps: ProviderDeps, file: string, versions: Record<string, string>): Promise<{ text: string | null } | null> {
  const text = await deps.fs.readText(file)
  return versionOf(text) === (versions[file] ?? '') ? { text } : null
}

function places(deps: ProviderDeps, read: CodexRead): EntryPlaces {
  const paths = codexPaths(deps.home)
  return { dirOf: (kind, project) => destinationDir(paths, kind, project), projects: async () => read.view.projects, owner: 'Codex' }
}

async function moveFile(deps: ProviderDeps, read: CodexRead, ref: Ref & { kind: 'skills' | 'agents' }, action: Action & { type: 'move' }, versions: Record<string, string>): Promise<ActionResult> {
  if (!ref.movable) return refuse('not-movable', ref.reason ?? `"${ref.entry.name}" cannot be moved.`)
  if (ref.project === null && action.to.project === null) return refuse('same-place', `"${ref.entry.name}" is already global.`)
  if ((await fresh(deps, ref.file, versions)) === null) return CHANGED
  const moved = await moveEntry(deps.fs, places(deps, read), ref.entry, action.to.project, action.copy)
  if (!moved.ok) return refuse(moved.reason, moved.message)
  const key = itemKey(ref.kind, moved.path)
  const where = action.to.project === null ? 'global' : action.to.project
  const untrusted = ref.kind === 'agents' && action.to.project !== null && !read.trusted.has(action.to.project)
  return {
    ok: true,
    message: `${action.copy ? 'Copied' : 'Moved'} "${ref.entry.name}" to ${tilde(deps.home, moved.path)}.`,
    undo: action.copy ? { type: 'remove', key } : { type: 'move', key, to: { project: ref.project }, copy: false },
    ...(untrusted ? { warning: `Codex reads ${where}/.codex only when that project is trusted.` } : {})
  }
}

async function trashFile(deps: ProviderDeps, ref: Ref & { kind: 'skills' | 'agents' }, versions: Record<string, string>): Promise<ActionResult> {
  if (!ref.removable) return refuse('not-removable', ref.reason ?? `"${ref.entry.name}" cannot be removed.`)
  if ((await fresh(deps, ref.file, versions)) === null) return CHANGED
  const trashed = await trashEntry(deps.fs, codexBackups(codexPaths(deps.home)), ref.entry.entry, clockOf(deps))
  if (!trashed.ok) return refuse(trashed.reason, trashed.message)
  return { ok: true, message: `Removed "${ref.entry.name}"; it is in the backups as ${trashed.name}.`, undo: { type: 'restore', name: trashed.name } }
}

/** Whether `name` is under [mcp_servers] in the user config right now. */
async function serverPresent(deps: ProviderDeps, name: string): Promise<boolean> {
  const text = await deps.fs.readText(codexPaths(deps.home).config)
  if (text === null) return false
  try {
    const servers = (parse(text) as Record<string, unknown>).mcp_servers
    return isObject(servers) && Object.hasOwn(servers, name)
  } catch {
    return false
  }
}

/** Version check, `codex` on PATH, backup of config.toml, then the CLI. Never writes config.toml itself. */
async function runMcpCli(deps: ProviderDeps, argv: string[], versions: Record<string, string>): Promise<{ ok: true; backup: string | null; output: string } | ActionResult> {
  const paths = codexPaths(deps.home)
  const current = await fresh(deps, paths.config, versions)
  if (current === null) return CHANGED
  if ((await deps.exec.find('codex')) === null) return refuse('missing-cli', 'The codex command was not found on PATH, so nothing was changed.')
  const backup = current.text === null ? null : await backUp(deps.fs, codexBackups(paths), paths.config, current.text, clockOf(deps))
  const result = await deps.exec.run('codex', argv, null, { timeoutMs: CLI_TIMEOUT_MS })
  if (!result.ok) {
    const saved = backup === null ? '' : ` ~/.codex/config.toml was backed up first as ${baseName(backup)}.`
    // Only the subcommand is named: argv values never go into a message, and the output is redacted too.
    return refuse('cli-failed', `codex ${argv.slice(0, 2).join(' ')} failed: ${redactCommand(result.output.trim()) || 'no output'}.${saved}`)
  }
  return { ok: true, backup, output: result.output }
}

async function removeServer(deps: ProviderDeps, ref: Ref & { kind: 'mcp' }, versions: Record<string, string>): Promise<ActionResult> {
  if (ref.project !== null) return refuse('not-removable', 'This app never rewrites a project .codex/config.toml; `codex mcp remove` only edits ~/.codex/config.toml.')
  const refused = optionLikeRefusal(ref.name, 'An MCP server name')
  if (refused !== null || !usableServerName(ref.name)) return refuse('not-removable', refused?.output ?? `\`codex mcp remove\` refuses the name "${ref.name}".`)
  const ran = await runMcpCli(deps, ['mcp', 'remove', ref.name], versions)
  if (!('backup' in ran)) return ran
  if (await serverPresent(deps, ref.name)) return refuse('cli-failed', `codex mcp remove ran, but "${ref.name}" is still in ~/.codex/config.toml.`)
  const saved = ran.backup === null ? '' : ` Backup: ${baseName(ran.backup)}.`
  const message = `Removed MCP server "${ref.name}" with codex mcp remove.${saved}`
  // The undo adds the same server back from the backup, when `codex mcp add` can say everything it had.
  const why = ran.backup === null ? 'there was no config.toml to back up' : addableServer(ref.name, ref.server)
  if (why !== null) return { ok: true, message: `${message} No undo: ${why}.` }
  return { ok: true, message, undo: { type: 'move', key: itemKey('mcp', ran.backup!, ref.name), to: { project: null }, copy: true } }
}

/** Why `codex mcp add NAME -- COMMAND ARGS` cannot recreate this server exactly, or null when it can. */
function addableServer(name: string, server: Json): string | null {
  const why = copyableServer(server)
  if (why !== null) return `\`codex mcp add\` cannot recreate it: ${why}`
  for (const [value, what] of [
    [name, 'An MCP server name'],
    [String(server.command), 'An MCP server command']
  ] as const) {
    const refused = optionLikeRefusal(value, what)
    if (refused !== null) return refused.output
  }
  return null
}

/** `codex mcp add` for one server; refuses a name already in config.toml, and checks the CLI really added it. */
async function addServer(deps: ProviderDeps, name: string, server: Json, versions: Record<string, string>): Promise<{ ok: true; saved: string } | ActionResult> {
  if (await serverPresent(deps, name)) return refuse('exists', `~/.codex/config.toml already has a server named "${name}".`)
  const args = Array.isArray(server.args) ? server.args.map(String) : []
  // Everything after `--` is the server's command line; codex never reads it as options.
  const ran = await runMcpCli(deps, ['mcp', 'add', name, '--', String(server.command), ...args], versions)
  if (!('backup' in ran)) return ran
  if (!(await serverPresent(deps, name))) return refuse('cli-failed', `codex mcp add ran, but "${name}" is not in ~/.codex/config.toml.`)
  return { ok: true, saved: ran.backup === null ? '' : ` Backup: ${baseName(ran.backup)}.` }
}

/**
 * The undo of a remove: `move` (a copy to global) of a key that names a server in a backup of ~/.codex/config.toml.
 * Anything else is an item that is no longer there.
 */
async function addBackFromBackup(deps: ProviderDeps, action: Action & { type: 'move' }, versions: Record<string, string>): Promise<ActionResult> {
  const paths = codexPaths(deps.home)
  const store = codexBackups(paths)
  let parts: unknown
  try {
    parts = JSON.parse(action.key.slice('mcp:'.length))
  } catch {
    return GONE
  }
  if (!action.key.startsWith('mcp:') || !Array.isArray(parts) || parts.length !== 2 || !parts.every((part) => typeof part === 'string')) return GONE
  const [file, name] = parts as [string, string]
  const backup = baseName(file)
  if (file !== `${store.dir}/${backup}` || backupTarget(store, backup) !== paths.config || !(await listBackups(deps.fs, store)).includes(backup)) return GONE
  if (action.to?.project !== null || action.copy !== true) return refuse('not-movable', 'A server in a backup can only be added back to ~/.codex/config.toml.')
  let server: unknown
  try {
    server = (parse((await deps.fs.readText(file)) ?? '') as Record<string, unknown>).mcp_servers
    server = isObject(server) && Object.hasOwn(server, name) ? server[name] : undefined
  } catch {
    server = undefined
  }
  if (!isObject(server)) return refuse('unknown-backup', `${backup} has no MCP server named "${name}".`)
  const why = usableServerName(name) ? addableServer(name, server) : `\`codex mcp add\` refuses the name "${name}"`
  if (why !== null) return refuse('not-movable', `"${name}" cannot be added back: ${why}.`)
  const added = await addServer(deps, name, server, versions)
  if (!('saved' in added)) return added
  return {
    ok: true,
    message: `Added MCP server "${name}" back to ~/.codex/config.toml with codex mcp add.${added.saved}`,
    undo: { type: 'remove', key: itemKey('mcp', paths.config, name) }
  }
}

async function copyServer(deps: ProviderDeps, read: CodexRead, ref: Ref & { kind: 'mcp' }, action: Action & { type: 'move' }, versions: Record<string, string>): Promise<ActionResult> {
  const item = read.view.items.find((candidate) => candidate.key === action.key)
  if (ref.project === null || action.to.project !== null) return refuse('not-movable', item?.notMovableReason ?? 'Codex MCP servers can only be copied from a project to global.')
  if (!action.copy) return refuse('not-movable', 'This app never rewrites a project .codex/config.toml, so a project server can only be copied to global.')
  if (!item?.movable) return refuse('not-movable', item?.notMovableReason ?? `"${ref.name}" cannot be copied.`)
  const why = copyableServer(ref.server)
  if (why !== null) return refuse('not-movable', `"${ref.name}" cannot be copied: ${why}.`)
  const optionLike = addableServer(ref.name, ref.server)
  if (optionLike !== null) return refuse('not-movable', optionLike)
  const added = await addServer(deps, ref.name, ref.server, versions)
  if (!('saved' in added)) return added
  return {
    ok: true,
    message: `Copied MCP server "${ref.name}" to ~/.codex/config.toml with codex mcp add.${added.saved}`,
    undo: { type: 'remove', key: itemKey('mcp', codexPaths(deps.home).config, ref.name) }
  }
}

async function restore(deps: ProviderDeps, read: CodexRead, name: string): Promise<ActionResult> {
  const paths = codexPaths(deps.home)
  const store = codexBackups(paths)
  if (isTrashName(name)) {
    const dirs = [null, ...read.view.projects].flatMap((project) => [...skillDirs(paths, project), agentDir(paths, project)])
    const restored = await restoreTrash(deps.fs, store, name, dirs, 'Codex')
    if (!restored.ok) return refuse(restored.reason, restored.message)
    return { ok: true, message: `Put back ${tilde(deps.home, restored.target)}.` }
  }
  const target = backupTarget(store, name)
  if (target === null) return refuse('unknown-backup', `${name} is not a known backup.`)
  return refuse(
    'read-only',
    `${name} is a copy of ${tilde(deps.home, target)}, which this app never writes. ` +
      `To put it back by hand: cp "${store.dir}/${name}" "${target}"`
  )
}

async function snapshot(deps: ProviderDeps): Promise<ActionResult> {
  const paths = codexPaths(deps.home)
  const saved: string[] = []
  for (const file of [paths.config, paths.hooks]) {
    const text = await deps.fs.readText(file)
    if (text !== null) saved.push(baseName(await backUp(deps.fs, codexBackups(paths), file, text, clockOf(deps))))
  }
  if (saved.length === 0) return refuse('missing', 'There is no ~/.codex/config.toml or hooks.json to back up.')
  return { ok: true, message: `Backed up ${saved.join(' and ')}.` }
}
