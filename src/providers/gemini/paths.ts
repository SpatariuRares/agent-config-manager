// Where Gemini CLI 0.35.3 keeps its setup (packages/core/src/config/storage.ts, Storage), and the files this app
// may change. Sources are listed in ./index.ts.
import { appBackupDir, type BackupStore } from '../toolkit.ts'

export interface GeminiPaths {
  home: string
  /** ~/.gemini (Storage.getGlobalGeminiDir). */
  dir: string
  /** ~/.gemini/settings.json (Storage.getGlobalSettingsPath). */
  settings: string
  /** ~/.gemini/extensions (ExtensionStorage.getUserExtensionsDir): extensions are installed for the user only. */
  extensionsDir: string
  /** ~/.gemini/extensions/extension-enablement.json (ExtensionEnablementManager). */
  enablement: string
  /** ~/.gemini/mcp-server-enablement.json (McpServerEnablementManager): `gemini mcp enable|disable`. */
  mcpEnablement: string
  /** ~/.gemini/projects.json (ProjectRegistry): the folders Gemini CLI was started in. */
  projects: string
  backups: BackupStore
}

export function geminiPaths(home: string): GeminiPaths {
  const dir = `${home}/.gemini`
  const paths = {
    home,
    dir,
    settings: `${dir}/settings.json`,
    extensionsDir: `${dir}/extensions`,
    enablement: `${dir}/extensions/extension-enablement.json`,
    mcpEnablement: `${dir}/mcp-server-enablement.json`,
    projects: `${dir}/projects.json`
  }
  return {
    ...paths,
    backups: {
      dir: appBackupDir(home, 'gemini'),
      aliases: { settings: paths.settings, 'extension-enablement': paths.enablement, 'mcp-enablement': paths.mcpEnablement }
    }
  }
}

/** `<project>/.gemini/settings.json` (Storage.getWorkspaceSettingsPath). */
export const projectSettings = (project: string) => `${project}/.gemini/settings.json`

/** The settings file of a place: global (null) or a project. */
export const settingsOf = (paths: GeminiPaths, project: string | null) => (project === null ? paths.settings : projectSettings(project))

/** Skill folders, in the order Gemini CLI reads them (SkillManager.discoverSkills): .gemini/skills, then .agents/skills. */
export const skillDirs = (paths: GeminiPaths, project: string | null) =>
  project === null ? [`${paths.dir}/skills`, `${paths.home}/.agents/skills`] : [`${project}/.gemini/skills`, `${project}/.agents/skills`]

/** Agent folders (Storage.getUserAgentsDir, getProjectAgentsDir). */
export const agentDir = (paths: GeminiPaths, project: string | null) => (project === null ? `${paths.dir}/agents` : `${project}/.gemini/agents`)
