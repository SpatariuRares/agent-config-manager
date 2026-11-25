// Helpers for running agent CLIs through the CommandRunner port.
import type { CliResult } from './ports.ts'

/**
 * A value a CLI would read as an option (`-h`, `--scope`) is refused before running anything. Call it for every
 * argument that comes from the user's setup (a server name, a plugin id), never for the flags you write yourself.
 */
export function optionLikeRefusal(value: string, what: string, fix = ''): CliResult | null {
  if (!value.startsWith('-')) return null
  return { ok: false, output: `${what} cannot start with "-" (${value})${fix}.` }
}

/** A word a POSIX shell reads as itself: no spaces, quotes, `$`, globs, `~` or operators. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * A command line for the user to paste into a terminal: each word as is when a shell reads it as itself, else in
 * single quotes (a `'` inside becomes `'\''`). Only for showing a command; running one always passes argv, never a shell.
 */
export function shellQuote(args: readonly string[]): string {
  return args.map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(' ')
}
