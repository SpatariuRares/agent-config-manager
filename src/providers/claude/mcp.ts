// Moves, copies, removes and replaces MCP servers. Only through the official CLI: ~/.claude.json is rewritten by
// Claude Code all the time, so it is read here but never written. Each write is a guarded change: the files the CLI
// changes are version checked and backed up first, `claude mcp add-json|remove` runs by argv, then the file is read
// again to prove the server is there (or gone), since a CLI can exit 0 and change nothing.
import { claudeBackups, claudeMcpConfig, claudePaths, isObject, knownProjects, type ClaudePaths, type Json } from './inventory.ts'
import {
  admitMcp,
  commandLine,
  guardedChange,
  mcpJson,
  optionLikeRefusal,
  type Admitted,
  type Carries,
  type ChangeResult,
  type Clock,
  type FileSystem,
  type McpConfig,
  type ProviderDeps,
  type Step
} from '../toolkit.ts'
import { mcpFile, type Place } from './setup.ts'

export interface McpRef extends Place {
  name: string
  config: Json
}

type Own = 'exists' | 'same-place' | 'unknown-project' | 'secret' | 'not-movable' | 'refused'
export type McpResult = ChangeResult | { ok: false; reason: Own; message: string }

const refuse = (reason: Own, message: string): McpResult => ({ ok: false, reason, message })

/** The `--scope` of a place: user globally, else the project's team (.mcp.json) or only-me (~/.claude.json). */
const cliScope = (place: Place) => (place.project === null ? 'user' : place.scope)
/** The file an MCP place lives in: a project's .mcp.json for team, else ~/.claude.json. */
export const mcpPlaceFile = (paths: ClaudePaths, place: Place) =>
  place.project !== null && place.scope === 'project' ? mcpFile(place.project) : paths.userConfigFile

/** `claude mcp add-json <name> <json>` (`json` given) or `claude mcp remove <name>` in a place, proven by a re-read. */
function mcpStep(paths: ClaudePaths, name: string, place: Place, json?: string): Step {
  const argv = json === undefined ? ['mcp', 'remove', name, '--scope', cliScope(place)] : ['mcp', 'add-json', name, json, '--scope', cliScope(place)]
  const present = json !== undefined
  return {
    effect: { kind: 'cli', command: 'claude', argv, cwd: place.project, options: { timeoutMs: 120_000 } },
    about: name,
    check: { file: mcpPlaceFile(paths, place), holds: async (fs) => Object.hasOwn(await serversAt(fs, paths, place), name) === present }
  }
}

/**
 * The guarded change of Claude Code's MCP files. ~/.claude.json is backed up but never version checked: Claude
 * Code rewrites it all the time (sessions, history, caches), so the view's version of it is always stale, and only
 * its own CLI writes it here.
 */
function change(deps: ProviderDeps, clock: Clock, places: Place[], versions: Record<string, string>, steps: [Step] | [Step, Step]) {
  const paths = claudePaths(deps.home)
  return guardedChange(
    { fs: deps.fs, exec: deps.exec, store: claudeBackups(paths), clock },
    { files: [...new Set(places.map((place) => mcpPlaceFile(paths, place)))], versions, unversioned: [paths.userConfigFile], steps }
  )
}

/** A name like `-h` would be read by the CLI as an option, so it is refused before anything runs. */
const optionLike = (name: string): McpResult | null => {
  const refused = optionLikeRefusal(name, 'An MCP server name', '; rename it in its config file')
  return refused === null ? null : refuse('refused', refused.output)
}

export async function moveMcp(deps: ProviderDeps, ref: McpRef, to: Place, versions: Record<string, string>, copy: boolean, clock: Clock): Promise<McpResult> {
  const { fs } = deps
  const paths = claudePaths(deps.home)
  if (to.project === ref.project && cliScope(to) === cliScope(ref)) return refuse('same-place', `"${ref.name}" is already there.`)
  if (to.project !== null && !(await knownProjects(fs, paths)).includes(to.project)) {
    return refuse('unknown-project', `${to.project} is not a project Claude Code knows.`)
  }
  const admitted = admitClaude(claudeMcpConfig(ref.name, ref.config), to)
  if (!admitted.ok) return refuse(admitted.reason === 'secret' ? 'secret' : 'not-movable', admitted.message)
  const named = optionLike(ref.name)
  if (named !== null) return named
  if (Object.hasOwn(await serversAt(fs, paths, to), ref.name)) {
    return refuse('exists', `An MCP server named "${ref.name}" is already there. Remove or rename one of them first.`)
  }
  const add = mcpStep(paths, ref.name, to, JSON.stringify(claudeJson(admitted.server)))
  return copy ? change(deps, clock, [to], versions, [add]) : change(deps, clock, [to, ref], versions, [add, mcpStep(paths, ref.name, ref)])
}

export async function removeMcp(deps: ProviderDeps, ref: McpRef, versions: Record<string, string>, clock: Clock): Promise<McpResult> {
  return optionLike(ref.name) ?? change(deps, clock, [ref], versions, [mcpStep(claudePaths(deps.home), ref.name, ref)])
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
 * Adds a server that comes from another agent ('copyToAgent') with `claude mcp add-json` in `to`, as a guarded
 * change; a name already there is refused. The caller has admitted the server against admitClaude (add-json takes
 * the whole config on its command line).
 */
export async function addMcp(deps: ProviderDeps, name: string, config: Json, to: Place, versions: Record<string, string>, clock: Clock): Promise<McpResult> {
  const { fs } = deps
  const paths = claudePaths(deps.home)
  if (to.project !== null && !(await knownProjects(fs, paths)).includes(to.project)) {
    return refuse('unknown-project', `${to.project} is not a project Claude Code knows.`)
  }
  const named = optionLike(name)
  if (named !== null) return named
  if (Object.hasOwn(await serversAt(fs, paths, to), name)) {
    return refuse('exists', `An MCP server named "${name}" is already there. Remove or rename one of them first.`)
  }
  return change(deps, clock, [to], versions, [mcpStep(paths, name, to, JSON.stringify(config))])
}

async function serversAt(fs: FileSystem, paths: ClaudePaths, place: Place): Promise<Json> {
  let json: Json = {}
  try {
    json = JSON.parse((await fs.readText(mcpPlaceFile(paths, place))) ?? '{}')
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

/**
 * Replaces a server's config in its own place: `claude mcp remove`, then `claude mcp add-json` with the new config,
 * as one guarded change. A failed remove changes nothing; a failed add after it is `partial` (the server is gone,
 * its old config is in the backup the message names).
 */
export async function replaceMcp(deps: ProviderDeps, ref: McpRef, config: Json, versions: Record<string, string>, clock: Clock): Promise<McpResult> {
  const paths = claudePaths(deps.home)
  return optionLike(ref.name) ?? change(deps, clock, [ref], versions, [mcpStep(paths, ref.name, ref), mcpStep(paths, ref.name, ref, JSON.stringify(config))])
}
