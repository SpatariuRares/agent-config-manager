// The Claude Code provider: the behavior this app always had, behind the AgentProvider interface.
import type { ActionType, AgentInfo, Kind, ProjectScope } from '../../adapters/view.ts'
import { KINDS, tilde, type AgentProvider, type BackupPlan, type ProviderDeps } from '../toolkit.ts'
import { CLAUDE, claudeAction, claudeView, entryKey, NOTE } from './actions.ts'
import { claudeBackups, claudePaths, isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile } from './inventory.ts'
import { CLAUDE_ADD_JSON, CLAUDE_ADD_JSON_TEAM } from './mcp.ts'
import { entryDir, mcpFile } from './setup.ts'
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

/**
 * What restore and snapshot work with (the router runs both, ../backup-actions.ts). The store is the historical
 * ~/.claude/backups/claude-config-manager; the files are every settings file this app writes, globally and in every
 * known project (a project Claude Code no longer lists is not restorable); trashed skills and agents go back to their
 * .claude folders. ~/.claude.json is backed up but never restored.
 */
async function claudeBackupPlan({ fs, home }: ProviderDeps): Promise<BackupPlan> {
  const paths = claudePaths(home)
  const projects = await knownProjects(fs, paths)
  const files = [settingsFile(paths)]
  for (const project of projects) {
    for (const scope of ['project', 'local'] as const) {
      const file = projectSettingsFile(project, scope)
      if (!(await isUserSettingsFile(fs, paths, file))) files.push(file)
    }
    files.push(mcpFile(project))
  }
  return {
    owner: 'Claude Code',
    store: claudeBackups(paths),
    files,
    owned: [{ file: paths.userConfigFile, reason: 'claude-owned', why: 'Claude Code rewrites all the time, so this app never writes it; quit Claude Code first' }],
    entryFolders: [null, ...projects].flatMap((project) => (['skills', 'agents'] as const).map((kind) => entryDir(paths, kind, project))),
    say: (path) => tilde(home, path),
    note: NOTE,
    entryKey: (target) => entryKey(target.slice(0, target.lastIndexOf('/')).endsWith('/skills') ? 'skills' : 'agents', target)
  }
}

/** The Claude Code provider. Its config is found under `deps.home`; every CLI runs through `deps.exec`. */
export function claudeProvider(): AgentProvider {
  return {
    id: CLAUDE,
    mcpDestinations: [CLAUDE_ADD_JSON, CLAUDE_ADD_JSON_TEAM],
    async info(deps): Promise<AgentInfo> {
      const paths = claudePaths(deps.home)
      const detected =
        (await deps.fs.realPath(paths.claudeDir)) !== null ||
        (await deps.fs.realPath(paths.userConfigFile)) !== null ||
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
    buildView: claudeView,
    runAction: claudeAction,
    backups: claudeBackupPlan,
    checkUpdates: checkClaudeUpdates,
    exportItem: exportClaude,
    importItem: importClaude
  }
}
