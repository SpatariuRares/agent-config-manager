// Removes a plugin through the official CLI, which owns the plugin files. There is no undo:
// the CLI deletes the plugin's files, so the way back is `claude plugin install <id>`.
import { projectSettingsFile, settingsFile } from './inventory.ts'
import type { FileSystem } from '../../core/ports.ts'
import type { ClaudePaths, PluginCli } from './ports.ts'
import { backUp } from '../../core/backups.ts'
import { claudeBackups, type Clock } from './toggle.ts'

export type UninstallResult =
  | { ok: true; backups: string[] }
  | { ok: false; reason: 'unknown-plugin' | 'cli-failed'; message: string; backups: string[] }

export async function uninstallPlugin(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  id: string,
  clock: Clock = () => new Date()
): Promise<UninstallResult> {
  let installed: Record<string, any> = {}
  try {
    installed = JSON.parse((await fs.readText(`${paths.claudeDir}/plugins/installed_plugins.json`)) ?? '{}') ?? {}
  } catch {
    // Treated as nothing installed.
  }
  const records: { scope: string; project: string | null }[] = (
    Array.isArray(installed.plugins?.[id]) ? installed.plugins[id] : []
  )
    .filter((record: unknown) => typeof record === 'object' && record !== null)
    .map((record: Record<string, any>) => ({ scope: String(record.scope ?? 'user'), project: record.projectPath ?? null }))
  if (records.length === 0) {
    return { ok: false, reason: 'unknown-plugin', message: `${id} is not installed.`, backups: [] }
  }

  // A project or local install needs its folder: the CLI finds the project from its working directory.
  const failures: string[] = []
  const runnable = records.filter((record) => {
    if (record.scope === 'user' || record.project !== null) return true
    failures.push(`${record.scope}: no project folder recorded, skipped`)
    return false
  })

  // The CLI also edits enabledPlugins in these files: keep a copy of each first.
  const backups: string[] = []
  const files = runnable.map((record) =>
    record.project === null ? settingsFile(paths) : projectSettingsFile(record.project, record.scope === 'local' ? 'local' : 'project')
  )
  for (const file of [...new Set(files)]) {
    const text = await fs.readText(file)
    if (text !== null) backups.push(await backUp(fs, claudeBackups(paths), file, text, clock))
  }

  for (const record of runnable) {
    const { ok, output } = await cli.uninstall(id, record.scope, record.project)
    if (!ok) failures.push(`${record.scope}${record.project ? ` (${record.project})` : ''}: ${output.trim()}`)
  }
  if (failures.length > 0) return { ok: false, reason: 'cli-failed', message: failures.join('\n'), backups }
  return { ok: true, backups }
}
