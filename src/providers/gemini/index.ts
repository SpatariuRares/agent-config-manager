// The Gemini CLI provider: extensions (as plugins), skills, agents, MCP servers and hooks of Gemini CLI.
//
// Sources (checked against Gemini CLI 0.35.3, the version installed here; "core" is @google/gemini-cli-core,
// "cli" is @google/gemini-cli, both read from the installed package's dist/src, which mirrors
// https://github.com/google-gemini/gemini-cli/tree/v0.35.3/packages):
// - Paths: core config/storage.ts (Storage): ~/.gemini/settings.json, <project>/.gemini/settings.json,
//   ~/.gemini/skills and ~/.agents/skills (and the same two under a project), ~/.gemini/agents and
//   <project>/.gemini/agents, ~/.gemini/projects.json (ProjectRegistry). Workspace settings are not loaded when
//   the workspace is the home folder (cli config/settings.ts _doLoadSettings, isWorkspaceHomeDir).
// - settings.json is JSON with comments: cli config/settings.ts parses it with strip-json-comments and writes it
//   back with updateSettingsFilePreservingFormat.
// - Settings keys: cli config/settingsSchema.ts: mcpServers, mcp.allowed / mcp.excluded, skills.disabled,
//   agents.overrides.<name>.enabled, hooks.<Event>[] = { matcher?, hooks: [{ type, command, name?, timeout? }] },
//   hooksConfig.disabled (hook names, else commands: core hooks/hookRegistry.ts getHookName).
// - MCP transports: core tools/mcp-client.ts createUrlTransport: httpUrl = HTTP, url + type, url alone = HTTP.
// - MCP on/off: cli config/mcp/mcpServerEnablement.ts: ~/.gemini/mcp-server-enablement.json,
//   { "<lowercased name>": { "enabled": false } }, by name for every scope. `gemini mcp enable|disable <name>`
//   (cli commands/mcp/enableDisable.ts) prints "Error: ... not found" and still exits 0, so every write is read back.
// - MCP add/remove: `gemini mcp add|remove --scope user|project` (cli commands/mcp/add.ts, remove.ts), run in the
//   project folder for project scope; add takes env and headers as -e/-H on its command line.
// - Extensions: https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md and cli
//   config/extension-manager.ts: installed only in ~/.gemini/extensions/<dir> with gemini-extension.json (name,
//   version, description, mcpServers) and .gemini-extension-install.json ({ source, type: git | github-release |
//   local | link }); a link extension lives at its source. Contributions: skills/*/SKILL.md, agents/*.md,
//   commands/**/*.toml (folders are namespaces, `a/b.toml` = `a:b`), hooks/hooks.json, mcpServers.
// - Extension on/off: cli config/extensions/extensionEnablement.ts: ~/.gemini/extensions/extension-enablement.json,
//   { "<name>": { "overrides": ["/path/*", "!/path/*"] } }, the last rule matching a folder wins.
//   `gemini extensions enable|disable --scope user|workspace <name>` (cli commands/extensions/enable.ts, disable.ts;
//   `gemini extensions disable --help`) writes a rule for the home folder or for the folder it runs in, and drops
//   the rules of folders inside it. `gemini extensions uninstall <names..>` deletes the folder and its rules;
//   `gemini extensions update [<name>]` updates git and GitHub release extensions and asks on stdin when the new
//   version needs new permissions (cli config/extensions/consent.ts requestConsentNonInteractive).
// - CLI surface: `gemini --help`, `gemini mcp --help`, `gemini mcp add|remove|enable|disable --help`,
//   `gemini extensions --help`, `gemini extensions enable|disable|uninstall|update --help`, `gemini skills --help`,
//   `gemini hooks --help` (only `migrate`), all run on 0.35.3.
// - Not Gemini CLI: ~/.gemini/config/* (agents, skills, hooks.json with PreInvocation events, mcp_config.json with
//   serverUrl, import_manifest.json, plugins) and ~/.gemini/antigravity*. No Gemini CLI 0.35.3 source mentions
//   them; the Antigravity CLI binary ~/.gemini/bin/agy (1.5.16) does (`grep -a` finds config/hooks.json,
//   config/skills, mcp_config.json, import_manifest.json, PreInvocation). This provider never reads them.
// - Never read: ~/.gemini/.env, oauth_creds.json, google_accounts.json, history/, logs/, extension .env files.
import type { ActionType, AgentInfo, Item, Kind, ProjectScope } from '../../adapters/view.ts'
import { KINDS, type AgentProvider } from '../types.ts'
import { geminiAction, geminiBackups } from './actions.ts'
import { GEMINI_ADD, GEMINI_ADD_TEAM } from './mcp-add.ts'
import { geminiPaths } from './paths.ts'
import { GEMINI, readSetup, type Setup } from './read.ts'
import { exportGemini, importGemini } from './transfer.ts'

