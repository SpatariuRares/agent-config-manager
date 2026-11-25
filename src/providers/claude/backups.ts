// Claude Code's backup plan: what restore and snapshot work with (the router runs both, ../backup-actions.ts).
// The store is the historical ~/.claude/backups/claude-config-manager; the files are every settings file this app
// writes, globally and in every known project (a project Claude Code no longer lists is not restorable); trashed
// skills and agents go back to their .claude folders. ~/.claude.json is backed up but never restored.
import { tilde } from '../../core/paths.ts'
import type { BackupPlan } from '../backup-actions.ts'
import { entryKey, NOTE } from './actions.ts'
import { isUserSettingsFile, knownProjects, projectSettingsFile, settingsFile } from './inventory.ts'
import type { ClaudeDeps } from './ports.ts'
import { entryDir, mcpFile } from './setup.ts'
import { claudeBackups } from './toggle.ts'

export async function claudeBackupPlan({ fs, paths }: Pick<ClaudeDeps, 'fs' | 'paths'>): Promise<BackupPlan> {
  const projects = await knownProjects(fs, paths)
  const files = [settingsFile(paths)]
  for (const project of projects) {
    for (const scope of ['project', 'local'] as const) {
      const file = projectSettingsFile(project, scope)
      if (!(await isUserSettingsFile(fs, paths, file))) files.push(file)
    }
    files.push(mcpFile(project))
  }
  const home = paths.claudeDir.slice(0, paths.claudeDir.lastIndexOf('/'))
  return {
    owner: 'Claude Code',
    store: claudeBackups(paths),
    files,
    owned: [{ file: paths.userConfigFile, reason: 'claude-owned', why: 'Claude Code rewrites all the time, so this app never writes it; quit Claude Code first' }],
    entryFolders: [null, ...projects].flatMap((project) => (['skills', 'agents'] as const).map((kind) => entryDir(paths, kind, project))),
    say: (path) => tilde(home, path),
    note: NOTE,
    entryKey: (target) => entryKey(target.slice(0, target.lastIndexOf('/')).endsWith('/skills') ? 'skills' : 'agents', target)
  }
}
