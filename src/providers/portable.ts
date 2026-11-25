// What 'copyToAgent' moves between agents: building a Portable from an agent's own fields, and the secret rules
// every import applies. A provider maps its config onto these shapes and back; it never writes a field it cannot
// represent, and never puts a credential on a command line or into a file shared with a team.
import type { EntryRef } from '../core/entries.ts'
import { isObject, type Json } from '../core/json.ts'
import { occupied } from '../core/paths.ts'
import type { FileSystem } from '../core/ports.ts'
import { argsHaveSecret, textHasSecret, urlHasSecret } from '../core/redact.ts'
import type { Exported, PortableMcp, PortableSkill, Refusal } from './types.ts'

const refuse = (reason: string, message: string): Refusal => ({ ok: false, reason, message })

const TRANSPORTS = ['stdio', 'http', 'sse'] as const

/** The fields an agent's MCP config maps onto, as read (unchecked). */
export interface McpFields {
  transport: string
  command?: unknown
  args?: unknown
  url?: unknown
  env?: unknown
  headers?: unknown
}

const stringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((entry) => typeof entry === 'string')

/**
 * A PortableMcp from an agent's own fields, or a refusal. `extra` names the settings the server has that the
 * Portable shape cannot carry: copying without them would silently change the server, so the copy is refused.
 */
export function portableMcp(name: string, fields: McpFields, extra: string[]): Exported {
  const { transport } = fields
  if (!(TRANSPORTS as readonly string[]).includes(transport)) {
    return refuse('not-portable', `"${name}" uses the ${transport} transport, which other agents do not have.`)
  }
  const kind = transport as PortableMcp['transport']
  const present = (value: unknown) => value !== undefined && value !== null && !(isObject(value) && Object.keys(value).length === 0)
  const misplaced =
    kind === 'stdio'
      ? (['url', 'headers'] as const).filter((field) => present(fields[field]))
      : (['command', 'args', 'env'] as const).filter((field) => present(fields[field]) && !(field === 'args' && Array.isArray(fields.args) && fields.args.length === 0))
  const unknown = [...extra, ...misplaced]
  if (unknown.length > 0) {
    return refuse('not-portable', `"${name}" has settings another agent cannot take (${unknown.join(', ')}), so it was not copied. Copy it by hand.`)
  }
  if (kind === 'stdio' && (typeof fields.command !== 'string' || fields.command === '')) return refuse('not-portable', `"${name}" has no command.`)
  if (kind !== 'stdio' && (typeof fields.url !== 'string' || fields.url === '')) return refuse('not-portable', `"${name}" has no url.`)
  if (fields.args !== undefined && !(Array.isArray(fields.args) && fields.args.every((arg) => typeof arg === 'string'))) {
    return refuse('not-portable', `"${name}" has args that are not all text.`)
  }
  for (const field of ['env', 'headers'] as const) {
    if (fields[field] !== undefined && !stringMap(fields[field])) return refuse('not-portable', `"${name}" has ${field} values that are not all text.`)
  }
  const args = fields.args as string[] | undefined
  const env = fields.env as Record<string, string> | undefined
  const headers = fields.headers as Record<string, string> | undefined
  const item: PortableMcp = { kind: 'mcp', name, transport: kind }
  if (kind === 'stdio') {
    item.command = fields.command as string
    if (args && args.length > 0) item.args = [...args]
    if (env && Object.keys(env).length > 0) item.env = { ...env }
  } else {
    item.url = fields.url as string
    if (headers && Object.keys(headers).length > 0) item.headers = { ...headers }
  }
  return { ok: true, item }
}

/** The JSON config Claude Code and Copilot CLI write for a server; `stdio` is how the agent names that transport. */
export function mcpJson(item: PortableMcp, stdio: 'stdio' | 'local'): Json {
  if (item.transport === 'stdio') {
    return { type: stdio, command: item.command, ...(item.args ? { args: [...item.args] } : {}), ...(item.env ? { env: { ...item.env } } : {}) }
  }
  return { type: item.transport, url: item.url, ...(item.headers ? { headers: { ...item.headers } } : {}) }
}

const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/

/**
 * A value that names an environment variable instead of holding a secret: it has a `${VAR}` reference, and no word
 * around it is secret-looking (`Bearer ${TOKEN}` is a reference; `${A}sk-live-...` and `${HOME}/ghp_...` are not).
 */
export function isReference(value: string): boolean {
  return REFERENCE.test(value) && !textHasSecret(value)
}

const ENTRIES = [
  ['env', 'env'],
  ['headers', 'header']
] as const

/** Env and header entries (`env API_KEY`, `header Authorization`) whose values are literal, not `${VAR}` references. */
export function literalValues(item: PortableMcp): string[] {
  return ENTRIES.flatMap(([field, word]) => Object.entries(item[field] ?? {}).filter(([, value]) => !isReference(value)).map(([key]) => `${word} ${key}`))
}

/** Env and header entries whose literal value looks like a credential, by its name or its value. */
export function secretValues(item: PortableMcp): string[] {
  return ENTRIES.flatMap(([field, word]) =>
    Object.entries(item[field] ?? {})
      .filter(([key, value]) => !isReference(value) && argsHaveSecret([`${key.replace(/[^\w.-]/g, '_') || 'value'}=${value}`]))
      .map(([key]) => `${word} ${key}`)
  )
}

/** Whether the command line or the url holds a credential (the toolkit's redaction rules). */
export function commandLineHasSecret(item: PortableMcp): boolean {
  return argsHaveSecret([item.command ?? '', ...(item.args ?? [])].filter((word) => word !== '')) || (item.url !== undefined && urlHasSecret(item.url))
}

/**
 * The secret refusals of an import, or null when the server may be written. `commandLine`: the target's CLI takes
 * the server on its argv (`cli` names it), which other programs can read. `teamFile`: the server lands in a project
 * file shared with the team. Messages name fields, never values.
 */
export function secretRefusal(item: PortableMcp, where: { commandLine: string | null; teamFile: boolean }): Refusal | null {
  const { commandLine, teamFile } = where
  if (teamFile) {
    const literal = literalValues(item)
    if (literal.length > 0) {
      return refuse(
        'secret',
        `"${item.name}" has literal env or header values (${literal.join(', ')}). Replace them with \${VAR} references first: a project file is shared with the team.`
      )
    }
  }
  if ((teamFile || commandLine !== null) && commandLineHasSecret(item)) {
    const why = commandLine !== null ? `${commandLine} would put it on a command line other programs can read` : 'a project file is shared with the team'
    return refuse('secret', `"${item.name}" has a secret-looking value in its args or url. Move it into an env value with a \${VAR} reference first: ${why}.`)
  }
  if (commandLine !== null) {
    const secret = secretValues(item)
    if (secret.length > 0) {
      return refuse(
        'secret',
        `"${item.name}" has secret-looking values (${secret.join(', ')}). Write them as \${VAR} references first: ${commandLine} takes them on its command line, where other programs can read them.`
      )
    }
  }
  return null
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