/** What works, per class. Backups (restore, snapshot) cover the files the CLI changes for these actions. */
export const GEMINI_SUPPORTS: Partial<Record<Kind, ActionType[]>> = {
  plugins: ['setEnabled', 'uninstall', 'update', 'restore', 'snapshot'],
  mcp: ['move', 'remove', 'setEnabled', 'restore', 'snapshot']
}

/**
 * MCP servers go to the project's .gemini/settings.json, which is shared: Gemini CLI has no only-me project file
 * (moveMcp). Skills copied in from another agent go to the project's .gemini/skills, also shared (./transfer.ts).
 */
export const GEMINI_PROJECT_SCOPES: Partial<Record<Kind, ProjectScope[]>> = {
  skills: ['project'],
  mcp: ['project']
}

/** 'copyToAgent': what Gemini CLI hands to another agent, and takes from one (./transfer.ts). */
export const GEMINI_EXPORTS: Kind[] = ['skills', 'mcp']
export const GEMINI_IMPORTS: Kind[] = ['skills', 'mcp']

/** An MCP item carries its switch: off when `gemini mcp disable` turned it off (mcp-server-enablement.json). */
function withSwitches({ view, index }: Setup) {
  const items = view.items.map((item): Item => {
    const found = index.lookup(item.key)
    return found.ok && found.ref.kind === 'mcp' ? { ...item, enabled: found.ref.enabled } : item
  })
  return { ...view, items }
}

const NOTE =
  'Skills, agents and hooks are read-only here: this app does not move or remove them for Gemini CLI. ' +
  'A skill copied in from another agent goes to ~/.gemini/skills or <project>/.gemini/skills; remove it with gemini skills uninstall. ' +
  'Install extensions with gemini extensions install; updates are not checked ahead, since Gemini CLI has no read-only check. ' +
  'An MCP server moved or copied in carries env values and headers only as ${VAR} references or values that look like no secret (they go on the gemini mcp add command line), and references only into a project.'

export function geminiProvider(): AgentProvider {
  return {
    id: GEMINI,
    mcpDestinations: [GEMINI_ADD, GEMINI_ADD_TEAM],
    async info(deps): Promise<AgentInfo> {
      const paths = geminiPaths(deps.home)
      const detected = (await deps.exec.find('gemini')) !== null || (await deps.fs.realPath(paths.dir)) !== null
      return {
        id: GEMINI,
        name: 'Gemini CLI',
        detected,
        kinds: [...KINDS],
        supports: Object.fromEntries(Object.entries(GEMINI_SUPPORTS).map(([kind, actions]) => [kind, [...(actions ?? [])]])),
        projectScopes: Object.fromEntries(Object.entries(GEMINI_PROJECT_SCOPES).map(([kind, scopes]) => [kind, [...(scopes ?? [])]])),
        exports: [...GEMINI_EXPORTS],
        imports: [...GEMINI_IMPORTS],
        configHome: '~/.gemini',
        note: NOTE
      }
    },
    buildView: async (deps) => withSwitches(await readSetup(deps.fs, geminiPaths(deps.home))),
    runAction: (deps, request) => geminiAction(deps, geminiPaths(deps.home), request),
    backups: (deps) => geminiBackups(deps, geminiPaths(deps.home)),
    exportItem: (deps, key) => exportGemini(deps, geminiPaths(deps.home), key),
    importItem: (deps, item, to, versions) => importGemini(deps, geminiPaths(deps.home), item, to, versions)
  }
}
