// Orca worker: the only part of the plugin with disk access. It answers the panel.
import type { OrcaWorkerApi } from 'orca/worker'
import { readInventory } from '../../core/inventory.ts'
import { defaultClaudePaths, nodeFileSystem } from '../node-fs.ts'
import type { InventoryAnswer } from './protocol.ts'

async function getInventory(): Promise<InventoryAnswer> {
  try {
    return { ok: true, inventory: await readInventory(nodeFileSystem, defaultClaudePaths()) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('inventory.get', getInventory)
}
