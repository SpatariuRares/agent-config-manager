// Where Codex can write an MCP server, and the argv rules for it. Shared by read.ts and actions.ts.
import { commandLine, optionLikeRefusal } from '../toolkit.ts'

/**
 * `codex mcp add NAME -- COMMAND ARGS...`, the only argv this app builds for Codex: a stdio command line and
 * nothing else (AddArgs in codex-rs/cli/src/mcp_cmd.rs; `--url` may start a browser login, and env is not passed).
 */
export const CODEX_ADD = commandLine('`codex mcp add`', {
  team: false,
  carries: { transports: ['stdio'], fields: ['args'] },
  hint: 'Only stdio servers without env are copied to Codex: `codex mcp add --url` may start a browser login.'
})

/** Argv encoding: neither the name nor the command may be read as an option. Null when both are fine. */
export function addableServer(name: string, command: string): string | null {
  for (const [value, what] of [
    [name, 'An MCP server name'],
    [command, 'An MCP server command']
  ] as const) {
    const refused = optionLikeRefusal(value, what)
    if (refused !== null) return refused.output
  }
  return null
}
