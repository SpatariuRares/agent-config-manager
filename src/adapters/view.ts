// The panel <-> backend contract, independent of transport: the Orca worker answers it through
// plugin.request, a localhost server will answer it over HTTP. The panel only ever sees these shapes.

export type Kind = 'plugins' | 'skills' | 'agents' | 'mcp' | 'hooks'

/** A coding agent whose setup this app manages, e.g. 'claude', 'codex', 'gemini', 'copilot'. */
export type AgentId = string

export type ActionType = Action['type']

/** One agent, as the panel's agent switcher shows it. Each agent is a provider in src/providers. */
export interface AgentInfo {
  id: AgentId
  /** Display name, e.g. "Claude Code". */
  name: string
  /** True when the agent is installed on this machine (its binary or config folder exists). */
  detected: boolean
  /** The classes this agent has; the panel shows only these tabs. */
  kinds: Kind[]
  /** Per class, the actions this agent can do; anything missing is read-only in the panel. */
  supports: Partial<Record<Kind, ActionType[]>>
  /**
   * Per class, the scopes a move or copy into a project may target, in preference order: the first is the
   * default (a drag drop uses it). A missing class or an empty list means items of that class cannot go into
   * a project. Only classes whose `supports` include 'move', or which the agent `imports`, may be listed.
   */
  projectScopes: Partial<Record<Kind, ProjectScope[]>>
  /**
   * The classes whose items this agent can hand to another agent with 'copyToAgent' (it is the source).
   * Missing or empty: none.
   */
  exports?: Kind[]
  /**
   * The classes this agent can take from another agent with 'copyToAgent' (it is the target). A copy into a
   * project uses the class's `projectScopes`, like a move. Missing or empty: none.
   */
  imports?: Kind[]
  /** Where the agent keeps its setup, shown to the user (e.g. "~/.codex/config.toml"). */
  configHome: string
  /** Why something is read-only or missing, shown once per agent. */
  note?: string
}

/** Which file or folder an item lives in. user = global; project = shared with the team; local = only me. */
export type Scope = 'user' | 'project' | 'local'

/** The scopes inside a project: 'project' = team (shared files), 'local' = only me. */
export type ProjectScope = 'project' | 'local'

export interface Item {
  /** Unique and stable across reads, e.g. `skills:/abs/path/SKILL.md`. Actions name items by key. */
  key: string
  /** The agent this item belongs to. */
  agent: AgentId
  kind: Kind
  name: string
  description: string
  /** null = global (user scope); otherwise the project folder. */
  project: string | null
  scope: Scope
  /** The file or folder that holds the item, shown to the user. */
  source: string
  /** False with a reason when the item cannot be dragged (e.g. a symlinked skill whose move is refused). */
  movable: boolean
  notMovableReason?: string
  removable: boolean
  /**
   * The item's on/off switch, for a class whose agent supports 'setEnabled' there (e.g. Gemini CLI MCP servers).
   * Plugin items keep theirs in `plugin.enabled`; the panel reads `plugin?.enabled ?? enabled`.
   */
  enabled?: boolean
  plugin?: {
    id: string
    /** The value in this item's own settings file (global switch, or the project override). */
    enabled: boolean
    version: string | null
    contributes: Record<'skills' | 'agents' | 'commands' | 'hooks' | 'mcpServers', string[]>
    sharesNameWith: string[]
    /** Installed somewhere, so it can be uninstalled (global item only). */
    installed: boolean
    installs: { scope: string; project: string | null }[]
  }
  mcp?: { transport: string; target: string }
  hook?: { event: string; matcher: string; command: string }
  /** Where updates come from; known without the network. Absent when nothing can update it. */
  updateSource?: UpdateSource
}

/**
 * plugin: its marketplace (`claude plugin update`). skills-cli: a skill installed by the `skills` CLI
 * (`npx skills update`). npm: an MCP server launched from a version-pinned npm package.
 * manual: updated outside this app (e.g. Homebrew); `note` says how. Local files have no source.
 */
export interface UpdateSource {
  type: 'plugin' | 'skills-cli' | 'npm' | 'manual'
  /** Human label, e.g. "claude-plugins-official", "mattpocock/skills", "@upstash/context7-mcp". */
  label: string
  /** The installed version, commit or content hash, when known. */
  current: string | null
  note?: string
}

