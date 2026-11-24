// Shared test doubles for the core.
import type { FileSystem, PluginCli } from './ports.ts'

export const paths = { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' }

/** An in-memory FileSystem over a flat path -> text map; directories are implied by paths. */
export function fakeFs(files: Record<string, string>): FileSystem & { files: Record<string, string> } {
  return {
    files,
    async readText(path) {
      return files[path] ?? null
    },
    async writeText(path, text) {
      files[path] = text
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
