// Moves, copies and removes MCP servers. Only through the official CLI: ~/.claude.json is rewritten by
// Claude Code all the time, so it is read here but never written. Files the CLI changes are backed up first.
import { isObject, knownProjects, versionOf, type Json } from './inventory.ts'
import type { ClaudePaths, FileSystem, PluginCli } from './ports.ts'
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
      reason: 'changed' | 'exists' | 'same-place' | 'unknown-project' | 'cli-failed' | 'partial'
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
  const refuse = (reason: 'changed' | 'exists' | 'same-place' | 'unknown-project', message: string): McpResult => ({
    ok: false,
    reason,
    message,
    backups: []
  })
  if (to.project === ref.project && cliScope(to) === cliScope(ref)) return refuse('same-place', `"${ref.name}" is already there.`)
  if (to.project !== null && !(await knownProjects(fs, paths)).includes(to.project)) {
    return refuse('unknown-project', `${to.project} is not a project Claude Code knows.`)
  }
  const stale = await staleFile(fs, paths, [ref, to], versions)
  if (stale !== null) return refuse('changed', `${stale} changed since it was read. Refresh and try again.`)
  if (Object.hasOwn(await serversAt(fs, paths, to), ref.name)) {
    return refuse('exists', `An MCP server named "${ref.name}" is already there. Remove or rename one of them first.`)
  }

  const backups = await backUpFiles(fs, paths, copy ? [to] : [to, ref], clock)
  const added = await cli.mcpAdd(ref.name, JSON.stringify(ref.config), cliScope(to), to.project)
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
