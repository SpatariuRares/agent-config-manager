// The Codex provider (codex-cli 0.171.0).
//
// Sources, checked 2026-11-24; nothing here is from memory:
// - `codex --help`, `codex mcp --help`, `codex mcp add|remove|list|get --help`, `codex plugin --help`,
//   `codex plugin add|remove|list|marketplace --help` (codex-cli 0.171.0): MCP has add/remove; plugins have
//   add/remove/list/marketplace and NO enable/disable command.
// - openai/codex@rust-v0.171.0 codex-rs/cli/src/mcp_cmd.rs: `mcp add`/`mcp remove` only edit the global
//   $CODEX_HOME/config.toml (load_global_mcp_servers + ConfigEditsBuilder, which uses toml_edit); server names must
//   match [A-Za-z0-9_:@/.-]+ (validate_server_name); `mcp add --url` may start a browser OAuth login right after
//   adding; `mcp list --json` loads auth and prints http_headers verbatim (secrets).
// - Config reference, https://learn.chatgpt.com/docs/config-file/config-reference (was
//   developers.openai.com/codex/config-reference): `mcp_servers.<id>` (command, args, env, env_vars, cwd, url,
//   http_headers, bearer_token_env_var, enabled, ...), `plugins.<plugin@marketplace>.enabled` (+ `plugins._default`),
//   `marketplaces.<name>.{source,source_type,ref}`, `agents.<name>.{description,config_file}`,
//   `projects.<path>.trust_level`, project-scoped `.codex/config.toml` loaded only for trusted projects.
// - Skills, https://learn.chatgpt.com/docs/build-skills.md, and openai/codex@rust-v0.171.0
//   codex-rs/ext/skills/src/host_roots_tests.rs + codex-rs/exec-server/src/discoverV2/capability_locations.rs:
//   user roots $CODEX_HOME/skills and $HOME/.agents/skills, system $CODEX_HOME/skills/.system, project
//   <project>/.codex/skills and <dir>/.agents/skills from cwd up to the repo root; a skill is a folder with SKILL.md.
// - Subagents, https://learn.chatgpt.com/docs/agent-configuration/subagents.md: one standalone TOML file per agent
//   in ~/.codex/agents/ or <project>/.codex/agents/, with name, description, developer_instructions.
// - Hooks, https://learn.chatgpt.com/docs/hooks.md: $CODEX_HOME/hooks.json, <project>/.codex/hooks.json, and
//   [hooks] in config.toml; shape {hooks: {<Event>: [{matcher?, hooks: [{type, command|server+tool, ...}]}]}};
//   trust is recorded per hook hash ([hooks.state."<file>:<event>:<group>:<handler>"] in the real config.toml), so
//   a new or changed hook is skipped until reviewed again in /hooks.
// - Plugin cache, openai/codex@rust-v0.171.0 codex-rs/core-plugin-common/src/installed.rs: plugins/cache/
//   <marketplace>/<plugin>/<version>, active version `local` else the highest; manifest .codex-plugin/plugin.json
//   (name, version, description, skills, mcpServers, hooks), confirmed on ~/.codex/plugins/cache.
//
// What this app writes, and why the rest is read-only:
// - config.toml: never written here. smol-toml cannot keep comments and formatting, and restoring a backup would
//   also be a write, so a restore of a config.toml backup is refused with the command to do it by hand.
// - MCP: user servers are removed with `codex mcp remove NAME`; a project server is copied to the user config with
//   `codex mcp add NAME -- COMMAND ARGS...` only when that recreates it exactly (stdio, command and args only)
//   and its command line holds nothing secret-looking (argv is visible to other programs).
//   Both back up config.toml first and refuse a stale view. The view reads config.toml itself, not
//   `codex mcp list --json`: the file is exactly what `codex mcp remove` edits, reading it runs no process, and the
//   CLI output would carry secrets (http_headers) and auth state into the panel.
// - Skills and agent files: moved, copied and trashed through the toolkit (whole files and folders, no TOML edits).
//   Skills in ~/.agents/skills and <project>/.agents/skills are read-only: Gemini CLI and Copilot CLI read those
//   folders too. Moves land in ~/.codex/skills or <project>/.codex/skills.
// - Plugins and hooks: read-only (see NOTE).
import type { ActionType, AgentInfo, Kind, ProjectScope } from '../../adapters/view.ts'
import { KINDS, type AgentProvider } from '../types.ts'
import { codexAction } from './actions.ts'
import { CODEX, codexPaths, readCodex } from './read.ts'

/** What works today, per class. Plugins and hooks are read-only; see NOTE. */
export const CODEX_SUPPORTS: Partial<Record<Kind, ActionType[]>> = {
  skills: ['move', 'remove', 'restore', 'snapshot'],
  agents: ['move', 'remove', 'restore', 'snapshot'],
  mcp: ['move', 'remove', 'snapshot']
}

/**
 * Skills and agent files go to the project's own folders, which are shared (moveFile ignores the scope).
 * MCP servers never go into a project: a project .codex/config.toml is never written (copyServer).
 */
export const CODEX_PROJECT_SCOPES: Partial<Record<Kind, ProjectScope[]>> = {
  skills: ['project'],
  agents: ['project']
}

export const CODEX_NOTE =
  'Plugins and hooks are read-only: Codex has no command to turn a plugin on or off, and editing hooks.json changes ' +
  'the hashes Codex trusts hooks by, so it would skip them until you review them again in /hooks. ' +
  '~/.codex/config.toml is never rewritten here: MCP servers are removed with `codex mcp remove`, and a project ' +
  'server can only be copied to global with `codex mcp add` (stdio servers with just a command and args, and no secret on that command line). ' +
  'Skills in ~/.agents/skills and <project>/.agents/skills are read-only, because other agents (Gemini CLI, Copilot CLI) read them too; ' +
  'a skill moved into a project goes to <project>/.codex/skills. ' +
  'Project .codex/config.toml files, [agents] roles and AGENTS.md are read-only.'

export function codexProvider(): AgentProvider {
  return {
    id: CODEX,
    async info(deps): Promise<AgentInfo> {
      const paths = codexPaths(deps.home)
      const detected = (await deps.exec.find('codex')) !== null || (await deps.fs.realPath(paths.codexHome)) !== null
      return {
        id: CODEX,
        name: 'Codex',
        detected,
        kinds: [...KINDS],
        supports: Object.fromEntries(Object.entries(CODEX_SUPPORTS).map(([kind, actions]) => [kind, [...(actions ?? [])]])),
        projectScopes: Object.fromEntries(Object.entries(CODEX_PROJECT_SCOPES).map(([kind, scopes]) => [kind, [...(scopes ?? [])]])),
        configHome: '~/.codex',
        note: CODEX_NOTE
      }
    },
    buildView: async (deps) => (await readCodex(deps)).view,
    runAction: (deps, request) => codexAction(deps, request)
  }
}

export const codex = codexProvider()
