// The argv of every `claude`, `npx` and `git` run the Claude Code provider makes outside a guarded change, run
// through the shared CommandRunner seam (ProviderDeps.exec): always by argv, never a shell. The `claude mcp`
// writes are guarded changes in ./mcp.ts.
import { optionLikeRefusal, type CliResult, type CommandRunner } from '../toolkit.ts'

const claude = (exec: CommandRunner, args: string[], cwd: string | null) => exec.run('claude', args, cwd, { timeoutMs: 120_000 })

/** `claude plugin uninstall`; `cwd` is the project folder for a project or local install. */
export const pluginUninstall = (exec: CommandRunner, id: string, scope: string, cwd: string | null) =>
  claude(exec, ['plugin', 'uninstall', id, '--scope', scope, '--keep-data', '--json'], cwd)

/**
 * `claude plugin update <id> --scope <scope> --json`, plus `--accept-command <sha256>` only when the user confirmed
 * that command; never `-y`. `cwd` is the project folder for a project or local install (null: home).
 */
export const pluginUpdate = (exec: CommandRunner, id: string, scope: string, cwd: string | null, acceptCommand?: string) =>
  optionLike(id, 'A plugin id') ??
  claude(exec, ['plugin', 'update', id, '--scope', scope, '--json', ...(acceptCommand ? ['--accept-command', acceptCommand] : [])], cwd)

/** `claude plugin marketplace update`. */
export const marketplaceUpdate = (exec: CommandRunner) => claude(exec, ['plugin', 'marketplace', 'update'], null)

/** `npx -y skills update <name> -g -y` (a skill installed globally by the `skills` CLI). */
export const skillsUpdate = (exec: CommandRunner, name: string) =>
  optionLike(name, 'A skill name') ?? exec.run('npx', ['-y', 'skills', 'update', name, '-g', '-y'], null, { timeoutMs: 300_000 })

/** `git <args>` in `cwd`, for read-only questions such as `rev-parse`. */
export const git = (exec: CommandRunner, args: string[], cwd: string) => exec.run('git', args, cwd, { timeoutMs: 30_000 })

/** A name like `-h` would be read by the CLI as an option, so it is refused before running anything. */
function optionLike(name: string, what: string): Promise<CliResult> | null {
  const refused = optionLikeRefusal(name, what)
  return refused === null ? null : Promise.resolve(refused)
}
