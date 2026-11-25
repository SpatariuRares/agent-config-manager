// Everything a provider should build on, in one import. Reuse these instead of writing files, running CLIs or
// parsing frontmatter yourself: they carry the safety rules (versions, backups first, no shell, no overwrite).
export type { CliResult, Clock, CommandRunner, FileSystem, Http, HttpResult } from '../core/ports.ts'

// JSON config files: never-throwing reads and the versions that let a write refuse a concurrent change.
export { isObject, parseObject, readJson, versionOf, type Json } from '../core/json.ts'
// The guarded change: every write and every CLI run that changes files goes through it (version check, backup
// first, the effect, the post-condition, one wording per refusal). Check which files the agent may write first.
export {
  guardedChange,
  restoreOf,
  unreadable,
  versionRefusal,
  type Change,
  type ChangeDeps,
  type ChangeRefusal,
  type ChangeResult,
  type Effect,
  type Step
} from '../core/guarded-change.ts'
// The per-agent backup store: a restorable trash for removed entries, and the list the view shows. Restore and
// snapshot are not the provider's: it declares a BackupPlan and the router runs them (./backup-actions.ts).
export { backupTarget, isTrashName, listAllBackups, listBackups, trashEntry, type BackupInfo, type BackupStore, type TrashResult } from '../core/backups.ts'
export type { BackupPlan, OwnedFile, RestoreRequest } from './backup-actions.ts'
// Path guards and known projects.
export { appBackupDir, existingProjects, occupied, sameFolder, tilde } from '../core/paths.ts'
// SKILL.md folders and agent .md files.
export { describe, readAgents, readSkills, sortByName, type Agent, type Skill } from '../core/markdown.ts'
// Moving, copying and listing skill folders and agent files.
export { moveEntry, readEntryDir, type EntryKind, type EntryPlaces, type EntryRef, type EntryResult } from '../core/entries.ts'
// Running an agent CLI: refuse user values that look like options before building argv; quote a command shown to the user.
export { optionLikeRefusal, shellQuote } from '../core/cli.ts'
// Secret-safe text: MCP args and URLs, hook commands and CLI output pass through these before an item or a message shows them.
export { argsHaveSecret, looksSecret, REDACTED, redactArgs, redactCommand, redactUrl, urlHasSecret } from '../core/redact.ts'
// Item keys the router can read the kind from.
export {
  itemKey,
  KINDS,
  type AgentProvider,
  type Exported,
  type Portable,
  type PortableMcp,
  type PortableSkill,
  type ProviderDeps,
  type ProviderView,
  type Refusal
} from './types.ts'
// 'copyToAgent': Portable shapes from an agent's config.
export { exportSkill, mcpJson, PORTABLE, portableMcp, skillEntry } from './portable.ts'
// The MCP server policy: whether a server may be written to a destination, and how a view describes it.
export {
  admitMcp,
  commandLine,
  describeMcp,
  privateFile,
  teamFile,
  type Admitted,
  type Carries,
  type Destination,
  type McpConfig,
  type Transport
} from './mcp-policy.ts'
