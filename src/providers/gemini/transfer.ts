// 'copyToAgent' for Gemini CLI: MCP servers and skills out to another agent, and in from one.
// Out: any server or skill the view shows (an export only reads). In:
// - an MCP server through `gemini mcp add`, like a move (./actions.ts): the settings file is version checked and
//   backed up, the CLI runs in the project for project scope, and the file is read back. The server is admitted
//   against GEMINI_ADD (GEMINI_ADD_TEAM for a project) and written with the move's own argv builder, addArgv;
//   argvLimits refuses env and header values add would change.
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
  shellQuote,
  skillEntry,
  admitMcp,
  type Exported,
  type Portable,
  type ProviderDeps
} from '../toolkit.ts'
import { addArgv, argvLimits, contextOf, done, gemini, guard, hasServer, refuse, unchanged } from './actions.ts'
import { GEMINI_ADD, GEMINI_ADD_TEAM } from './mcp-add.ts'
import { settingsOf, type GeminiPaths } from './paths.ts'
import { geminiMcpConfig, readSetup } from './read.ts'

const GONE = refuse('changed', 'That item is no longer there. The view was refreshed; try again.')

export async function exportGemini(deps: ProviderDeps, paths: GeminiPaths, key: string): Promise<Exported> {
  const setup = await readSetup(deps.fs, paths)
  const ref = setup.refs.get(key)
  const item = setup.view.items.find((candidate) => candidate.key === key)
  if (ref === undefined || item === undefined) return GONE
  if (ref.kind === 'skills') return exportSkill(deps.fs, item.name, item.source)
  if (ref.kind !== 'mcp') return GONE
  return portableMcp(geminiMcpConfig(ref.server.name, ref.server.config))
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

  const admitted = admitMcp(item, project === null ? GEMINI_ADD : GEMINI_ADD_TEAM)
  if (!admitted.ok) return admitted
  const limits = argvLimits(admitted.server)
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
  const argv = addArgv(admitted.server, project)
  const added = await gemini(ctx, argv, item.name, project)
  if (!added.ok) return added
  if (!(await hasServer(ctx, file, item.name))) return unchanged(argv, item.name, file, added.output, ctx.say)
  return done(`Copied MCP server "${item.name}" to ${place} with gemini mcp add.`, { type: 'remove', key: itemKey('mcp', project, item.name) })
}
