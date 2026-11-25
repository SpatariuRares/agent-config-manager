// What 'copyToAgent' moves between agents: building a Portable from an agent's own config. A provider maps its
// config onto McpConfig and back; the MCP server policy (./mcp-policy.ts) decides what may be carried and where
// a value may go, on export (PORTABLE) and on import (the target's own Destination).
import type { EntryRef } from '../core/entries.ts'
import type { Json } from '../core/json.ts'
import { occupied } from '../core/paths.ts'
import type { FileSystem } from '../core/ports.ts'
import { admitMcp, privateFile, type McpConfig } from './mcp-policy.ts'
import type { Exported, PortableMcp, PortableSkill, Refusal } from './types.ts'

const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message })

/**
 * Where an export goes: another agent, whichever it is. Every transport and field any agent has, no key of the
 * agent's own (`rest`): copying without one would silently change the server, so it is refused. No command line
 * and no team file yet: the importing agent admits the server again against its own Destination.
 */
export const PORTABLE = privateFile('another agent', { transports: ['stdio', 'http', 'sse'], fields: ['args', 'env', 'headers'] })

/** A PortableMcp from an agent's config (mapped onto McpConfig by the provider), or a refusal. */
export function portableMcp(config: McpConfig): Exported {
  const admitted = admitMcp(config, PORTABLE)
  if (!admitted.ok) return admitted
  const { rest: _none, ...item } = admitted.server
  return { ok: true, item }
}

/** The JSON config Claude Code and Copilot CLI write for a server; `stdio` is how the agent names that transport. */
export function mcpJson(item: PortableMcp, stdio: 'stdio' | 'local'): Json {
  if (item.transport === 'stdio') {
    return { type: stdio, command: item.command, ...(item.args ? { args: [...item.args] } : {}), ...(item.env ? { env: { ...item.env } } : {}) }
  }
  return { type: item.transport, url: item.url, ...(item.headers ? { headers: { ...item.headers } } : {}) }
}

/** A skill folder as a PortableSkill, or a refusal when it is gone or is a relative link (copying would break it). */
export async function exportSkill(fs: FileSystem, name: string, dir: string): Promise<Exported> {
  if (!(await occupied(fs, dir))) return refuse('missing', `${dir} is no longer there.`)
  const link = await fs.linkTarget(dir)
  if (link !== null && !link.startsWith('/')) {
    return refuse('not-portable', `"${name}" is a relative link (${link}); a copy elsewhere would point somewhere else.`)
  }
  return { ok: true, item: { kind: 'skills', name, dir, link } }
}

/** The skill as the toolkit's moveEntry takes it, for a copy (never a move) into the target's own folder. */
export const skillEntry = (item: PortableSkill): EntryRef => ({ kind: 'skills', name: item.name, entry: item.dir, link: item.link })
