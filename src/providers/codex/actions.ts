// Codex writes. config.toml is never written by this app: MCP changes go through `codex mcp add/remove`
// (format-preserving toml_edit inside Codex) as guarded changes (version check, backup of config.toml, the CLI,
// then a re-read that proves the server is there or gone). Skill folders and agent files are moved, copied and
// trashed through the core toolkit. Restore and snapshot are the router's, from codexBackupPlan.
import type { Action, ActionRequest, ActionResult } from '../../adapters/view.ts'
import {
  admitMcp,
  backupTarget,
  guardedChange,
  isObject,
  itemKey,
  listBackups,
  moveEntry,
  optionLikeRefusal,
  tilde,
  trashEntry,
  versionRefusal,
  type BackupPlan,
  type EntryPlaces,
  type FileSystem,
  type ProviderDeps
} from '../toolkit.ts'
import { parse } from 'smol-toml'
import { addableServer, CODEX_ADD } from './mcp-add.ts'
import { agentDir, codexBackups, codexMcpConfig, codexPaths, destinationDir, readCodex, skillDirs, usableServerName, type CodexRead, type Ref } from './read.ts'
import type { Admitted, Json } from '../toolkit.ts'

/** `codex mcp add/remove` can take a while on first run; never wait forever. */
const CLI_TIMEOUT_MS = 60_000

const GONE: ActionResult = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' }
const refuse = (reason: string, message: string): ActionResult & { ok: false } => ({ ok: false, reason, message })
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
    default:
      return refuse('unsupported', `Codex cannot do "${action.type}" here.`)
  }
}

/**
 * What restore and snapshot work with (the router runs them). config.toml and hooks.json are backed up but never
 * written back: Codex owns them, so a restore answers with the `cp` to run by hand. Trashed skills and agents go
 * back to Codex's own folders, globally and in the projects it knows.
 */
export async function codexBackupPlan(deps: ProviderDeps): Promise<BackupPlan> {
  const paths = codexPaths(deps.home)
  const projects = (await readCodex(deps)).view.projects
  const owned = (file: string) => ({ file, reason: 'read-only', why: 'this app never writes' })
  return {
    owner: 'Codex',
    store: codexBackups(paths),
    files: [],
    owned: [owned(paths.config), owned(paths.hooks)],
    entryFolders: [null, ...projects].flatMap((project) => [...skillDirs(paths, project), agentDir(paths, project)]),
    say: (path) => tilde(deps.home, path)
  }
}

export function places(deps: ProviderDeps, read: CodexRead): EntryPlaces {
  const paths = codexPaths(deps.home)
  return { dirOf: (kind, project) => destinationDir(paths, kind, project), projects: async () => read.view.projects, owner: 'Codex' }
}

async function moveFile(deps: ProviderDeps, read: CodexRead, ref: Ref & { kind: 'skills' | 'agents' }, action: Action & { type: 'move' }, versions: Record<string, string>): Promise<ActionResult> {
  if (!ref.movable) return refuse('not-movable', ref.reason ?? `"${ref.entry.name}" cannot be moved.`)
  if (ref.project === null && action.to.project === null) return refuse('same-place', `"${ref.entry.name}" is already global.`)
  const stale = await versionRefusal(changeDeps(deps), [ref.file], versions)
  if (stale !== null) return stale
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
  const stale = await versionRefusal(changeDeps(deps), [ref.file], versions)
  if (stale !== null) return stale
  const trashed = await trashEntry(deps.fs, codexBackups(codexPaths(deps.home)), ref.entry.entry, clockOf(deps))
  if (!trashed.ok) return refuse(trashed.reason, trashed.message)
  return { ok: true, message: `Removed "${ref.entry.name}"; it is in the backups as ${trashed.name}.`, undo: { type: 'restore', name: trashed.name } }
}

/** Whether `name` is under [mcp_servers] in the user config right now. */
async function hasServer(fs: FileSystem, file: string, name: string): Promise<boolean> {
  const text = await fs.readText(file)
  if (text === null) return false
  try {
    const servers = (parse(text) as Record<string, unknown>).mcp_servers
    return isObject(servers) && Object.hasOwn(servers, name)
  } catch {
    return false
  }
}

const changeDeps = (deps: ProviderDeps) => ({
  fs: deps.fs,
  exec: deps.exec,
  store: codexBackups(codexPaths(deps.home)),
  clock: clockOf(deps),
  say: (path: string) => tilde(deps.home, path)
})

/**
 * `codex <argv>` as a guarded change of config.toml: version check, `codex` on PATH, backup, the CLI, then the
 * re-read that proves `name` is there (`present`) or gone. Never writes config.toml itself.
 */
