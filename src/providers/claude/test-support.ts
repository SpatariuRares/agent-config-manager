// Test doubles for the Claude Code provider: its paths, a recording `claude` CLI (the PluginCli, and the
// `claude mcp` runs it answers through the CommandRunner, changing the files as Claude Code would), and the panel
// contract over them.
import { fakeFs } from '../../core/test-support.ts'
import type { CliResult, CommandRunner, FileSystem, Http } from '../../core/ports.ts'
import type { ActionAnswer, ActionRequest, AgentRequest, UpdatesAnswer, ViewAnswer } from '../../adapters/view.ts'
import { routeAction, routeUpdates, routeView } from '../router.ts'
import type { ProviderDeps } from '../types.ts'
import { claudeProvider } from './index.ts'
import type { ClaudeDeps, ClaudePaths, PluginCli } from './ports.ts'

export { fakeFs }

export const paths = { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' }

/** Claude deps in a test: the CommandRunner is built from the fake CLI (claudeExec). */
export type TestDeps = Omit<ClaudeDeps, 'exec'>

/** The shared deps and a one-agent registry for Claude deps built around a PluginCli double. */
function routed(deps: TestDeps) {
  const home = deps.paths.claudeDir.slice(0, deps.paths.claudeDir.lastIndexOf('/'))
  const shared: ProviderDeps = { fs: deps.fs, exec: claudeExec(deps), home, clock: deps.clock, http: deps.http }
  return { shared, providers: [claudeProvider({ cli: deps.cli, paths: deps.paths })] }
}

/**
 * A CommandRunner whose `claude mcp add-json|remove` runs are answered by the fake CLI in `deps.cli` (read at run
 * time, so a test may swap it): recorded in its `calls`, failing as it says, and on success writing the server into
 * (or out of) ~/.claude.json or the project's .mcp.json as Claude Code does, unless the fake is `silent`. It finds
 * no command and runs nothing else.
 */
export function claudeExec(deps: { fs: FileSystem; paths: ClaudePaths; cli: PluginCli }): CommandRunner {
  return {
    find: async () => null,
    async run(command, argv, cwd) {
      const cli = deps.cli as Partial<FakeCli>
      if (command !== 'claude' || argv[0] !== 'mcp' || cli.mcp === undefined) return { ok: false, output: `The ${command} command was not found.` }
      const result = cli.mcp(argv, cwd)
      if (result.ok && !cli.silent) await writeServer(deps.fs, deps.paths, argv, cwd)
      return result
    }
  }
}

/** What `claude mcp add-json <name> <json> --scope s` or `claude mcp remove <name> --scope s` does to the files. */
async function writeServer(fs: FileSystem, paths: ClaudePaths, argv: readonly string[], cwd: string | null) {
  const [, sub, name] = argv
  const scope = argv[argv.indexOf('--scope') + 1]
  const file = scope === 'project' ? `${cwd}/.mcp.json` : paths.userConfigFile
  const root = JSON.parse((await fs.readText(file)) ?? '{}')
  const servers = scope === 'local' ? (((root.projects ??= {})[cwd ?? ''] ??= {}).mcpServers ??= {}) : (root.mcpServers ??= {})
  if (sub === 'add-json') servers[name] = JSON.parse(argv[3])
  else delete servers[name]
  await fs.writeText(file, scope === 'project' ? JSON.stringify(root, null, 2) + '\n' : JSON.stringify(root))
}

/** 'view.get' for Claude Code alone, through the real router. */
export function buildView(deps: TestDeps, request: AgentRequest = {}): Promise<ViewAnswer> {
  const { shared, providers } = routed(deps)
  return routeView(shared, providers, request)
}

/** 'action.run' for Claude Code alone, through the real router (support checks included). */
export function runAction(deps: TestDeps, request: ActionRequest): Promise<ActionAnswer> {
  const { shared, providers } = routed(deps)
  return routeAction(shared, providers, request)
}

/** 'updates.check' for Claude Code alone, through the real router. */
export function checkUpdates(deps: TestDeps & { http: Http }, request: AgentRequest = {}): Promise<UpdatesAnswer> {
  const { shared, providers } = routed(deps)
  return routeUpdates({ ...shared, http: deps.http }, providers, request)
}

type Reply<A extends unknown[]> = (...args: A) => CliResult | Promise<CliResult>

/** Scripted answers for the update commands; each defaults to success with no output (git: failure). */
export interface FakeReplies {
  pluginUpdate?: Reply<[id: string, scope: string, cwd: string | null, acceptCommand?: string]>
  marketplaceUpdate?: Reply<[]>
  skillsUpdate?: Reply<[name: string]>
  git?: Reply<[args: string[], cwd: string]>
}

export type FakeCli = PluginCli & {
  calls: string[]
  /** A `claude mcp add-json|remove` run (argv after `claude`), recorded and answered; claudeExec writes the files. */
  mcp(argv: readonly string[], cwd: string | null): CliResult
  /** When true, a `claude mcp` run that succeeds changes no file: a CLI that exits 0 and did nothing. */
  silent: boolean
}

/**
 * A PluginCli that records its calls, each written as the command line it stands for. A call fails when
 * `failing` lists its scope (any command) or `<command>:<scope>`, where command is uninstall, mcp-add or mcp-remove.
 */
export function fakeCli(failing: string[] = [], replies: FakeReplies = {}): FakeCli {
  const calls: string[] = []
  const answer = (command: string, scope: string) =>
    failing.includes(scope) || failing.includes(`${command}:${scope}`)
      ? { ok: false, output: `cannot ${command} in ${scope}` }
      : { ok: true, output: '' }
  return {
    calls,
    silent: false,
    mcp(argv, cwd) {
      calls.push(`${argv.join(' ')} @ ${cwd ?? '-'}`)
      return answer(argv[1] === 'add-json' ? 'mcp-add' : 'mcp-remove', argv[argv.indexOf('--scope') + 1])
    },
    async uninstall(id, scope, cwd) {
      calls.push(`${id} ${scope} ${cwd ?? '-'}`)
      const result = answer('uninstall', scope)
      return result.ok ? result : { ok: false, output: `cannot uninstall from ${scope}` }
    },
    async pluginUpdate(id, scope, cwd, acceptCommand) {
      const accept = acceptCommand === undefined ? '' : ` --accept-command ${acceptCommand}`
      calls.push(`plugin update ${id} --scope ${scope} --json${accept} @ ${cwd ?? '-'}`)
      return replies.pluginUpdate ? replies.pluginUpdate(id, scope, cwd, acceptCommand) : { ok: true, output: '' }
    },
    async marketplaceUpdate() {
      calls.push('plugin marketplace update')
      return replies.marketplaceUpdate ? replies.marketplaceUpdate() : { ok: true, output: '' }
    },
    async skillsUpdate(name) {
      calls.push(`npx -y skills update ${name} -g -y`)
      return replies.skillsUpdate ? replies.skillsUpdate(name) : { ok: true, output: '' }
    },
    async git(args, cwd) {
      calls.push(`git ${args.join(' ')} @ ${cwd}`)
      return replies.git ? replies.git(args, cwd) : { ok: false, output: 'fatal: not a git repository' }
    }
  }
}
