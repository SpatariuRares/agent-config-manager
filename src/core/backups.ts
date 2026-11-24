// The backup store every provider writes through: a file backup before every write, a restorable trash for
// removed folders and files, and the list of everything that can be put back. Each agent has its own store.
import { versionOf } from './json.ts'
import { occupied } from './paths.ts'
import type { Clock, FileSystem } from './ports.ts'

export interface BackupStore {
  /** The folder that holds the backups and the trash. */
  dir: string
  /** Short names for well-known files, used in backup names: e.g. `settings` for ~/.claude/settings.json. */
  aliases?: Readonly<Record<string, string>>
}

export interface BackupInfo {
  name: string
  /** The file, skill folder or agent file the backup puts back. */
  target: string
  /** Milliseconds since the epoch, from the name. */
  at: number
  trash: boolean
}

export type TrashResult =
  | { ok: true; name: string; target: string }
  | { ok: false; reason: 'missing' | 'unknown-backup' | 'exists' | 'unknown-project'; message: string }

export type Refusal = { ok: false; reason: string; message: string }
export type RestoreResult = { ok: true; backup: string } | Refusal

const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?`
/** `<alias or encoded path>.<stamp>[-n].json`: a file as it was before a write. */
const BACKUP_NAME = new RegExp(String.raw`^([a-z][a-z0-9-]*|%2F[A-Za-z0-9%._~!*'()-]+)\.(${STAMP})\.json$`)
/** `<encoded original path>.<stamp>[-n].trash`: a removed skill folder or agent file, kept as it was. */
const TRASH_NAME = new RegExp(String.raw`^(%2F[A-Za-z0-9%._~!*'()-]+)\.(${STAMP})\.trash$`)

/** The stamp in backup names: the ISO time with `-` for `:` and `.`. */
export const stampOf = (clock: Clock) => clock().toISOString().replace(/[:.]/g, '-')

export const isTrashName = (name: string) => TRASH_NAME.test(name)

/** The file a backup belongs to, or null when the name is not a backup of this store. */
export function backupTarget(store: BackupStore, name: string): string | null {
  const slug = BACKUP_NAME.exec(name)?.[1]
  if (slug === undefined) return null
  if (slug.startsWith('%2F')) return decodeURIComponent(slug)
  return store.aliases && Object.hasOwn(store.aliases, slug) ? store.aliases[slug] : null
}

/** Copies `text` (the file's current content) into the store; returns the backup's path. */
export async function backUp(fs: FileSystem, store: BackupStore, file: string, text: string, clock: Clock): Promise<string> {
  const alias = Object.entries(store.aliases ?? {}).find(([, path]) => path === file)?.[0]
  const slug = alias ?? encodeURIComponent(file)
  const stamp = stampOf(clock)
  // Two writes in the same millisecond must not share a backup name.
  for (let n = 0; ; n++) {
    const path = `${store.dir}/${slug}.${stamp}${n === 0 ? '' : `-${n}`}.json`
    if ((await fs.readText(path)) === null) {
      await fs.writeText(path, text)
      return path
    }
  }
}

/** Backup file names (not the trash), newest first. */
export async function listBackups(fs: FileSystem, store: BackupStore): Promise<string[]> {
  const stamp = (name: string) => BACKUP_NAME.exec(name)?.[2] ?? ''
  return (await fs.listEntries(store.dir))
    .filter((name) => backupTarget(store, name) !== null)
    .sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.localeCompare(a))
}

/** Every backup and trash entry, newest first. */
export async function listAllBackups(fs: FileSystem, store: BackupStore): Promise<BackupInfo[]> {
  const files = (await listBackups(fs, store)).map((name) => ({ name, target: backupTarget(store, name) ?? '', at: atOf(name), trash: false }))
  const trash = (await fs.listEntries(store.dir))
    .filter(isTrashName)
    .map((name) => ({ name, target: decodeURIComponent(TRASH_NAME.exec(name)?.[1] ?? ''), at: atOf(name), trash: true }))
  return [...files, ...trash].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

/**
 * Puts a file backup back in place of its file, after backing up that file. `guard` refuses targets the agent
 * must not write (it runs after the name is known to be a backup); `version` is the view's version of the target.
 */
export async function restoreFile(
  fs: FileSystem,
  store: BackupStore,
  restore: { name: string; version: string },
  clock: Clock,
  guard: (target: string) => Promise<Refusal | null> = async () => null
): Promise<RestoreResult> {
  const { name } = restore
  const target = backupTarget(store, name)
  const text = target !== null && (await listBackups(fs, store)).includes(name) ? await fs.readText(`${store.dir}/${name}`) : null
  if (target === null || text === null) return { ok: false, reason: 'unknown-backup', message: `${name} is not a known backup.` }
  const refused = await guard(target)
  if (refused !== null) return refused
  const current = await fs.readText(target)
  if (versionOf(current) !== restore.version) {
    return { ok: false, reason: 'changed', message: 'The settings file changed since it was read. Refresh and try again.' }
  }
  const backup = await backUp(fs, store, target, current ?? '{}\n', clock)
  await fs.writeText(target, text)
  return { ok: true, backup }
}

/** Moves a skill folder or agent file (a symlink as a link) into the trash. */
export async function trashEntry(fs: FileSystem, store: BackupStore, entry: string, clock: Clock): Promise<TrashResult> {
  if (!(await occupied(fs, entry))) return { ok: false, reason: 'missing', message: `${entry} is no longer there.` }
  const stamp = stampOf(clock)
  for (let n = 0; ; n++) {
    const name = `${encodeURIComponent(entry)}.${stamp}${n === 0 ? '' : `-${n}`}.trash`
    if (await occupied(fs, `${store.dir}/${name}`)) continue
    await fs.move(entry, `${store.dir}/${name}`)
    return { ok: true, name, target: entry }
  }
}

/**
 * Puts a trash entry back where it was. Refuses when its folder is not one of `places` (the agent's skill and
 * agent folders, globally and in the projects it knows; `owner` names the agent) or when something is there now.
 */
export async function restoreTrash(fs: FileSystem, store: BackupStore, name: string, places: string[], owner: string): Promise<TrashResult> {
  const encoded = TRASH_NAME.exec(name)?.[1]
  const source = `${store.dir}/${name}`
  if (encoded === undefined || !(await occupied(fs, source))) {
    return { ok: false, reason: 'unknown-backup', message: `${name} is not a known backup.` }
  }
  const target = decodeURIComponent(encoded)
  const parent = target.slice(0, target.lastIndexOf('/'))
  if (!places.includes(parent)) {
    return { ok: false, reason: 'unknown-project', message: `${parent} is not a skills or agents folder of a project ${owner} knows.` }
  }
  if (await occupied(fs, target)) {
    return { ok: false, reason: 'exists', message: `Something is already at ${target}. Move it away first.` }
  }
  await fs.move(source, target)
  return { ok: true, name, target }
}

/** `2026-11-24T10-00-00-000Z` in a name back to milliseconds. */
function atOf(name: string): number {
  const stamp = new RegExp(`\\.(${STAMP})\\.`).exec(name)?.[1] ?? ''
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z).*$/, '$1:$2:$3.$4')
  const at = Date.parse(iso)
  return Number.isNaN(at) ? 0 : at
}
