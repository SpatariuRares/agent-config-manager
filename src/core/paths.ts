// Path guards shared by every provider: same-folder checks through aliases and links, occupancy, known projects.
import type { FileSystem } from './ports.ts'

/** Whether two folders are the same on disk (aliases and symlinks count); false when either is missing. */
export async function sameFolder(fs: FileSystem, a: string, b: string): Promise<boolean> {
  const real = await fs.realPath(a)
  return real !== null && real === (await fs.realPath(b))
}

/** Whether anything, a broken symlink included, is at `path`. */
export async function occupied(fs: FileSystem, path: string): Promise<boolean> {
  return (await fs.realPath(path)) !== null || (await fs.linkTarget(path)) !== null
}

/** The absolute folders among `candidates` that still exist, sorted: the projects an agent knows. */
export async function existingProjects(fs: FileSystem, candidates: Iterable<string>): Promise<string[]> {
  const projects: string[] = []
  for (const path of candidates) {
    if (path.startsWith('/') && (await fs.realPath(path)) !== null) projects.push(path)
  }
  return projects.sort()
}

/** `/home/me/x` as `~/x` for messages; other paths unchanged. */
export function tilde(home: string, path: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/**
 * Where this app keeps the backups and trash of an agent: a neutral app folder, never inside the agent's own
 * config home. Claude Code keeps its historical ~/.claude/backups/claude-config-manager instead (see the Claude provider).
 */
export const appBackupDir = (home: string, agent: string) => `${home}/.config/claude-config-manager/backups/${agent}`
