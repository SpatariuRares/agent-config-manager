// Moves, copies and removes MCP servers. Only through the official CLI: ~/.claude.json is rewritten by
// Claude Code all the time, so it is read here but never written. Files the CLI changes are backed up first.
import { claudeMcpConfig, isObject, knownProjects, versionOf, type Json } from './inventory.ts'
import type { FileSystem } from '../../core/ports.ts'
import { admitMcp, commandLine, type Admitted, type Carries, type McpConfig } from '../mcp-policy.ts'
import { mcpJson } from '../portable.ts'
import type { ClaudePaths, PluginCli } from './ports.ts'
import { mcpFile, type Place } from './setup.ts'
import { backUp, type Clock } from './toggle.ts'

export interface McpRef extends Place {
  name: string
  config: Json
}

export type McpResult =
  | { ok: true; backups: string[] }
  | {
      ok: false
      reason: 'changed' | 'exists' | 'same-place' | 'unknown-project' | 'secret' | 'not-movable' | 'cli-failed' | 'partial'
      message: string
      backups: string[]
    }

/** The `--scope` of a place: user globally, else the project's team (.mcp.json) or only-me (~/.claude.json). */
const cliScope = (place: Place) => (place.project === null ? 'user' : place.scope)
const fileOf = (paths: ClaudePaths, place: Place) =>
  place.project !== null && place.scope === 'project' ? mcpFile(place.project) : paths.userConfigFile

export async function moveMcp(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  ref: McpRef,
  to: Place,
  versions: Record<string, string>,
  copy: boolean,
  clock: Clock
): Promise<McpResult> {
  const refuse = (reason: 'changed' | 'exists' | 'same-place' | 'unknown-project' | 'secret' | 'not-movable', message: string): McpResult => ({
    ok: false,
    reason,
    message,
    backups: []
  })
  if (to.project === ref.project && cliScope(to) === cliScope(ref)) return refuse('same-place', `"${ref.name}" is already there.`)
  if (to.project !== null && !(await knownProjects(fs, paths)).includes(to.project)) {
    return refuse('unknown-project', `${to.project} is not a project Claude Code knows.`)
  }
  const admitted = admitClaude(claudeMcpConfig(ref.name, ref.config), to)
  if (!admitted.ok) return refuse(admitted.reason === 'secret' ? 'secret' : 'not-movable', admitted.message)
  const stale = await staleFile(fs, paths, [ref, to], versions)
  if (stale !== null) return refuse('changed', `${stale} changed since it was read. Refresh and try again.`)
  if (Object.hasOwn(await serversAt(fs, paths, to), ref.name)) {
    return refuse('exists', `An MCP server named "${ref.name}" is already there. Remove or rename one of them first.`)
  }

  const backups = await backUpFiles(fs, paths, copy ? [to] : [to, ref], clock)
  const added = await cli.mcpAdd(ref.name, JSON.stringify(claudeJson(admitted.server)), cliScope(to), to.project)
  if (!added.ok) return { ok: false, reason: 'cli-failed', message: added.output, backups }
  if (copy) return { ok: true, backups }
  const removed = await cli.mcpRemove(ref.name, cliScope(ref), ref.project)
  if (!removed.ok) return { ok: false, reason: 'partial', message: removed.output, backups }
  return { ok: true, backups }
}

export async function removeMcp(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  ref: McpRef,
  versions: Record<string, string>,
  clock: Clock
): Promise<McpResult> {
  const stale = await staleFile(fs, paths, [ref], versions)
  if (stale !== null) return { ok: false, reason: 'changed', message: `${stale} changed since it was read. Refresh and try again.`, backups: [] }
  const backups = await backUpFiles(fs, paths, [ref], clock)
  const removed = await cli.mcpRemove(ref.name, cliScope(ref), ref.project)
  if (!removed.ok) return { ok: false, reason: 'cli-failed', message: removed.output, backups }
  return { ok: true, backups }
}

/**
 * What `claude mcp add-json` carries, as the McpServerConfigSchema it parses (stdio: command, args, env; sse and
 * http: url, headers; see "Add MCP servers from JSON configuration", code.claude.com/docs/en/mcp). Claude Code
 * reads back every key it wrote, so a move keeps the server's other keys (oauth, headersHelper...) as they are.
 */
const ADD_JSON: Carries = { transports: ['stdio', 'http', 'sse'], fields: ['args', 'env', 'headers'], keeps: () => true }

