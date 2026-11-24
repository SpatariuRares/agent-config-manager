// Panel state and the actions that talk to the worker. Views only read atoms and call actions.
import { atom, plugin, read, set } from 'orca'
import { projectSettingsFile, type Inventory, type ProjectScope } from '../../core/inventory.ts'
import type { BackupEntry, InventoryAnswer, UninstallAnswer, WriteAnswer } from './protocol.ts'

export type Notice = { tone: 'success' | 'warning' | 'danger'; title: string; text: string; undo?: BackupEntry }

/** Where the plugin switches act: 'global', or a project folder. */
export const GLOBAL = 'global'

export const answer = atom<InventoryAnswer | null>(null)
export const notice = atom<Notice | null>(null)
/** The plugin id being changed, or 'restore'; changes are one at a time. */
export const busy = atom<string | null>(null)
export const backups = atom<BackupEntry[]>([])
/** The plugin id waiting for its uninstall to be confirmed. */
export const confirmingUninstall = atom<string | null>(null)
export const query = atom('query', '')
export const section = atom('section', 'plugins', { persist: 'plugin' })
export const context = atom('context', GLOBAL, { persist: 'plugin' })
export const saveIn = atom<ProjectScope>('saveIn', 'local', { persist: 'plugin' })

const APPLIES = 'Applies to new Claude Code sessions, or run /reload-plugins in an open one.'

export const projectLabel = (path: string) => path.split('/').filter(Boolean).pop() ?? path

function inventory(): Inventory | null {
  const current = read(answer)
  return current !== null && current.ok ? current.inventory : null
}

export async function refresh(): Promise<void> {
  set(answer, await plugin.request('inventory.get'))
  set(backups, await plugin.request('backups.list'))
}

async function change(key: string, run: () => Promise<void>): Promise<void> {
  if (read(busy) !== null || inventory() === null) return
  set(busy, key)
  try {
    await run()
  } finally {
    set(busy, null)
  }
}

/** Flips a plugin where the panel currently acts: globally, or in the chosen project. */
export function setPlugin(id: string, enabled: boolean): Promise<void> {
  return change(id, async () => {
    const inv = inventory()!
    const where = read(context)
    if (where === GLOBAL) {
      const write = await plugin.request('plugin.setEnabled', { id, enabled, settingsVersion: inv.settingsVersion })
      return show(write, `${id} turned ${enabled ? 'on' : 'off'} everywhere`)
    }
    await setInProject(id, where, read(saveIn), enabled)
  })
}

/** Removes a project override, so the project follows the global value again. */
export function clearOverride(id: string, project: string, scope: ProjectScope): Promise<void> {
  return change(id, () => setInProject(id, project, scope, null))
}

async function setInProject(id: string, project: string, scope: ProjectScope, enabled: boolean | null) {
  const version = inventory()!.versions[projectSettingsFile(project, scope)] ?? ''
  const write = await plugin.request('plugin.setProjectState', { id, project, scope, enabled, version })
  const what = enabled === null ? 'follows the global setting' : `turned ${enabled ? 'on' : 'off'}`
  show(write, `${id} ${what} in ${projectLabel(project)} (${scope === 'local' ? 'only me' : 'team'})`)
}

export function uninstall(id: string): Promise<void> {
  set(confirmingUninstall, null)
  return change(id, async () => {
    const { result, inventory: next } = (await plugin.request('plugin.uninstall', { id })) as UninstallAnswer
    set(answer, next)
    set(backups, await plugin.request('backups.list'))
    set(
      notice,
      result.ok
        ? { tone: 'success', title: `${id} uninstalled`, text: `Its data was kept. To get it back: claude plugin install ${id}` }
        : { tone: 'danger', title: `Could not fully uninstall ${id}`, text: result.message }
    )
  })
}

export function restore(entry: BackupEntry): Promise<void> {
  return change('restore', async () => {
    const settingsVersion = inventory()!.versions[entry.target] ?? ''
    show(await plugin.request('backup.restore', { name: entry.name, settingsVersion }), `Restored ${projectLabel(entry.target)}`)
  })
}

function show(write: WriteAnswer, title: string): void {
  set(answer, write.inventory)
  void plugin.request('backups.list').then((entries) => {
    set(backups, entries)
    const { result } = write
    set(
      notice,
      !result.ok
        ? { tone: result.reason === 'changed' ? 'warning' : 'danger', title: 'Nothing was changed', text: result.message }
        : result.backup === null
          ? { tone: 'success', title: 'Already set', text: 'Nothing needed changing.' }
          : { tone: 'success', title, text: APPLIES, undo: entries.find((e) => result.backup!.endsWith(`/${e.name}`)) }
    )
  })
}
