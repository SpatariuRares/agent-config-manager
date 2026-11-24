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
