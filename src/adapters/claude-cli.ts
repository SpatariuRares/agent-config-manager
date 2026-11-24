// PluginCli over the real `claude`, `npx` and `git` binaries. Every call passes argv, never a shell.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { CliResult, PluginCli } from '../core/ports.ts'

// Apps like Orca may start workers without the shell's PATH, so look in the usual places too.
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/usr/bin']

/** The first executable called `name` on `path`, then in the usual install folders; null when there is none. */
export async function findCommand(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of [...path.split(delimiter).filter(Boolean), ...FALLBACK_DIRS]) {
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

export const findClaude = (path?: string) => findCommand('claude', path)

type Finder = () => Promise<string | null>

export function claudeCli(
  binary: Finder = () => findClaude(),
  tools: { npx?: Finder; git?: Finder } = {}
): PluginCli {
  const npx = tools.npx ?? (() => findCommand('npx'))
  const git = tools.git ?? (() => findCommand('git'))

  async function exec(name: string, find: Finder, args: string[], cwd: string | null, timeout = 120_000): Promise<CliResult> {
    const command = await find()
    if (command === null) return { ok: false, output: `The ${name} command was not found.` }
    // npx is a node script: its own folder goes first on PATH so `node` is found even without the shell's PATH.
    const env = { ...process.env, PATH: [dirname(command), process.env.PATH].filter(Boolean).join(delimiter) }
    return new Promise((resolve) => {
      execFile(command, args, { cwd: cwd ?? homedir(), timeout, env }, (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() || String(error ?? '') })
      })
    })
  }
  const run = (args: string[], cwd: string | null) => exec('claude', binary, args, cwd)

  return {
    uninstall: (id, scope, cwd) => run(['plugin', 'uninstall', id, '--scope', scope, '--keep-data', '--json'], cwd),
    mcpAdd: (name, json, scope, cwd) =>
      optionLike(name, 'An MCP server name') ?? run(['mcp', 'add-json', name, json, '--scope', scope], cwd),
    mcpRemove: (name, scope, cwd) => optionLike(name, 'An MCP server name') ?? run(['mcp', 'remove', name, '--scope', scope], cwd),
    pluginUpdate: (id, scope, cwd, acceptCommand) =>
      optionLike(id, 'A plugin id') ??
      run(['plugin', 'update', id, '--scope', scope, '--json', ...(acceptCommand ? ['--accept-command', acceptCommand] : [])], cwd),
    marketplaceUpdate: () => run(['plugin', 'marketplace', 'update'], null),
    skillsUpdate: (name) => optionLike(name, 'A skill name') ?? exec('npx', npx, ['-y', 'skills', 'update', name, '-g', '-y'], null, 300_000),
    git: (args, cwd) => exec('git', git, args, cwd, 30_000)
  }
}

/** A name like `-h` would be read by the CLI as an option, so it is refused before running anything. */
function optionLike(name: string, what: string): Promise<CliResult> | null {
  if (!name.startsWith('-')) return null
  const fix = what === 'An MCP server name' ? '; rename it in its config file' : ''
  return Promise.resolve({ ok: false, output: `${what} cannot start with "-" (${name})${fix}.` })
}
