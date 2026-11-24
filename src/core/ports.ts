// The only way the core touches the disk. Adapters implement it; tests fake it.
export interface FileSystem {
  /** The file's text, or null when it does not exist. */
  readText(path: string): Promise<string | null>
  /** Entry names directly inside a directory, or [] when it does not exist. */
  listEntries(dir: string): Promise<string[]>
  /** Replaces the file in one step (no half-written file), creating missing folders. */
  writeText(path: string, text: string): Promise<void>
}

export interface ClaudePaths {
  /** Usually ~/.claude */
  claudeDir: string
  /** Usually ~/.claude.json */
  userConfigFile: string
}
