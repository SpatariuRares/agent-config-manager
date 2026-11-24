// Test doubles for the Claude Code provider: its paths, a recording PluginCli, and the panel contract over them.
import { fakeFs } from '../../core/test-support.ts'
import type { CliResult, Http } from '../../core/ports.ts'
import type { ActionAnswer, ActionRequest, AgentRequest, UpdatesAnswer, ViewAnswer } from '../../adapters/view.ts'
import { routeAction, routeUpdates, routeView } from '../router.ts'
import { fakeExec } from '../testing.ts'
import type { ProviderDeps } from '../types.ts'
import { claudeProvider } from './index.ts'
import type { ClaudeDeps, PluginCli } from './ports.ts'

export { fakeFs }

export const paths = { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' }

/** The shared deps and a one-agent registry for Claude deps built around a PluginCli double. */
function routed(deps: ClaudeDeps) {
  const home = deps.paths.claudeDir.slice(0, deps.paths.claudeDir.lastIndexOf('/'))
  const shared: ProviderDeps = { fs: deps.fs, exec: fakeExec(), home, clock: deps.clock, http: deps.http }
  return { shared, providers: [claudeProvider({ cli: deps.cli, paths: deps.paths })] }
}

/** 'view.get' for Claude Code alone, through the real router. */
export function buildView(deps: ClaudeDeps, request: AgentRequest = {}): Promise<ViewAnswer> {
  const { shared, providers } = routed(deps)
  return routeView(shared, providers, request)
}

/** 'action.run' for Claude Code alone, through the real router (support checks included). */
export function runAction(deps: ClaudeDeps, request: ActionRequest): Promise<ActionAnswer> {
  const { shared, providers } = routed(deps)
  return routeAction(shared, providers, request)
}

/** 'updates.check' for Claude Code alone, through the real router. */
export function checkUpdates(deps: ClaudeDeps & { http: Http }, request: AgentRequest = {}): Promise<UpdatesAnswer> {
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

/**
 * A PluginCli that records its calls, each written as the command line it stands for. A call fails when
 * `failing` lists its scope (any command) or `<command>:<scope>`, where command is uninstall, mcp-add or mcp-remove.
 */
export function fakeCli(failing: string[] = [], replies: FakeReplies = {}): PluginCli & { calls: string[] } {
  const calls: string[] = []
  const answer = (command: string, scope: string) =>
    failing.includes(scope) || failing.includes(`${command}:${scope}`)
      ? { ok: false, output: `cannot ${command} in ${scope}` }
      : { ok: true, output: '' }
  return {
    calls,
    async uninstall(id, scope, cwd) {
      calls.push(`${id} ${scope} ${cwd ?? '-'}`)
      const result = answer('uninstall', scope)
      return result.ok ? result : { ok: false, output: `cannot uninstall from ${scope}` }
    },
    async mcpAdd(name, json, scope, cwd) {
      calls.push(`mcp add-json ${name} ${json} --scope ${scope} @ ${cwd ?? '-'}`)
      return answer('mcp-add', scope)
    },
    async mcpRemove(name, scope, cwd) {
      calls.push(`mcp remove ${name} --scope ${scope} @ ${cwd ?? '-'}`)
      return answer('mcp-remove', scope)
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
