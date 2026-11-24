// The only way the core touches the disk. Adapters implement it; tests fake it.
export interface FileSystem {
  /** The file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>
  /** Entry names directly inside a directory, or [] when it does not exist. */
  listEntries(dir: string): Promise<string[]>
  /** Replaces the file in one step (no half-written file), creating missing folders. */
  writeText(path: string, text: string): Promise<void>
  /** The canonical absolute path (`..`, `//` and symlinks resolved), or null when nothing exists there. */
  realPath(path: string): Promise<string | null>
}

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeDir: string
  /** Usually ~/.claude.json */
  userConfigFile: string
}

/** The official `claude` CLI, for operations Claude Code owns (installing and removing plugin files). */
export interface PluginCli {
  /** Runs `claude plugin uninstall`; `cwd` is the project folder for a project or local install. */
  uninstall(id: string, scope: string, cwd: string | null): Promise<{ ok: boolean; output: string }>
}