async function runMcpChange(deps: ProviderDeps, argv: string[], name: string, present: boolean, versions: Record<string, string>) {
  const { config } = codexPaths(deps.home)
  const stale = await versionRefusal(changeDeps(deps), [config], versions)
  if (stale !== null) return stale
  if ((await deps.exec.find('codex')) === null) return refuse('missing-cli', 'The codex command was not found on PATH, so nothing was changed.')
  return guardedChange(changeDeps(deps), {
    files: [config],
    versions,
    steps: [
      {
        effect: { kind: 'cli', command: 'codex', argv, cwd: null, options: { timeoutMs: CLI_TIMEOUT_MS } },
        about: name,
        check: { file: config, holds: async (fs) => (await hasServer(fs, config, name)) === present }
      }
    ]
  })
}

async function removeServer(deps: ProviderDeps, ref: Ref & { kind: 'mcp' }, versions: Record<string, string>): Promise<ActionResult> {
  if (ref.project !== null) return refuse('not-removable', 'This app never rewrites a project .codex/config.toml; `codex mcp remove` only edits ~/.codex/config.toml.')
  const refused = optionLikeRefusal(ref.name, 'An MCP server name')
  if (refused !== null || !usableServerName(ref.name)) return refuse('not-removable', refused?.output ?? `\`codex mcp remove\` refuses the name "${ref.name}".`)
  const ran = await runMcpChange(deps, ['mcp', 'remove', ref.name], ref.name, false, versions)
  if (!ran.ok) return ran
  const backup = ran.backups.get(codexPaths(deps.home).config)
  const saved = backup === undefined ? '' : ` Backup: ${baseName(backup)}.`
  const message = `Removed MCP server "${ref.name}" with codex mcp remove.${saved}`
  // The undo adds the same server back from the backup, when `codex mcp add` can say everything it had.
  const why = backup === undefined ? 'there was no config.toml to back up.' : addableWhy(ref.name, ref.server)
  if (why !== null) return { ok: true, message: `${message} No undo: ${why}` }
  return { ok: true, message, undo: { type: 'move', key: itemKey('mcp', backup!, ref.name), to: { project: null }, copy: true } }
}

/** Why `codex mcp add` cannot recreate this Codex server exactly (a full sentence), or null when it can. */
function addableWhy(name: string, server: Json): string | null {
  const admitted = admitMcp(codexMcpConfig(name, server), CODEX_ADD)
  return admitted.ok ? addableServer(name, admitted.server.command!) : admitted.message
}

/** `codex mcp add` for one admitted server; refuses a name already in config.toml, and checks the CLI really added it. */
export async function addServer(
  deps: ProviderDeps,
  server: Extract<Admitted, { ok: true }>['server'],
  versions: Record<string, string>
): Promise<{ ok: true; saved: string } | ActionResult> {
  const { name } = server
  const { config } = codexPaths(deps.home)
  if (await hasServer(deps.fs, config, name)) return refuse('exists', `~/.codex/config.toml already has a server named "${name}".`)
  // Everything after `--` is the server's command line; codex never reads it as options.
  const ran = await runMcpChange(deps, ['mcp', 'add', name, '--', server.command!, ...(server.args ?? [])], name, true, versions)
  if (!ran.ok) return ran
  const backup = ran.backups.get(config)
  return { ok: true, saved: backup === undefined ? '' : ` Backup: ${baseName(backup)}.` }
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
  if (!usableServerName(name)) return refuse('not-movable', `"${name}" cannot be added back: \`codex mcp add\` refuses the name.`)
  const admitted = admitMcp(codexMcpConfig(name, server), CODEX_ADD)
  if (!admitted.ok) return admitted.reason === 'secret' ? admitted : refuse('not-movable', admitted.message)
  const optionLike = addableServer(name, admitted.server.command!)
  if (optionLike !== null) return refuse('not-movable', optionLike)
  const added = await addServer(deps, admitted.server, versions)
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
  const admitted = admitMcp(codexMcpConfig(ref.name, ref.server), CODEX_ADD)
  if (!admitted.ok) return admitted.reason === 'secret' ? admitted : refuse('not-movable', admitted.message)
  const optionLike = addableServer(ref.name, admitted.server.command!)
  if (optionLike !== null) return refuse('not-movable', optionLike)
  const added = await addServer(deps, admitted.server, versions)
  if (!('saved' in added)) return added
  return {
    ok: true,
    message: `Copied MCP server "${ref.name}" to ~/.codex/config.toml with codex mcp add.${added.saved}`,
    undo: { type: 'remove', key: itemKey('mcp', codexPaths(deps.home).config, ref.name) }
  }
}