/** Every Claude Code MCP write: `claude mcp add-json` takes the whole config on its command line. */
export const CLAUDE_ADD_JSON = commandLine('`claude mcp add-json`', { team: false, carries: ADD_JSON })
/** The same command line, writing a project .mcp.json, which the team shares. */
export const CLAUDE_ADD_JSON_TEAM = commandLine('`claude mcp add-json`', { team: true, carries: ADD_JSON, hint: 'Or choose only me.' })

/** The Destination of a place: a project's team .mcp.json is shared, every other place is private to the user. */
export const admitClaude = (config: McpConfig, to: Place): Admitted =>
  admitMcp(config, to.project !== null && to.scope === 'project' ? CLAUDE_ADD_JSON_TEAM : CLAUDE_ADD_JSON)

/** The config `claude mcp add-json` takes for an admitted server: its fields, then the keys Claude Code kept. */
export const claudeJson = (server: Extract<Admitted, { ok: true }>['server']): Json => ({ ...(mcpJson(server, 'stdio') as object), ...server.rest })

/**
 * Adds a server that comes from another agent ('copyToAgent') with `claude mcp add-json` in `to`: the target file
 * is version checked and backed up first, and a name already there is refused. The caller has admitted the
 * server against admitClaude (add-json takes the whole config on its command line).
 */
export async function addMcp(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  name: string,
  config: Json,
  to: Place,
  versions: Record<string, string>,
  clock: Clock
): Promise<McpResult> {
  if (to.project !== null && !(await knownProjects(fs, paths)).includes(to.project)) {
    return { ok: false, reason: 'unknown-project', message: `${to.project} is not a project Claude Code knows.`, backups: [] }
  }
  const stale = await staleFile(fs, paths, [to], versions)
  if (stale !== null) return { ok: false, reason: 'changed', message: `${stale} changed since it was read. Refresh and try again.`, backups: [] }
  if (Object.hasOwn(await serversAt(fs, paths, to), name)) {
    return { ok: false, reason: 'exists', message: `An MCP server named "${name}" is already there. Remove or rename one of them first.`, backups: [] }
  }
  const backups = await backUpFiles(fs, paths, [to], clock)
  const added = await cli.mcpAdd(name, JSON.stringify(config), cliScope(to), to.project)
  if (!added.ok) return { ok: false, reason: 'cli-failed', message: added.output, backups }
  return { ok: true, backups }
}

/** The first .mcp.json that changed since the view; ~/.claude.json is not checked (Claude Code rewrites it). */
async function staleFile(fs: FileSystem, paths: ClaudePaths, places: Place[], versions: Record<string, string>) {
  for (const place of places) {
    const file = fileOf(paths, place)
    if (file !== paths.userConfigFile && versionOf(await fs.readText(file)) !== (versions[file] ?? '')) return file
  }
  return null
}

async function serversAt(fs: FileSystem, paths: ClaudePaths, place: Place): Promise<Json> {
  let json: Json = {}
  try {
    json = JSON.parse((await fs.readText(fileOf(paths, place))) ?? '{}')
  } catch {
    // Unreadable: the CLI will report it.
  }
  const map = !isObject(json)
    ? undefined
    : place.project === null
      ? json.mcpServers
      : place.scope === 'project'
        ? json.mcpServers
        : json.projects?.[place.project]?.mcpServers
  return isObject(map) ? map : {}
}

async function backUpFiles(fs: FileSystem, paths: ClaudePaths, places: Place[], clock: Clock): Promise<string[]> {
  const backups: string[] = []
  for (const file of [...new Set(places.map((place) => fileOf(paths, place)))]) {
    const text = await fs.readText(file)
    if (text !== null) backups.push(await backUp(fs, paths, file, text, clock))
  }
  return backups
}

/**
 * Replaces a server's config in its own place: backs up its file, then `claude mcp remove` and `claude mcp add-json`
 * with the new config. A failed remove changes nothing; a failed add after it is `partial` (the server is gone,
 * its old config is in the backup).
 */
export async function replaceMcp(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  ref: McpRef,
  config: Json,
  versions: Record<string, string>,
  clock: Clock
): Promise<McpResult> {
  const stale = await staleFile(fs, paths, [ref], versions)
  if (stale !== null) return { ok: false, reason: 'changed', message: `${stale} changed since it was read. Refresh and try again.`, backups: [] }
  const backups = await backUpFiles(fs, paths, [ref], clock)
  const removed = await cli.mcpRemove(ref.name, cliScope(ref), ref.project)
  if (!removed.ok) return { ok: false, reason: 'cli-failed', message: removed.output, backups }
  const added = await cli.mcpAdd(ref.name, JSON.stringify(config), cliScope(ref), ref.project)
  if (!added.ok) return { ok: false, reason: 'partial', message: added.output, backups }
  return { ok: true, backups }
}
