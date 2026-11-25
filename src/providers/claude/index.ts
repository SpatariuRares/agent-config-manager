// The Claude Code provider: the behavior this app always had, behind the AgentProvider interface.
import type { ActionType, AgentInfo, Kind, ProjectScope } from '../../adapters/view.ts'
import { KINDS, type AgentProvider, type ProviderDeps } from '../types.ts'
import { CLAUDE, claudeAction, claudeView } from './actions.ts'
import { claudeCliOver } from './cli.ts'
import { claudePaths, type ClaudeDeps, type ClaudePaths, type PluginCli } from './ports.ts'
import { exportClaude, importClaude } from './transfer.ts'
import { checkClaudeUpdates } from './updates.ts'

/** What works today, per class. Backups (restore, snapshot) cover every class's writes. */
export const CLAUDE_SUPPORTS: Record<Kind, ActionType[]> = {
  plugins: ['move', 'remove', 'setEnabled', 'clearOverride', 'uninstall', 'update', 'updateAll', 'refreshMarketplaces', 'restore', 'snapshot'],
  skills: ['move', 'remove', 'update', 'updateAll', 'restore', 'snapshot'],
  agents: ['move', 'remove', 'restore', 'snapshot'],
  mcp: ['move', 'remove', 'update', 'updateAll', 'restore', 'snapshot'],
  hooks: ['move', 'remove', 'restore', 'snapshot']
}

/**
 * Where a move into a project may go. Plugins, MCP servers and hooks have an only-me file there
 * (.claude/settings.local.json, ~/.claude.json) next to the team one, and only me stays the default.
 * Skills and agents have no scope: they always land in the project's .claude/ folder (moveEntry ignores it).
 */
export const CLAUDE_PROJECT_SCOPES: Record<Kind, ProjectScope[]> = {
  plugins: ['local', 'project'],
  skills: ['project'],
  agents: ['project'],
  mcp: ['local', 'project'],
  hooks: ['local', 'project']
}

/** 'copyToAgent': what Claude Code hands to another agent, and takes from one (./transfer.ts). */
export const CLAUDE_EXPORTS: Kind[] = ['skills', 'mcp']
export const CLAUDE_IMPORTS: Kind[] = ['skills', 'mcp']

export interface ClaudeOverrides {
  /** Defaults to ~/.claude and ~/.claude.json under `deps.home`. */
  paths?: ClaudePaths
  /** Defaults to the `claude`, `npx` and `git` binaries through `deps.exec`. */
  cli?: PluginCli
}

/** The Claude Code provider. Overrides exist for tests that drive the CLI double directly. */
export function claudeProvider(overrides: ClaudeOverrides = {}): AgentProvider {
  const claude = (deps: ProviderDeps): ClaudeDeps => ({
    fs: deps.fs,
    cli: overrides.cli ?? claudeCliOver(deps.exec),
    paths: overrides.paths ?? claudePaths(deps.home),
    clock: deps.clock,
    http: deps.http
  })
  return {
    id: CLAUDE,
    async info(deps): Promise<AgentInfo> {
      const { fs, paths } = claude(deps)
      const detected =
        (await fs.realPath(paths.claudeDir)) !== null ||
        (await fs.realPath(paths.userConfigFile)) !== null ||
        (await deps.exec.find('claude')) !== null
      return {
        id: CLAUDE,
        name: 'Claude Code',
        detected,
        kinds: [...KINDS],
        supports: Object.fromEntries(Object.entries(CLAUDE_SUPPORTS).map(([kind, actions]) => [kind, [...actions]])),
        projectScopes: Object.fromEntries(Object.entries(CLAUDE_PROJECT_SCOPES).map(([kind, scopes]) => [kind, [...scopes]])),
        exports: [...CLAUDE_EXPORTS],
        imports: [...CLAUDE_IMPORTS],
        configHome: '~/.claude'
      }
    },
    buildView: (deps) => claudeView(claude(deps)),
    runAction: (deps, request) => claudeAction(claude(deps), request),
    checkUpdates: (deps) => checkClaudeUpdates({ ...claude(deps), http: deps.http }),
    exportItem: (deps, key) => exportClaude(claude(deps), key),
    importItem: (deps, item, to, versions) => importClaude(claude(deps), item, to, versions)
  }
}
