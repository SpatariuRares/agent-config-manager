// The panel <-> backend contract, independent of transport: the Orca worker answers it through
// plugin.request, a localhost server will answer it over HTTP. The panel only ever sees these shapes.

export type Kind = 'plugins' | 'skills' | 'agents' | 'mcp' | 'hooks'

/** Which file or folder an item lives in. user = global; project = shared with the team; local = only me. */
export type Scope = 'user' | 'project' | 'local'

export interface Item {
  /** Unique and stable across reads, e.g. `skills:/abs/path/SKILL.md`. Actions name items by key. */
  key: string
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
  /** For a project target: 'local' (only me, default) or 'project' (team). Ignored for global. */
  scope?: 'project' | 'local'
}

/** An action the panel can send; `undo` in a result is one of these, ready to send back. */
export type Action =
  | { type: 'move'; key: string; to: Target; copy: boolean }
  | { type: 'remove'; key: string }
  | { type: 'setEnabled'; key: string; enabled: boolean }
  | { type: 'clearOverride'; key: string }
  | { type: 'uninstall'; key: string }
  | { type: 'restore'; name: string }
  | { type: 'snapshot' }
  /** Updates one item from its UpdateSource. `acceptCommand` is the sha256 the user confirmed (plugins). */
  | { type: 'update'; key: string; acceptCommand?: string }
  /** Updates every item of a kind that the last check marked available. */
  | { type: 'updateAll'; kind: Kind; keys: string[] }
  /** Refreshes plugin marketplaces (`claude plugin marketplace update`). */
  | { type: 'refreshMarketplaces' }

export type ActionResult =
  | { ok: true; message: string; undo?: Action; warning?: string }
  | {
      ok: false
      reason: string
      message: string
      /** Set when the update needs the user to approve a command first: show `command`, then send `action`. */
      confirm?: { command: string; action: Action }
    }

export interface ActionAnswer {
  result: ActionResult
  /** The state read right after the action, so the panel never shows stale data. */
  view: ViewAnswer
}

/** What the panel sends: the action plus the versions of the view it acted on. */
export interface ActionRequest {
  action: Action
  versions: Record<string, string>
}
