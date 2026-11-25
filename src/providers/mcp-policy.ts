// MCP server policy: the one module that decides whether an MCP server may be written to a destination, and how a
// view describes one. Pure and in-process. Every provider maps its own config onto McpConfig (an adapter in its
// own folder) and names its write paths as Destinations next to the writer that builds the argv or writes the file;
// the rules live here only. Its interface is admitMcp and describeMcp; a writer builds argv only from what
// admitMcp returns, and adds only argv-encoding limits of its own CLI (option-like values, name rules).
import { isObject } from '../core/json.ts'
import { argsHaveSecret, redactArgs, redactUrl, textHasSecret, urlHasSecret } from '../core/redact.ts'
import type { PortableMcp, Refusal } from './types.ts'

export type Transport = 'stdio' | 'http' | 'sse'

/**
 * An MCP server as a provider reads it, unchecked: its transport as the policy names it, the fields any agent
 * has, and `rest`, every other key of the agent's own config (absent when there is none).
 */
export interface McpConfig {
  name: string
  transport: string
  command?: unknown
  args?: unknown
  url?: unknown
  env?: unknown
  headers?: unknown
  rest?: Record<string, unknown>
}

/**
 * What a destination can carry: its transports, the optional fields it takes (a stdio command and an http/sse url
 * come with their transport), and `keeps`, which says yes to the `rest` keys it writes back exactly. Without
 * `keeps`, every `rest` key is refused.
 */
export interface Carries {
  transports: readonly Transport[]
  fields: readonly ('args' | 'env' | 'headers')[]
  keeps?: (key: string, value: unknown) => boolean
}

/**
 * Where a server is written. `argv`: the CLI that takes it on its command line, which other programs can read
 * (null when nothing is). `team`: the file is shared with the team. `label`: how messages name it. `hint`: one
 * sentence a carry or secret refusal ends with (another place to choose, or why a field is not carried).
 */
export interface Destination {
  readonly argv: string | null
  readonly team: boolean
  readonly carries: Carries
  readonly hint?: string
  readonly label: string
}

/** A CLI that takes the server on its argv; `team` when what it writes is a file shared with the team. */
export function commandLine(cli: string, opts: { team: boolean; carries: Carries; label?: string; hint?: string }): Destination {
  return { argv: cli, team: opts.team, carries: opts.carries, label: opts.label ?? cli, ...(opts.hint ? { hint: opts.hint } : {}) }
}

/** A file shared with the team (a project file in a repository), written without a command line. */
export function teamFile(label: string, carries: Carries, hint?: string): Destination {
  return { argv: null, team: true, carries, label, ...(hint ? { hint } : {}) }
}

/** A file only its user reads, written without a command line: literal values may stay. */
export function privateFile(label: string, carries: Carries): Destination {
  return { argv: null, team: false, carries, label }
}

export type Admitted = { ok: true; server: PortableMcp & { rest: Record<string, unknown> } } | Refusal

const TRANSPORTS: readonly string[] = ['stdio', 'http', 'sse']
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/

/** Invariant 1: a reference holds a `${VAR}` and nothing textHasSecret finds (`$x`, `sk-live-...$x`, `${A}sk-live-...` are literals). */
const isReference = (value: string) => REFERENCE.test(value) && !textHasSecret(value)

/** Set, and not an empty list or object: an empty field is no field. */
const present = (value: unknown) =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) && !(isObject(value) && Object.keys(value).length === 0)

const MAPS = ['env', 'headers'] as const

/** The malformed fields: wrong types, or the command or url its transport needs missing. */
function shapePaths(config: McpConfig): string[] {
  const paths: string[] = []
  for (const field of ['command', 'url'] as const) {
    if (config[field] !== undefined && config[field] !== null && typeof config[field] !== 'string') paths.push(field)
  }
  if (config.transport === 'stdio' && !paths.includes('command') && (typeof config.command !== 'string' || config.command === '')) paths.push('command')
  if ((config.transport === 'http' || config.transport === 'sse') && !paths.includes('url') && (typeof config.url !== 'string' || config.url === '')) paths.push('url')
  if (config.args !== undefined && config.args !== null) {
    if (!Array.isArray(config.args)) paths.push('args')
    else config.args.forEach((arg, i) => typeof arg !== 'string' && paths.push(`args[${i}]`))
  }
  for (const field of MAPS) {
    const map = config[field]
    if (map === undefined || map === null) continue
    if (!isObject(map)) paths.push(field)
    else for (const [key, value] of Object.entries(map)) if (typeof value !== 'string') paths.push(`${field}.${key}`)
  }
  return paths
}

/** What the destination cannot carry: the transport, a field (its own or the other transport's), a rest key. */
function carryPaths(config: McpConfig, carries: Carries): string[] {
  const paths: string[] = []
  const { transport } = config
  if (!TRANSPORTS.includes(transport) || !(carries.transports as readonly string[]).includes(transport)) paths.push('transport')
  if (TRANSPORTS.includes(transport)) {
    const other = transport === 'stdio' ? (['url', 'headers'] as const) : (['command', 'args', 'env'] as const)
    for (const field of other) if (present(config[field])) paths.push(field)
  }
  for (const field of ['args', 'env', 'headers'] as const) {
    if (present(config[field]) && !carries.fields.includes(field) && !paths.includes(field)) paths.push(field)
  }
  for (const [key, value] of Object.entries(config.rest ?? {})) {
    if (value !== undefined && !(carries.keeps?.(key, value) ?? false)) paths.push(`rest.${key}`)
  }
  return paths
}

