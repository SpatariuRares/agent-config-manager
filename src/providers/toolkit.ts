// Everything a provider should build on, in one import. Reuse these instead of writing files, running CLIs or
// parsing frontmatter yourself: they carry the safety rules (versions, backups first, no shell, no overwrite).
export type { CliResult, Clock, CommandRunner, FileSystem, Http, HttpResult } from '../core/ports.ts'

// JSON config files: never-throwing reads and the versions that let a write refuse a concurrent change.
export { isObject, parseObject, readJson, versionOf, type Json } from '../core/json.ts'
// The versioned write: version check, backup, then the write. Check which files the agent may write first.
export { CHANGED, editJsonFile, replaceJson, unreadable, type JsonEdit, type WriteResult } from '../core/json-write.ts'
// The per-agent backup store: backups before writes, a restorable trash, and the list the view shows.
export {
  backUp,
  backupTarget,
  isTrashName,
  listAllBackups,
  listBackups,
  restoreFile,
  restoreTrash,
  trashEntry,
  type BackupInfo,
  type BackupStore,
  type TrashResult
} from '../core/backups.ts'
// Path guards and known projects.
export { appBackupDir, existingProjects, occupied, sameFolder, tilde } from '../core/paths.ts'
// SKILL.md folders and agent .md files.
export { describe, readAgents, readSkills, sortByName, type Agent, type Skill } from '../core/markdown.ts'
// Moving, copying and listing skill folders and agent files.
export { moveEntry, readEntryDir, type EntryKind, type EntryPlaces, type EntryRef, type EntryResult } from '../core/entries.ts'
// Running an agent CLI: refuse user values that look like options before building argv.
export { optionLikeRefusal } from '../core/cli.ts'
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
// 'copyToAgent': Portable shapes from an agent's fields, and the secret refusals every import applies.
export { exportSkill, isReference, literalValues, mcpJson, portableMcp, secretRefusal, skillEntry, type McpFields } from './portable.ts'
