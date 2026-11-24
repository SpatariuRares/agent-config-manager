// Shared test doubles for the core.
import type { FileSystem } from './ports.ts'

export const paths = { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' }

/** An in-memory FileSystem over a flat path -> text map; directories are implied by paths. */
export function fakeFs(files: Record<string, string>): FileSystem & { files: Record<string, string> } {
  return {
    files,
    async readText(path) {
      return files[path] ?? null
    },
    async listEntries(dir) {
      const prefix = `${dir}/`
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0])
      return [...new Set(names)].sort()
    }
  }
}