/**
 * The secret paths, as two lists: env and header values a team file refuses as literals (invariant 2), and values
 * that look secret where a command line or a team file would expose them (invariants 3 and 4).
 */
function secretPaths(config: McpConfig, to: Destination): { literal: string[]; secret: string[] } {
  const literal: string[] = []
  const secret: string[] = []
  if (to.argv === null && !to.team) return { literal, secret }
  // Invariant 3: command, args, url and kept rest values. The offending word is the one redactArgs changes,
  // when it (or the flag before it) is what holds the credential; a harmless URL query alone is not one.
  const words = config.transport === 'stdio' ? [config.command as string, ...((config.args as string[] | undefined) ?? [])] : []
  const redacted = redactArgs(words)
  words.forEach((word, i) => {
    if (redacted[i] !== word && argsHaveSecret(i === 0 ? [word] : [words[i - 1], word])) secret.push(i === 0 ? 'command' : `args[${i - 1}]`)
  })
  if (typeof config.url === 'string' && urlHasSecret(config.url)) secret.push('url')
  for (const [key, value] of Object.entries(config.rest ?? {})) {
    if (value !== undefined && textHasSecret(JSON.stringify({ [key]: value }))) secret.push(`rest.${key}`)
  }
  // Invariants 2 and 4: env and header values. A value counts with its name (`API_KEY=...` is secret by name).
  for (const field of MAPS) {
    for (const [key, value] of Object.entries((config[field] as Record<string, string> | undefined) ?? {})) {
      if (isReference(value)) continue
      if (to.team) literal.push(`${field}.${key}`)
      else if (argsHaveSecret([`${key.replace(/[^\w.-]/g, '_') || 'value'}=${value}`])) secret.push(`${field}.${key}`)
    }
  }
  return { literal, secret }
}

const refuse = (reason: 'not-portable' | 'secret', message: string): Refusal => ({ ok: false, reason, message })
const list = (paths: string[]) => `(${paths.join(', ')})`
const withHint = (message: string, to: Destination) => (to.hint ? `${message} ${to.hint}` : message)

/**
 * Whether `config` may be written to `to`, and the server to write when it may: only what the destination carries,
 * empty fields dropped, kept `rest` values kept. The invariants:
 * 1. Reference: a value is a reference only if it contains `${VAR}` and textHasSecret finds nothing in it.
 * 2. Team file: when `to.team`, every env and header value must be a reference.
 * 3. Command line or team file: when `to.argv` is set or `to.team`, nothing in command, args, url or a kept rest
 *    value may look secret.
 * 4. Command line: when `to.argv` is set, no env or header value may look secret.
 * 5. Private file: a private file with no argv may hold literals.
 * 6. Check order: shape (malformed fields), then carry (a transport or field the destination cannot carry; a
 *    `rest` key unless `keeps` says yes), then secret. The refusal names the first failing class with all its paths:
 *    'not-portable' for shape and carry, 'secret' for secret.
 * 7. Messages name field paths (`env.TOKEN`, `headers.Authorization`, `args[2]`, `url`, `rest.cwd`), never values.
 */
export function admitMcp(config: McpConfig, to: Destination): Admitted {
  const { name } = config
  const shape = shapePaths(config)
  if (shape.length > 0) return refuse('not-portable', `"${name}" has settings that are not in the form an MCP server takes ${list(shape)}. Fix them by hand first.`)
  const carry = carryPaths(config, to.carries)
  if (carry.length > 0) return refuse('not-portable', withHint(`"${name}" has settings ${to.label} cannot take ${list(carry)}. Copy it by hand.`, to))
  const { literal, secret } = secretPaths(config, to)
  if (literal.length > 0 || secret.length > 0) {
    const what = [
      ...(literal.length > 0 ? [`literal env or header values ${list(literal)}`] : []),
      ...(secret.length > 0 ? [`secret-looking values ${list(secret)}`] : [])
    ].join(' and ')
    const why = [
      ...(to.team ? ['a project file is shared with the team'] : []),
      ...(to.argv !== null ? [`${to.argv} puts them on a command line other programs can read`] : [])
    ].join(', and ')
    return refuse('secret', withHint(`"${name}" has ${what}. Write them as \${VAR} references first: ${why}.`, to))
  }

  const server: PortableMcp & { rest: Record<string, unknown> } = { kind: 'mcp', name, transport: config.transport as Transport, rest: {} }
  if (config.transport === 'stdio') {
    server.command = config.command as string
    if (present(config.args)) server.args = [...(config.args as string[])]
    if (present(config.env)) server.env = { ...(config.env as Record<string, string>) }
  } else {
    server.url = config.url as string
    if (present(config.headers)) server.headers = { ...(config.headers as Record<string, string>) }
  }
  for (const [key, value] of Object.entries(config.rest ?? {})) if (value !== undefined) server.rest[key] = value
  return { ok: true, server }
}

/**
 * Invariant 8: how a view shows a server, without env or headers (never read here). `target` is the url through
 * redactUrl, else the command line through redactArgs.
 */
export function describeMcp(config: McpConfig): { transport: string; target: string } {
  const { transport, url } = config
  if (typeof url === 'string' && url !== '') return { transport, target: redactUrl(url) }
  const args = Array.isArray(config.args) ? config.args : []
  const words = [config.command, ...args].filter((word): word is string => typeof word === 'string' && word !== '')
  return { transport, target: redactArgs(words).join(' ') }
}
