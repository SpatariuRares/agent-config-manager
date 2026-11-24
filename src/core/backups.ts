// Backups beyond single settings writes: a restorable trash for removed skills and agents,
// the list of everything that can be restored, and a snapshot of every settings file at once.
import { isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'
import { entryDir, mcpFile } from './setup.ts'
import { backUp, backupDir, backupTarget, listBackups, type Clock } from './toggle.ts'

const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?`
/** `<encoded original path>.<stamp>[-n].trash`: a removed skill folder or agent file, kept as it was. */
const TRASH_NAME = new RegExp(String.raw`^(%2F[A-Za-z0-9%._~!*'()-]+)\.(${STAMP})\.trash$`)

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

/** Whether anything, a broken symlink included, is at `path`. */
export async function occupied(fs: FileSystem, path: string): Promise<boolean> {
  return (await fs.realPath(path)) !== null || (await fs.linkTarget(path)) !== null
}

export const isTrashName = (name: string) => TRASH_NAME.test(name)

/** Every backup and trash entry, newest first. */
export async function listAllBackups(fs: FileSystem, paths: ClaudePaths): Promise<BackupInfo[]> {
  const files = (await listBackups(fs, paths)).map((name) => ({
    name,
    target: backupTarget(paths, name) ?? '',
    at: atOf(name),
    trash: false
  }))
  const trash = (await fs.listEntries(backupDir(paths)))
    .filter(isTrashName)
    .map((name) => ({ name, target: decodeURIComponent(TRASH_NAME.exec(name)?.[1] ?? ''), at: atOf(name), trash: true }))
  return [...files, ...trash].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

/** Moves a skill folder or agent file (a symlink as a link) into the trash. */
export async function trashEntry(fs: FileSystem, paths: ClaudePaths, entry: string, clock: Clock): Promise<TrashResult> {
  if (!(await occupied(fs, entry))) return { ok: false, reason: 'missing', message: `${entry} is no longer there.` }
  const stamp = clock().toISOString().replace(/[:.]/g, '-')
  for (let n = 0; ; n++) {
    const name = `${encodeURIComponent(entry)}.${stamp}${n === 0 ? '' : `-${n}`}.trash`
    if (await occupied(fs, `${backupDir(paths)}/${name}`)) continue
    await fs.move(entry, `${backupDir(paths)}/${name}`)
    return { ok: true, name, target: entry }
  }
}

/** Puts a trash entry back where it was; refuses when something is there now. */
export async function restoreTrash(fs: FileSystem, paths: ClaudePaths, name: string): Promise<TrashResult> {
  const encoded = TRASH_NAME.exec(name)?.[1]
  const source = `${backupDir(paths)}/${name}`
  if (encoded === undefined || !(await occupied(fs, source))) {
    return { ok: false, reason: 'unknown-backup', message: `${name} is not a known backup.` }
  }
  const target = decodeURIComponent(encoded)
  const parent = target.slice(0, target.lastIndexOf('/'))
  const places = [null, ...(await knownProjects(fs, paths))].flatMap((project) =>
    (['skills', 'agents'] as const).map((kind) => entryDir(paths, kind, project))
  )
  if (!places.includes(parent)) {
    return { ok: false, reason: 'unknown-project', message: `${parent} is not a skills or agents folder of a project Claude Code knows.` }
  }
  if (await occupied(fs, target)) {
    return { ok: false, reason: 'exists', message: `Something is already at ${target}. Move it away first.` }
  }
  await fs.move(source, target)
  return { ok: true, name, target }
}

/** Backs up every settings file that exists, globally and in every known project. Returns the backups. */
export async function snapshot(fs: FileSystem, paths: ClaudePaths, clock: Clock): Promise<string[]> {
  const files = [settingsFile(paths), paths.userConfigFile]
  for (const project of await knownProjects(fs, paths)) {
    for (const scope of ['project', 'local'] as const) {
      const file = projectSettingsFile(project, scope)
      if (!(await isUserSettingsFile(fs, paths, file))) files.push(file)
    }
    files.push(mcpFile(project))
  }
  const backups: string[] = []
  for (const file of files) {
    const text = await fs.readText(file)
    if (text !== null) backups.push(await backUp(fs, paths, file, text, clock))
  }
  return backups
}

/** `2026-11-24T10-00-00-000Z` in a name back to milliseconds. */
function atOf(name: string): number {
  const stamp = new RegExp(`\\.(${STAMP})\\.`).exec(name)?.[1] ?? ''
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z).*$/, '$1:$2:$3.$4')
  const at = Date.parse(iso)
  return Number.isNaN(at) ? 0 : at
}
