// Orca worker: the only part of the plugin with disk access. It answers the panel.
import type { OrcaWorkerApi } from 'orca/worker'
import { readInventory } from '../../core/inventory.ts'
import { listBackups, restoreBackup, setPluginEnabled, type WriteResult } from '../../core/toggle.ts'
import { defaultClaudePaths, nodeFileSystem } from '../node-fs.ts'
import type { InventoryAnswer, WriteAnswer } from './protocol.ts'

const paths = defaultClaudePaths()

async function getInventory(): Promise<InventoryAnswer> {
  try {
    return { ok: true, inventory: await readInventory(nodeFileSystem, paths) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// Writes run one at a time: each reads settings.json, checks its version, then replaces it.
let queue: Promise<unknown> = Promise.resolve()

function write(run: () => Promise<WriteResult>): Promise<WriteAnswer> {
  const next = queue.then(async () => {
    let result: WriteResult
    try {
      result = await run()
    } catch (error) {
      result = { ok: false, reason: 'unreadable', message: String(error) }
    }
    return { result, inventory: await getInventory() }
  })
  queue = next.catch(() => undefined)
  return next
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('inventory.get', getInventory)
  orca.panels.handle('plugin.setEnabled', (change) => write(() => setPluginEnabled(nodeFileSystem, paths, change)))
  orca.panels.handle('backups.list', () => listBackups(nodeFileSystem, paths))
  orca.panels.handle('backup.restore', (restore) => write(() => restoreBackup(nodeFileSystem, paths, restore)))
}
