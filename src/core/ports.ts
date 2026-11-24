// The only way the core touches the disk. Adapters implement it; tests fake it.
export interface FileSystem {
  /** The file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>
  /** Entry names directly inside a directory, or [] when it does not exist. */
  listEntries(dir: string): Promise<string[]>
}

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeDir: string
  /** Usually ~/.claude.json */
  userConfigFile: string
}
