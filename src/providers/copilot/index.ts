// The GitHub Copilot CLI provider: the worked example of docs/adding-an-agent.md. It is three small parts:
// ./paths.ts (where each class lives), ./read.ts (the view) and ./write.ts (the actions), all built on ../toolkit.ts.
//
// Sources (checked 2026-11-24; never from memory):
// - Config folder, its files, which ones the CLI manages itself, settings.json vs config.json, COPILOT_HOME:
//   https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
// - `copilot mcp list|get|add|remove|enable|disable` (add and remove change ~/.copilot/mcp-config.json, remove only
//   user-level servers), MCP fields and file priority (.mcp.json and .github/mcp.json in a trusted folder, then
//   ~/.copilot/mcp-config.json; .vscode/mcp.json is not read), skill folders (~/.copilot/skills, ~/.agents/skills,
//   .github/skills, .agents/skills, .claude/skills), agent folders (~/.copilot/agents, .github/agents, .claude/agents):
//   https://raw.githubusercontent.com/github/docs/main/content/copilot/reference/copilot-cli-reference/cli-command-reference.md
// - Agent profiles are `<name>.md` or `<name>.agent.md` with `name` and `description` in the frontmatter:
//   https://docs.github.com/en/copilot/reference/custom-agents-configuration
// - Hooks: `{ "version": 1, "hooks": { <event>: [ { type, bash, powershell, command, exec, args, matcher, ... } ] } }`
//   in ~/.copilot/hooks/*.json and .github/hooks/*.json, or inline under `hooks` in settings.json:
//   https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
// - Plugins: installed under installed-plugins/<marketplace>/<plugin>/ or installed-plugins/_direct/<source>/, manifest
//   plugin.json | .plugin/plugin.json | .github/plugin/plugin.json | .claude-plugin/plugin.json, managed with
//   `copilot plugin install|uninstall|enable|disable|update`; where the enabled state is kept is not documented:
//   https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
// - Trusted folders are `trustedFolders` in ~/.copilot/config.json:
//   https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli
// - Install: `npm install -g @github/copilot`, `brew install --cask copilot-cli`, winget, or the install script; the
//   binary is `copilot`: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
// - `gh copilot` (preview) runs `copilot` from PATH, or downloads it to ~/.local/share/gh/copilot first:
//   https://cli.github.com/manual/gh_copilot
// - On this machine (read-only): `gh --version` 2.105.0 lists "copilot: Run the GitHub Copilot CLI (preview)";
//   `which copilot` finds nothing; ~/.copilot/config.json starts with `//` comment lines (JSONC);
//   ~/.copilot/mcp-config.json is 2-space JSON with a trailing newline.
//
// Detection: the `copilot` binary on PATH, ~/.copilot, or the copy `gh copilot` downloaded. `gh` alone does not
// count: every recent gh has the `copilot` command built in, whether or not the Copilot CLI was ever used.
import type { ActionType, AgentInfo, Kind, ProjectScope } from '../../adapters/view.ts'
import type { AgentProvider } from '../types.ts'
import { COPILOT, copilotPaths, OWNER } from './paths.ts'
import { readCopilot } from './read.ts'
import { exportCopilot, importCopilot } from './transfer.ts'
import { COPILOT_PRIVATE_FILE, COPILOT_TEAM_FILE, runCopilotAction } from './write.ts'

/** What works today, per class. `restore` puts back what a remove or a move changed. */
export const COPILOT_SUPPORTS: Partial<Record<Kind, ActionType[]>> = {
  skills: ['move', 'remove', 'restore'],
  agents: ['move', 'remove', 'restore'],
  mcp: ['move', 'remove', 'restore']
}

/**
 * Everything goes to the project's shared folders: skills and agents through moveEntry (no scope), MCP servers
 * to .github/mcp.json, since Copilot CLI has no only-me MCP file in a project (runCopilotAction refuses 'local').
 */
export const COPILOT_PROJECT_SCOPES: Partial<Record<Kind, ProjectScope[]>> = {
  skills: ['project'],
  agents: ['project'],
  mcp: ['project']
}

/** 'copyToAgent': what Copilot CLI hands to another agent, and takes from one (./transfer.ts). */
export const COPILOT_EXPORTS: Kind[] = ['skills', 'mcp']
export const COPILOT_IMPORTS: Kind[] = ['skills', 'mcp']

export const COPILOT_NOTE = [
  'Plugins are read-only: `copilot plugin` manages them, and where it keeps the on/off state is not documented.',
  'Hooks are read-only, and inline hooks in settings.json are not shown.',
  'Items in shared places (.agents/, .claude/, .mcp.json) are read-only, since other agents read them too.',
  'MCP writes edit mcp-config.json or .github/mcp.json directly, with a backup first.',
  'Skills and MCP servers copied in from another agent land in the same places; a project copy refuses literal env or header values and secret-looking args or urls.',
  'Projects are the folders you trusted in Copilot CLI. COPILOT_HOME is not followed: only ~/.copilot is read.'
].join(' ')

export function copilotProvider(): AgentProvider {
  return {
    id: COPILOT,
    mcpDestinations: [COPILOT_PRIVATE_FILE, COPILOT_TEAM_FILE],
    async info({ fs, exec, home }): Promise<AgentInfo> {
      const paths = copilotPaths(home)
      const detected =
        (await fs.realPath(paths.dir)) !== null || (await fs.realPath(paths.ghDownload)) !== null || (await exec.find('copilot')) !== null
      return {
        id: COPILOT,
        name: OWNER,
        detected,
        kinds: ['plugins', 'skills', 'agents', 'mcp', 'hooks'],
        supports: Object.fromEntries(Object.entries(COPILOT_SUPPORTS).map(([kind, actions]) => [kind, [...actions]])),
        projectScopes: Object.fromEntries(Object.entries(COPILOT_PROJECT_SCOPES).map(([kind, scopes]) => [kind, [...(scopes ?? [])]])),
        exports: [...COPILOT_EXPORTS],
        imports: [...COPILOT_IMPORTS],
        configHome: '~/.copilot',
        note: COPILOT_NOTE
      }
    },
    buildView: async ({ fs, home }) => (await readCopilot(fs, copilotPaths(home))).view,
    runAction: ({ fs, home, clock }, request) => runCopilotAction(fs, copilotPaths(home), clock ?? (() => new Date()), request),
    exportItem: ({ fs, home }, key) => exportCopilot(fs, copilotPaths(home), key),
    importItem: ({ fs, home, clock }, item, to, versions) => importCopilot(fs, copilotPaths(home), clock ?? (() => new Date()), item, to, versions)
  }
}
