// The only ways the core and the providers touch the machine. Adapters implement them; tests fake them.
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

export interface CliResult {
  ok: boolean
  output: string
}

/**
 * Runs programs by argv, never through a shell, so no argument is ever parsed as shell syntax.
 * Every agent CLI (claude, codex, gemini, copilot, npx, git) goes through this one port.
 */
export interface CommandRunner {
  /**
   * Runs `command` (a name looked up like find(), or an absolute path) with `argv` in `cwd` (null: the home
   * folder). Never throws: a missing command is `{ ok: false, output: 'The <command> command was not found.' }`.
   */
  run(command: string, argv: readonly string[], cwd: string | null, options?: { timeoutMs?: number }): Promise<CliResult>
  /** The absolute path of the executable `name` on PATH (or in the usual install folders), or null. Starts no process. */
  find(name: string): Promise<string | null>
}

export type HttpResult =
  | { ok: true; status: number; json: unknown }
  /** `rateLimited` when the server refused because too many requests were made (e.g. GitHub's hourly limit). */
  | { ok: false; status: number | null; error: string; rateLimited: boolean }

/** Read-only HTTP for update checks. Never throws: failures come back as results. */
export interface Http {
  getJson(url: string): Promise<HttpResult>
}

export type Clock = () => Date