/** Result of an on-demand check (network); keyed by Item.key. */
export interface UpdateStatus {
  status: 'available' | 'current' | 'unknown'
  latest: string | null
  /** Why the status is unknown, or what the update changes. */
  note?: string
}

export interface UpdatesAnswer {
  checkedAt: number
  statuses: Record<string, UpdateStatus>
  /** Sources that could not be checked (offline, rate limit), with the reason. */
  errors: string[]
}

export interface BackupEntry {
  name: string
  /** The file (or folder, for removed skills/agents) the backup restores. */
  target: string
  /** Milliseconds since the epoch. */
  at: number
}

export interface View {
  /** Every agent this app knows, detected or not; the switcher lists them. */
  agents: AgentInfo[]
  /** The agent this view shows. */
  agent: AgentId
  items: Item[]
  /** Projects Claude Code knows that still exist, sorted; every one is a drop target. */
  projects: string[]
  /** Opaque versions of every file read; actions send them back so stale writes are refused. */
  versions: Record<string, string>
  backups: BackupEntry[]
  problems: string[]
}

export type ViewAnswer = { ok: true; view: View } | { ok: false; error: string }

export interface Target {
  project: string | null
  /**
   * For a project target: one of the agent's `projectScopes` for the item's class; without it, the provider's
   * default (the first declared). Ignored for global.
   */
  scope?: ProjectScope
}

/** An action the panel can send; `undo` in a result is one of these, ready to send back. */
export type Action =
  | { type: 'move'; key: string; to: Target; copy: boolean }
  | { type: 'remove'; key: string }
  | { type: 'setEnabled'; key: string; enabled: boolean }
  | { type: 'clearOverride'; key: string }
  | { type: 'uninstall'; key: string }
  /**
   * Puts a backup back. `acceptCommand` is the sha256 of the command the user approved, when restoring it runs
   * one (Gemini CLI: reinstalling an uninstalled extension); without it, such a restore only asks for approval.
   */
  | { type: 'restore'; name: string; acceptCommand?: string }
  | { type: 'snapshot' }
  /** Updates one item from its UpdateSource. `acceptCommand` is the sha256 the user confirmed (plugins). */
  | { type: 'update'; key: string; acceptCommand?: string }
  /** Updates every item of a kind that the last check marked available. */
  | { type: 'updateAll'; kind: Kind; keys: string[] }
  /** Refreshes plugin marketplaces (`claude plugin marketplace update`). */
  | { type: 'refreshMarketplaces' }
  /**
   * Copies one item of the request's agent (the source) to another agent, through that agent's own write path.
   * The source must list the item's class in `exports`, `toAgent` in `imports`, and both must be detected.
   * The answer's view is the source agent's; an undo, if any, applies to `toAgent` (see `undoAgent`).
   */
  | { type: 'copyToAgent'; key: string; toAgent: AgentId; to: Target }

export type ActionResult =
  | {
      ok: true
      message: string
      undo?: Action
      /** The agent `undo` must be sent to, when it is not the request's agent (a 'copyToAgent' undo). */
      undoAgent?: AgentId
      /**
       * With `undoAgent`: that agent's versions, read right after the copy. Send exactly these as the undo's
       * `versions`, so an undo is refused (`changed`) when a file of that agent changed after the copy.
       */
      undoVersions?: Record<string, string>
      warning?: string
    }
  | {
      ok: false
      reason: string
      message: string
      /** Set when the action needs the user to approve a command first: show `command`, then send `action`. */
      confirm?: { command: string; action: Action }
    }

export interface ActionAnswer {
  result: ActionResult
  /** The state read right after the action, so the panel never shows stale data. */
  view: ViewAnswer
}

/** What the panel sends: the action plus the versions of the view it acted on. */
export interface ActionRequest {
  /** The agent the action applies to; the view's `agent`. */
  agent: AgentId
  action: Action
  versions: Record<string, string>
}

/** Input of 'view.get' and 'updates.check'; without `agent`, the first detected agent. */
export interface AgentRequest {
  agent?: AgentId
}
