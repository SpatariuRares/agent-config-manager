// Shared test doubles for the core.
import { posix } from 'node:path'
import type { FileSystem, PluginCli } from './ports.ts'

export const paths = { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' }

/**
 * An in-memory FileSystem over a flat path -> text map; directories are implied by paths.
 * Paths are normalized like a real disk (`//` and `..`), so aliases reach the same file.
 */
export function fakeFs(files: Record<string, string>): FileSystem & { files: Record<string, string> } {
  const norm = (path: string) => posix.normalize(path).replace(/(.)\/$/, '$1')
  return {
    files,
    async readText(path) {
      return files[norm(path)] ?? null
    },
    async writeText(path, text) {
      files[norm(path)] = text
    },
    async realPath(path) {
      const target = norm(path)
      return Object.keys(files).some((key) => key === target || key.startsWith(`${target}/`)) ? target : null
    },
    async listEntries(dir) {
      const prefix = `${norm(dir)}/`
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0])
      return [...new Set(names)].sort()
    }
  }
}

/** A PluginCli that records its calls and fails for the scopes listed in `failing`. */
export function fakeCli(failing: string[] = []): PluginCli & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async uninstall(id, scope, cwd) {
      calls.push(`${id} ${scope} ${cwd ?? '-'}`)
      return failing.includes(scope) ? { ok: false, output: `cannot uninstall from ${scope}` } : { ok: true, output: '' }
    }
  }
}
