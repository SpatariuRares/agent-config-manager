// Panel state and the actions that talk to the worker. Views only read atoms and call actions.
import { atom, plugin, read, set } from 'orca'
import type { InventoryAnswer, WriteAnswer } from './protocol.ts'

export type Notice = { tone: 'success' | 'warning' | 'danger'; title: string; text: string; undo?: string }

export const answer = atom<InventoryAnswer | null>(null)
export const notice = atom<Notice | null>(null)
/** The plugin id being written, or 'restore'; writes are one at a time. */
export const busy = atom<string | null>(null)
export const backups = atom<string[]>([])
export const query = atom('query', '')
export const section = atom('section', 'plugins', { persist: 'plugin' })

const APPLIES = 'Applies to new Claude Code sessions, or run /reload-plugins in an open one.'
const nameOf = (path: string) => path.split('/').pop() ?? path

export async function refresh(): Promise<void> {
  set(answer, await plugin.request('inventory.get'))
  set(backups, await plugin.request('backups.list'))
}

export async function togglePlugin(id: string, enabled: boolean): Promise<void> {
  const current = read(answer)
  if (read(busy) !== null || current === null || !current.ok) return
  set(busy, id)
  try {
    const settingsVersion = current.inventory.settingsVersion
    show(await plugin.request('plugin.setEnabled', { id, enabled, settingsVersion }), {
      title: `${id} turned ${enabled ? 'on' : 'off'}`,
      text: APPLIES
    })
  } finally {
    set(busy, null)
  }
}

export async function restore(name: string): Promise<void> {
  if (read(busy) !== null) return
  set(busy, 'restore')
  try {
    show(await plugin.request('backup.restore', { name }), { title: `Restored ${name}`, text: APPLIES })
  } finally {
    set(busy, null)
  }
}

function show(write: WriteAnswer, success: { title: string; text: string }): void {
  set(answer, write.inventory)
  void plugin.request('backups.list').then((names) => set(backups, names))
  const { result } = write
  set(
    notice,
    result.ok
      ? { tone: 'success', ...success, undo: nameOf(result.backup) }
      : { tone: result.reason === 'changed' ? 'warning' : 'danger', title: 'Nothing was changed', text: result.message }
  )
}
