// Where GitHub Copilot CLI keeps each class, globally and per project. The sources are listed in ./index.ts.
// A place is `writable` only when it is Copilot's own folder or file. Shared places (.agents/, .claude/, .mcp.json)
// are read by other agents too, so they are shown read-only: changing them here would change those agents as well.
import type { Kind } from '../../adapters/view.ts'
import { appBackupDir, type BackupStore } from '../toolkit.ts'

export const COPILOT = 'copilot'
export const OWNER = 'Copilot CLI'

export interface CopilotPaths {
  home: string
  /** ~/.copilot. COPILOT_HOME can move it; that variable is not followed here (see the note). */
  dir: string
  /** User MCP servers: `{ "mcpServers": { <name>: {...} } }`. */
  mcpFile: string
  /** Copilot's own state (JSONC). Only `trustedFolders` is read from it: the projects. */
  configFile: string
  /** Where `gh copilot` downloads the Copilot CLI when it is not on PATH. */
  ghDownload: string
  /** This app's backups and trash for Copilot, outside ~/.copilot. */
  store: BackupStore
}

export function copilotPaths(home: string): CopilotPaths {
  const dir = `${home}/.copilot`
  return {
    home,
    dir,
    mcpFile: `${dir}/mcp-config.json`,
    configFile: `${dir}/config.json`,
    ghDownload: `${home}/.local/share/gh/copilot`,
    store: { dir: appBackupDir(home, COPILOT), aliases: { 'mcp-config': `${dir}/mcp-config.json` } }
  }
}

/** A folder (skills, agents, hooks) or a file (MCP) that Copilot reads. */
export interface Place {
  path: string
  writable: boolean
}

const own = (path: string): Place => ({ path, writable: true })
const shared = (path: string): Place => ({ path, writable: false })

/** Every place of a class, globally (project null) or in a project. Copilot's own place comes first. */
export function placesOf(paths: CopilotPaths, kind: Kind, project: string | null): Place[] {
  const p = project
  switch (kind) {
    case 'skills':
      return p === null
        ? [own(`${paths.dir}/skills`), shared(`${paths.home}/.agents/skills`)]
        : [own(`${p}/.github/skills`), shared(`${p}/.agents/skills`), shared(`${p}/.claude/skills`)]
    case 'agents':
      return p === null ? [own(`${paths.dir}/agents`)] : [own(`${p}/.github/agents`), shared(`${p}/.claude/agents`)]
    case 'mcp':
      return p === null ? [own(paths.mcpFile)] : [own(`${p}/.github/mcp.json`), shared(`${p}/.mcp.json`)]
    case 'hooks':
      // Hooks are read-only for now (see the note), so neither place is marked writable.
      return [shared(p === null ? `${paths.dir}/hooks` : `${p}/.github/hooks`)]
    case 'plugins':
      return p === null ? [shared(`${paths.dir}/installed-plugins`)] : []
  }
}

/** Copilot's own place of a class: where moves and copies land. */
export const ownPlace = (paths: CopilotPaths, kind: Kind, project: string | null): string =>
  placesOf(paths, kind, project).find((place) => place.writable)?.path ?? ''
