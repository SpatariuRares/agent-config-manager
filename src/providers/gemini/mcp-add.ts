// Where `gemini mcp add` can write an MCP server. Shared by read.ts and actions.ts.
import { commandLine, type Carries } from '../toolkit.ts'

/**
 * What `gemini mcp add` writes back exactly (packages/cli/src/commands/mcp/add.ts in gemini-cli): the stdio, http
 * and sse transports, args, env (-e KEY=VALUE), headers (-H "Name: value"), and --timeout, --trust and
 * --description. Any other key of the server is refused rather than dropped.
 */
const ADD: Carries = {
  transports: ['stdio', 'http', 'sse'],
  fields: ['args', 'env', 'headers'],
  keeps: (key, value) =>
    (key === 'timeout' && typeof value === 'number') || (key === 'trust' && typeof value === 'boolean') || (key === 'description' && typeof value === 'string')
}

/** `gemini mcp add` into ~/.gemini/settings.json: the server is on its command line. */
export const GEMINI_ADD = commandLine('gemini mcp add', { team: false, carries: ADD })
/** `gemini mcp add --scope project`: a project's .gemini/settings.json, which the team shares. */
export const GEMINI_ADD_TEAM = commandLine('gemini mcp add', { team: true, carries: ADD })
