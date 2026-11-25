// The one interface every coding agent implements. Adding an agent = one module that exports an AgentProvider,
// its tests (including providerContract from ./testing.ts), and one line in ./registry.ts. The router
// (./router.ts) does everything shared: picking the agent, detection, refusing what a provider did not declare,
// error handling, and the fresh view after every action.
import type { Clock, CommandRunner, FileSystem, Http } from '../core/ports.ts'
import type { ActionRequest, ActionResult, ActionType, AgentId, AgentInfo, Kind, Target, UpdatesAnswer, View } from '../adapters/view.ts'
import type { Destination } from './mcp-policy.ts'

/** What every provider gets on every call. Nothing else touches the machine. */
export interface ProviderDeps {
  fs: FileSystem
  /** Runs agent CLIs by argv (never a shell) and finds them on PATH. */
  exec: CommandRunner
  /** The user's home folder; a provider finds its config under it (e.g. `${home}/.codex`). */
  home: string
  clock?: Clock
  /** The network, for update checks only; absent when there is none. */
  http?: Http
}

/** A provider's view: the panel's View without the cross-agent fields (`agents`, `agent`) the router adds. */
export type ProviderView = Omit<View, 'agents' | 'agent'>

export interface AgentProvider {
  /** Stable id, e.g. 'codex'. Equal to `info().id`; every Item it returns carries it as `agent`. */
  readonly id: AgentId

  /**
   * Every Destination (./mcp-policy.ts) this provider writes MCP servers through: one per write path (a CLI that
   * takes the server on its argv, a team file, a private file). Required when it imports MCP servers or moves
   * them; providerContract proves each one that is a command line or a team file refuses a literal secret.
   */
  readonly mcpDestinations?: readonly Destination[]

  /**
   * Who the agent is and what this app can do with it. Must be cheap: only `fs` reads and `exec.find` (PATH),
   * never `exec.run`. The router reads `supports` from here and refuses anything not listed, with reason
   * 'unsupported', before `runAction` is ever called. List only what works; the panel hides the rest.
   */
  info(deps: ProviderDeps): Promise<AgentInfo>

  /**
   * Everything the agent has, globally and per project. May throw; the router turns that into `{ ok: false }`.
   * Rules (checked by providerContract): every Item has `agent: this.id`, a kind listed in `info().kinds`,
   * and a unique `key` that starts with `<kind>:` (the router reads the kind from it).
   * `versions` holds versionOf() of every file read, so a later write can refuse a concurrent change.
   */
  buildView(deps: ProviderDeps): Promise<ProviderView>

  /**
   * Runs one action the router already checked against `info().supports`. Writes go through the core toolkit
   * (./toolkit.ts): version check against `request.versions`, backup first, then the write. May throw; the router
   * reports it as reason 'error'. The router builds the fresh view after it, so this returns only the result.
   */
  runAction(deps: ProviderDeps, request: ActionRequest): Promise<ActionResult>

  /** The on-demand update check (network). Omit it when nothing of this agent can be checked. */
  checkUpdates?(deps: ProviderDeps & { http: Http }): Promise<UpdatesAnswer>

  /**
   * 'copyToAgent', source side: the item as an agent-neutral Portable, read from the agent's own files. Required
   * when `info().exports` lists a class. Refuses (never drops) what the Portable shape cannot carry. Reads only.
   */
  exportItem?(deps: ProviderDeps, key: string): Promise<Exported>

  /**
   * 'copyToAgent', target side: adds the item through this agent's own write path and rules (version check
   * against `versions`, backup first, its CLI when it has one, no writes to shared places, the secret refusals).
   * Required when `info().imports` lists a class. The router has already checked the scope against
   * `projectScopes`; `versions` is this agent's view, read just before. The undo, if any, is for this agent.
   */
  importItem?(deps: ProviderDeps, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult>
}

/** The classes 'copyToAgent' can carry. */
export const PORTABLE_KINDS: readonly Kind[] = ['skills', 'mcp']

/**
 * An MCP server as any agent can describe it. Values are as written: a `${VAR}` reference stays a reference.
 * stdio servers have `command` (and maybe `args`, `env`); http and sse servers have `url` (and maybe `headers`).
 * It lives only in memory between exportItem and importItem: never in a view, a message or a file of this app.
 */
export interface PortableMcp {
  kind: 'mcp'
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

/** A skill: its folder (the one holding SKILL.md), copied as is with the toolkit's copy; a symlink stays a link. */
export interface PortableSkill {
  kind: 'skills'
  name: string
  dir: string
  /** The symlink text when `dir` is a symlink. */
  link: string | null
}

export type Portable = PortableMcp | PortableSkill

export type Refusal = ActionResult & { ok: false }

export type Exported = { ok: true; item: Portable } | Refusal

export const KINDS: readonly Kind[] = ['plugins', 'skills', 'agents', 'mcp', 'hooks']

export const ACTION_TYPES: readonly ActionType[] = [
  'move',
  'remove',
  'setEnabled',
  'clearOverride',
  'uninstall',
  'restore',
  'snapshot',
  'update',
  'updateAll',
  'refreshMarketplaces'
]

/**
 * Actions that belong to no single class: they work on the agent's backups. A provider supports one of them
 * when it lists it under any kind (list them under every kind whose writes it backs up).
 */
export const BACKUP_ACTIONS: readonly ActionType[] = ['restore', 'snapshot']

/** Builds an item key the router can read the kind from: `<kind>:<JSON of parts>`. */
export const itemKey = (kind: Kind, ...parts: (string | number | null)[]) => `${kind}:${JSON.stringify(parts)}`

export const isKind = (value: unknown): value is Kind => typeof value === 'string' && (KINDS as readonly string[]).includes(value)

/** The kind an item key names, or null when it names none. */
export function kindOfKey(key: unknown): Kind | null {
  if (typeof key !== 'string' || !key.includes(':')) return null
  const kind = key.slice(0, key.indexOf(':'))
  return isKind(kind) ? kind : null
}
