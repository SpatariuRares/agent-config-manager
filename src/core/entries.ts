// Moves and copies skill folders and agent files between global and projects. A symlink moves
// (or is copied) as a link, never its target. Nothing is overwritten: an existing destination refuses.
import { occupied } from './backups.ts'
import { knownProjects } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'
import { entryDir, sameFolder, type Entry } from './setup.ts'

export type EntryResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'exists' | 'same-place' | 'unknown-project' | 'not-movable'; message: string }

export async function moveEntry(
  fs: FileSystem,
  paths: ClaudePaths,
  entry: Entry,
  toProject: string | null,
  copy: boolean
): Promise<EntryResult> {
  const dir = entryDir(paths, entry.kind, toProject)
  if (toProject !== null) {
    if (!(await knownProjects(fs, paths)).includes(toProject)) {
      return { ok: false, reason: 'unknown-project', message: `${toProject} is not a project Claude Code knows.` }
    }
    if (await sameFolder(fs, dir, entryDir(paths, entry.kind, null))) {
      return { ok: false, reason: 'same-place', message: `${toProject} is your home folder: its ${entry.kind} are the global ones.` }
    }
  }
  const from = entry.entry.slice(0, entry.entry.lastIndexOf('/'))
  if (from === dir || (await sameFolder(fs, from, dir))) {
    return { ok: false, reason: 'same-place', message: `"${entry.name}" is already there.` }
  }
  if (entry.link !== null && !entry.link.startsWith('/')) {
    return { ok: false, reason: 'not-movable', message: `"${entry.name}" is a relative link (${entry.link}); moving it would break it.` }
  }
  if (!(await occupied(fs, entry.entry))) return { ok: false, reason: 'missing', message: `${entry.entry} is no longer there.` }
  const path = `${dir}/${entry.entry.slice(entry.entry.lastIndexOf('/') + 1)}`
  if (await occupied(fs, path)) {
    return { ok: false, reason: 'exists', message: `${path} already exists. Rename or remove one of them first.` }
  }
  await (copy ? fs.copy(entry.entry, path) : fs.move(entry.entry, path))
  return { ok: true, path }
}
