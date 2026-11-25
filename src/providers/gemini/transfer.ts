// 'copyToAgent' for Gemini CLI: MCP servers and skills out to another agent, and in from one.
// Out: any server or skill the view shows (an export only reads). In:
// - an MCP server through `gemini mcp add`, like a move (./actions.ts): the settings file is version checked and
//   backed up, the CLI runs in the project for project scope, and the file is read back. add takes env and headers
//   on its command line (-e KEY=VALUE, -H "Name: value"), so only `${VAR}` references or values that look like no
//   secret go there, and a project's settings file, shared with the team, takes references only. add splits an env
//   value at "=" and trims header values, so values it would change are refused rather than written changed.
// - a skill folder is copied into Gemini CLI's own folder (~/.gemini/skills, <project>/.gemini/skills) with the
//   toolkit's moveEntry: never overwriting, a link kept as a link. `gemini skills install` is not used: it
//   overwrites a skill of the same name without asking and needs --consent. This app offers no skill remove for
//   Gemini CLI, so there is no undo; the message says how to remove it.
import type { ActionResult, Target } from '../../adapters/view.ts'
import {
  exportSkill,
  itemKey,
  moveEntry,
  optionLikeRefusal,
  portableMcp,
  secretRefusal,
  shellQuote,
  skillEntry,
  type Exported,
  type Portable,
  type PortableMcp,
  type ProviderDeps
} from '../toolkit.ts'
import { contextOf, done, gemini, guard, hasServer, refuse, scopeArg, unchanged } from './actions.ts'
import { settingsOf, type GeminiPaths } from './paths.ts'
import { readSetup, transportOf } from './read.ts'

const GONE = refuse('changed', 'That item is no longer there. The view was refreshed; try again.')

export async function exportGemini(deps: ProviderDeps, paths: GeminiPaths, key: string): Promise<Exported> {
  const setup = await readSetup(deps.fs, paths)
  const ref = setup.refs.get(key)
  const item = setup.view.items.find((candidate) => candidate.key === key)
  if (ref === undefined || item === undefined) return GONE
  if (ref.kind === 'skills') return exportSkill(deps.fs, item.name, item.source)
  if (ref.kind !== 'mcp') return GONE
  const { config } = ref.server
  const { command, args, env, url, httpUrl, type, headers, ...rest } = config
  return portableMcp(ref.server.name, { transport: transportOf(config), command, args, url: httpUrl ?? url, env, headers }, Object.keys(rest))
}

/** Why `gemini mcp add` could not write these env or header entries as they are, or null. */
function cliLimits(item: PortableMcp): string | null {
  const env = Object.entries(item.env ?? {}).filter(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === '' || value.includes('='))
  if (env.length > 0) {
    return `"${item.name}" has env entries gemini mcp add cannot write as they are (${env.map(([key]) => key).join(', ')}): it splits each at "=" and drops empty values.`
  }
  const headers = Object.entries(item.headers ?? {}).filter(([key, value]) => !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || key.startsWith('-') || value.trim() === '' || value !== value.trim())
  if (headers.length > 0) {
    return `"${item.name}" has headers gemini mcp add cannot write as they are (${headers.map(([key]) => key).join(', ')}): it trims values and drops empty ones.`
  }
  return null
}

/** `gemini mcp add` for a Portable server; options first (-e and -H take one value each), then name and command. */
function addArgv(item: PortableMcp, project: string | null): string[] {
  const env = Object.entries(item.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const headers = Object.entries(item.headers ?? {}).flatMap(([key, value]) => ['-H', `${key}: ${value}`])
  const tail = item.transport === 'stdio' ? [item.command!, ...(item.args?.length ? ['--', ...item.args] : [])] : [item.url!]
  return ['mcp', 'add', '--scope', scopeArg(project), '--transport', item.transport, ...env, ...headers, item.name, ...tail]
}

export async function importGemini(deps: ProviderDeps, paths: GeminiPaths, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult> {
  const ctx = contextOf(deps, paths, versions)
  const setup = await readSetup(deps.fs, paths)
  const project = to.project
  if (project !== null && !setup.projects.includes(project)) return refuse('unknown-project', `${project} is not a project Gemini CLI knows.`)
  if (project !== null && to.scope === 'local') {
    return refuse('refused', 'Gemini CLI has no only-me settings for a project: its .gemini folder is shared. Choose Team.')
  }
  const place = project === null ? 'Global' : ctx.say(project)

  if (item.kind === 'skills') {
    const dirOf = (_kind: string, at: string | null) => (at === null ? `${paths.dir}/skills` : `${at}/.gemini/skills`)
    const copied = await moveEntry(deps.fs, { owner: 'Gemini CLI', projects: async () => setup.projects, dirOf }, skillEntry(item), project, true)
    if (!copied.ok) return copied
    // `gemini skills uninstall` takes the skill's folder name, which can differ from the name in its SKILL.md.
    const folder = copied.path.slice(copied.path.lastIndexOf('/') + 1)
    const remove = shellQuote(['gemini', 'skills', 'uninstall', folder, ...(project === null ? [] : ['--scope', 'workspace'])])
    return done(`Copied skill "${item.name}" to ${ctx.say(copied.path)}. To remove it: ${remove}${project === null ? '' : ' (run in the project)'}`)
  }

  const secret = secretRefusal(item, { commandLine: 'gemini mcp add', teamFile: project !== null })
  if (secret !== null) return secret
  const limits = cliLimits(item)
  if (limits !== null) return refuse('not-portable', limits)
  for (const [value, what] of [
    [item.name, 'The server name'],
    [item.command ?? item.url ?? '', 'The command or url']
  ] as const) {
    const optionLike = optionLikeRefusal(value, what)
    if (optionLike) return refuse('refused', optionLike.output)
  }
  const file = settingsOf(paths, project)
  if (setup.places.find((p) => p.file === file)?.broken) return refuse('unreadable', `${ctx.say(file)} is not valid JSON; it was left untouched.`)
  if (await hasServer(ctx, file, item.name)) return refuse('exists', `${place} already has an MCP server named ${item.name}. Rename or remove one of them first.`)
  const guarded = await guard(ctx, [file])
  if (!guarded.ok) return guarded
  const argv = addArgv(item, project)
  const added = await gemini(ctx, argv, item.name, project)
  if (!added.ok) return added
  if (!(await hasServer(ctx, file, item.name))) return unchanged(argv, item.name, file, added.output, ctx.say)
  return done(`Copied MCP server "${item.name}" to ${place} with gemini mcp add.`, { type: 'remove', key: itemKey('mcp', project, item.name) })
}
