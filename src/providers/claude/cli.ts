// PluginCli over the CommandRunner port: `claude`, `npx` and `git`, always by argv, never a shell.
import { optionLikeRefusal } from '../../core/cli.ts'
import type { CliResult, CommandRunner } from '../../core/ports.ts'
import type { PluginCli } from './ports.ts'

export function claudeCliOver(exec: CommandRunner): PluginCli {
  const run = (args: string[], cwd: string | null) => exec.run('claude', args, cwd, { timeoutMs: 120_000 })
  return {
    uninstall: (id, scope, cwd) => run(['plugin', 'uninstall', id, '--scope', scope, '--keep-data', '--json'], cwd),
    mcpAdd: (name, json, scope, cwd) =>
      optionLike(name, 'An MCP server name') ?? run(['mcp', 'add-json', name, json, '--scope', scope], cwd),
    mcpRemove: (name, scope, cwd) => optionLike(name, 'An MCP server name') ?? run(['mcp', 'remove', name, '--scope', scope], cwd),
    pluginUpdate: (id, scope, cwd, acceptCommand) =>
      optionLike(id, 'A plugin id') ??
      run(['plugin', 'update', id, '--scope', scope, '--json', ...(acceptCommand ? ['--accept-command', acceptCommand] : [])], cwd),
    marketplaceUpdate: () => run(['plugin', 'marketplace', 'update'], null),
    skillsUpdate: (name) =>
      optionLike(name, 'A skill name') ?? exec.run('npx', ['-y', 'skills', 'update', name, '-g', '-y'], null, { timeoutMs: 300_000 }),
    git: (args, cwd) => exec.run('git', args, cwd, { timeoutMs: 30_000 })
  }
}

/** A name like `-h` would be read by the CLI as an option, so it is refused before running anything. */
function optionLike(name: string, what: string): Promise<CliResult> | null {
  const refused = optionLikeRefusal(name, what, what === 'An MCP server name' ? '; rename it in its config file' : '')
  return refused === null ? null : Promise.resolve(refused)
}
