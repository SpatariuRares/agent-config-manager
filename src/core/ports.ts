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
  /** Renames a file, folder or symlink (a link moves as a link), creating missing folders. Throws when `dst` exists. */
  move(src: string, dst: string): Promise<void>
  /** Copies a file, folder or symlink recursively, keeping links verbatim. Throws when `dst` exists. */
  copy(src: string, dst: string): Promise<void>
  /** The text of the symlink at `path`, or null when `path` is not a symlink. */
  linkTarget(path: string): Promise<string | null>
}

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeDir: string
  /** Usually ~/.claude.json */
  userConfigFile: string
}

export interface CliResult {
  ok: boolean
  output: string
}

/** The official `claude` CLI, for operations Claude Code owns (plugin files, MCP servers in ~/.claude.json). */
export interface PluginCli {
  /** Runs `claude plugin uninstall`; `cwd` is the project folder for a project or local install. */
  uninstall(id: string, scope: string, cwd: string | null): Promise<CliResult>
  /** Runs `claude mcp add-json <name> <json> --scope <scope>`; `cwd` is the project folder (null: home). */
  mcpAdd(name: string, json: string, scope: string, cwd: string | null): Promise<CliResult>
  /** Runs `claude mcp remove <name> --scope <scope>`; `cwd` is the project folder (null: home). */
  mcpRemove(name: string, scope: string, cwd: string | null): Promise<CliResult>
}
