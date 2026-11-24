// Claude Code's side of the shared backup store: its trash places, and a snapshot of every settings file at once.
import * as store from '../../core/backups.ts'
import type { BackupInfo, TrashResult } from '../../core/backups.ts'
import type { Clock, FileSystem } from '../../core/ports.ts'
import { isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile } from './inventory.ts'
import type { ClaudePaths } from './ports.ts'
import { entryDir, mcpFile } from './setup.ts'
import { backUp, claudeBackups } from './toggle.ts'

export { isTrashName } from '../../core/backups.ts'
export { occupied } from '../../core/paths.ts'
export type { BackupInfo, TrashResult } from '../../core/backups.ts'

/** Every backup and trash entry, newest first. */
export const listAllBackups = (fs: FileSystem, paths: ClaudePaths): Promise<BackupInfo[]> => store.listAllBackups(fs, claudeBackups(paths))

/** Moves a skill folder or agent file (a symlink as a link) into the trash. */
export const trashEntry = (fs: FileSystem, paths: ClaudePaths, entry: string, clock: Clock): Promise<TrashResult> =>
  store.trashEntry(fs, claudeBackups(paths), entry, clock)

/** Puts a trash entry back where it was; refuses when something is there now. */
export async function restoreTrash(fs: FileSystem, paths: ClaudePaths, name: string): Promise<TrashResult> {
  const places = [null, ...(await knownProjects(fs, paths))].flatMap((project) =>
    (['skills', 'agents'] as const).map((kind) => entryDir(paths, kind, project))
  )
  return store.restoreTrash(fs, claudeBackups(paths), name, places, 'Claude Code')
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
