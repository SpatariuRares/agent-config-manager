// Moves and copies skill folders and agent files between global and projects. A symlink moves (or is
// copied) as a link, never its target. Nothing is overwritten: an existing destination refuses.
import { occupied, sameFolder } from './paths.ts'
import type { FileSystem } from './ports.ts'

export type EntryKind = 'skills' | 'agents'

/** A skill folder or an agent file, as a provider read it. */
export interface EntryRef {
  kind: EntryKind
  name: string
  /** The skill folder or the agent file: what moves. */
  entry: string
  /** The symlink text when the entry is a symlink. */
  link: string | null
}

/** Where an agent keeps its skill and agent folders. */
export interface EntryPlaces {
  /** The folder of a class: globally (project null) or in a project. */
  dirOf(kind: EntryKind, project: string | null): string
  /** The projects the agent knows; only these are destinations. */
  projects(): Promise<string[]>
  /** The agent's name, for messages ("Claude Code"). */
  owner: string
}

export type EntryResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'exists' | 'same-place' | 'unknown-project' | 'not-movable'; message: string }

export async function moveEntry(fs: FileSystem, places: EntryPlaces, entry: EntryRef, toProject: string | null, copy: boolean): Promise<EntryResult> {
  const dir = places.dirOf(entry.kind, toProject)
  if (toProject !== null) {
    if (!(await places.projects()).includes(toProject)) {
      return { ok: false, reason: 'unknown-project', message: `${toProject} is not a project ${places.owner} knows.` }
    }
    if (await sameFolder(fs, dir, places.dirOf(entry.kind, null))) {
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

/** The entries of one folder: skill folders holding SKILL.md, or agent files, each with its link text. */
export async function readEntryDir(
  fs: FileSystem,
  kind: EntryKind,
  dir: string,
  read: (fs: FileSystem, dir: string) => Promise<{ name: string; description: string; path: string }[]>
): Promise<(EntryRef & { description: string; path: string })[]> {
  const entries: (EntryRef & { description: string; path: string })[] = []
  for (const item of await read(fs, dir)) {
    const entry = kind === 'skills' ? item.path.slice(0, -'/SKILL.md'.length) : item.path
    entries.push({ ...item, kind, entry, link: await fs.linkTarget(entry) })
  }
  return entries
}
