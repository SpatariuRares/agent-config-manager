// What the Claude Code provider needs beyond the shared ports: where Claude Code keeps its setup, and its CLI.
import type { CliResult, Clock, CommandRunner, FileSystem, Http } from '../../core/ports.ts'

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeDir: string
  /** Usually ~/.claude.json */
  userConfigFile: string
}

export const claudePaths = (home: string): ClaudePaths => ({ claudeDir: `${home}/.claude`, userConfigFile: `${home}/.claude.json` })

/**
 * The official `claude` CLI, for the plugin operations Claude Code owns (plugin files, updates). MCP writes
 * (`claude mcp add-json|remove`) are guarded changes run by argv through `ClaudeDeps.exec` (./mcp.ts).
 */
export interface PluginCli {
  /** Runs `claude plugin uninstall`; `cwd` is the project folder for a project or local install. */
  uninstall(id: string, scope: string, cwd: string | null): Promise<CliResult>
  /**
   * Runs `claude plugin update <id> --scope <scope> --json`, plus `--accept-command <sha256>` only when the user
   * confirmed that command; never `-y`. `cwd` is the project folder for a project or local install (null: home).
   */
  pluginUpdate(id: string, scope: string, cwd: string | null, acceptCommand?: string): Promise<CliResult>
  /** Runs `claude plugin marketplace update`. */
  marketplaceUpdate(): Promise<CliResult>
  /** Runs `npx -y skills update <name> -g -y` (a skill installed globally by the `skills` CLI). */
  skillsUpdate(name: string): Promise<CliResult>
  /** Runs `git <args>` in `cwd`, for read-only questions such as `rev-parse`. */
  git(args: string[], cwd: string): Promise<CliResult>
}

/** Everything the Claude Code code below the provider object works with. */
export interface ClaudeDeps {
  fs: FileSystem
  /** Runs `claude mcp add-json|remove` inside guarded changes. */
  exec: CommandRunner
  cli: PluginCli
  paths: ClaudePaths
  clock?: Clock
  /** The network, for update checks and npm updates only. */
  http?: Http
}

export type { Clock } from '../../core/ports.ts'
