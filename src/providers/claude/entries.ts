// Claude Code's skill and agent folders for the shared entry move in core.
import * as core from '../../core/entries.ts'
import type { EntryResult } from '../../core/entries.ts'
import type { FileSystem } from '../../core/ports.ts'
import { knownProjects } from './inventory.ts'
import type { ClaudePaths } from './ports.ts'
import { entryDir, type Entry } from './setup.ts'

export type { EntryResult } from '../../core/entries.ts'

export const claudeEntryPlaces = (fs: FileSystem, paths: ClaudePaths): core.EntryPlaces => ({
  dirOf: (kind, project) => entryDir(paths, kind, project),
  projects: () => knownProjects(fs, paths),
  owner: 'Claude Code'
})

export const moveEntry = (fs: FileSystem, paths: ClaudePaths, entry: Entry, toProject: string | null, copy: boolean): Promise<EntryResult> =>
  core.moveEntry(fs, claudeEntryPlaces(fs, paths), entry, toProject, copy)
