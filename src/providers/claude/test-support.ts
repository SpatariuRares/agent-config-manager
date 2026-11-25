// Test doubles for the Claude Code provider: the fake home, a CommandRunner (the shared fakeExec) that answers the
// `claude`, `npx` and `git` runs the provider makes, changing the files as Claude Code would, and the panel
// contract (router) over them. Tests reach Claude Code only through the AgentProvider interface.
import { fakeExec, fakeFs, type FakeFs } from '../../core/test-support.ts'
import type { CliResult, Clock, CommandRunner, Http } from '../../core/ports.ts'
import type { ActionAnswer, ActionRequest, AgentRequest, UpdatesAnswer, ViewAnswer } from '../../adapters/view.ts'
import { routeAction, routeUpdates, routeView } from '../router.ts'
import type { ProviderDeps } from '../types.ts'
import { claudeProvider } from './index.ts'

export { fakeFs }

/** The fake home folder: Claude Code's setup is under /home/.claude and /home/.claude.json. */
export const HOME = '/home'

type Reply<A extends unknown[]> = (...args: A) => CliResult | Promise<CliResult>

/** Scripted answers for the update commands; each defaults to success with no output (git: failure). */
export interface FakeReplies {
  pluginUpdate?: Reply<[id: string, scope: string, cwd: string | null, acceptCommand?: string]>
  marketplaceUpdate?: Reply<[]>
  skillsUpdate?: Reply<[name: string]>
  git?: Reply<[args: string[], cwd: string]>
}

export type FakeClaude = CommandRunner & {
  /** Every run, as `<command> <argv...> @ <cwd or ->` (fakeExec's record). */
  calls: string[]
  /** When true, a `claude mcp` run that succeeds changes no file: a CLI that exits 0 and did nothing. */
  silent: boolean
}

/**
 * A CommandRunner standing in for the `claude`, `npx` and `git` binaries over `fs`. It finds no command on PATH.
 * `claude mcp add-json|remove` writes the server into (or out of) ~/.claude.json or the project's .mcp.json as
 * Claude Code does, unless `silent`. A run fails when `failing` lists its scope (any command) or
 * `<command>:<scope>`, where command is uninstall, mcp-add or mcp-remove. The update commands answer from `replies`.
 */
export function fakeClaude(fs: FakeFs, failing: string[] = [], replies: FakeReplies = {}): FakeClaude {
  const ok: CliResult = { ok: true, output: '' }
  const failed = (command: string, scope: string) => failing.includes(scope) || failing.includes(`${command}:${scope}`)
  const scopeOf = (argv: readonly string[]) => argv[argv.indexOf('--scope') + 1]
  const runner: FakeClaude = {
    ...fakeExec({
      async reply(command, argv, cwd) {
        const line = argv.join(' ')
        if (command === 'claude' && argv[0] === 'mcp') {
          const what = argv[1] === 'add-json' ? 'mcp-add' : 'mcp-remove'
          if (failed(what, scopeOf(argv))) return { ok: false, output: `cannot ${what} in ${scopeOf(argv)}` }
          if (!runner.silent) await writeServer(fs, argv, cwd)
          return ok
        }
        if (command === 'claude' && line.startsWith('plugin uninstall ')) {
          return failed('uninstall', scopeOf(argv)) ? { ok: false, output: `cannot uninstall from ${scopeOf(argv)}` } : ok
        }
        if (command === 'claude' && line.startsWith('plugin update ')) {
          const accept = argv.includes('--accept-command') ? argv[argv.indexOf('--accept-command') + 1] : undefined
          return replies.pluginUpdate ? replies.pluginUpdate(argv[2], scopeOf(argv), cwd, accept) : ok
        }
        if (command === 'claude' && line === 'plugin marketplace update') return replies.marketplaceUpdate ? replies.marketplaceUpdate() : ok
        if (command === 'npx' && line.startsWith('-y skills update ')) return replies.skillsUpdate ? replies.skillsUpdate(argv[3]) : ok
        if (command === 'git') return replies.git ? replies.git([...argv], cwd ?? '') : { ok: false, output: 'fatal: not a git repository' }
        return { ok: false, output: `The ${command} command was not found.` }
      }
    }),
    silent: false
  }
  return runner
}

/** What `claude mcp add-json <name> <json> --scope s` or `claude mcp remove <name> --scope s` does to the files. */
async function writeServer(fs: FakeFs, argv: readonly string[], cwd: string | null) {
  const [, sub, name] = argv
  const scope = argv[argv.indexOf('--scope') + 1]
  const file = scope === 'project' ? `${cwd}/.mcp.json` : `${HOME}/.claude.json`
  const root = JSON.parse((await fs.readText(file)) ?? '{}')
  const servers = scope === 'local' ? (((root.projects ??= {})[cwd ?? ''] ??= {}).mcpServers ??= {}) : (root.mcpServers ??= {})
  if (sub === 'add-json') servers[name] = JSON.parse(argv[3])
  else delete servers[name]
  await fs.writeText(file, scope === 'project' ? JSON.stringify(root, null, 2) + '\n' : JSON.stringify(root))
}

/** What a Claude test holds: the fake files, the fake binaries over them, and maybe a clock and the network. */
export interface TestDeps {
  fs: FakeFs
  exec: FakeClaude
  clock?: Clock
  http?: Http
}

/** A machine with these files, and the fake binaries over them. */
export function machine(files: Record<string, string> = {}, links: Record<string, string> = {}, clock?: Clock): TestDeps {
  const fs = fakeFs(files, links)
  return { fs, exec: fakeClaude(fs), clock }
}

/** The shared deps every provider gets, for this test machine. */
export const providerDeps = (deps: TestDeps): ProviderDeps => ({ fs: deps.fs, exec: deps.exec, home: HOME, clock: deps.clock, http: deps.http })

/** 'view.get' for Claude Code alone, through the real router. */
export function buildView(deps: TestDeps, request: AgentRequest = {}): Promise<ViewAnswer> {
  return routeView(providerDeps(deps), [claudeProvider()], request)
}

/** 'action.run' for Claude Code alone, through the real router (support checks included). */
export function runAction(deps: TestDeps, request: ActionRequest): Promise<ActionAnswer> {
  return routeAction(providerDeps(deps), [claudeProvider()], request)
}

/** 'updates.check' for Claude Code alone, through the real router. */
export function checkUpdates(deps: TestDeps & { http: Http }, request: AgentRequest = {}): Promise<UpdatesAnswer> {
  return routeUpdates({ ...providerDeps(deps), http: deps.http }, [claudeProvider()], request)
}
