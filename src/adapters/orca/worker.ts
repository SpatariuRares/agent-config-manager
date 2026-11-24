// Orca worker: the only part of the plugin with disk access. It answers the panel.
import type { OrcaWorkerApi } from 'orca/worker'
import { readInventory } from '../../core/inventory.ts'
import { backupTarget, listBackups, restoreBackup, setPluginEnabled, setProjectPluginState, type WriteResult } from '../../core/toggle.ts'
import { uninstallPlugin, type UninstallResult } from '../../core/uninstall.ts'
import { claudeCli } from '../claude-cli.ts'
import { defaultClaudePaths, nodeFileSystem } from '../node-fs.ts'
import type { InventoryAnswer } from './protocol.ts'

const paths = defaultClaudePaths()
const fs = nodeFileSystem
const cli = claudeCli()

async function getInventory(): Promise<InventoryAnswer> {
  try {
    return { ok: true, inventory: await readInventory(fs, paths) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

// Changes run one at a time: each reads a file, checks its version, then replaces it.
let queue: Promise<unknown> = Promise.resolve()

function serialized<R>(run: () => Promise<R>, failed: (error: unknown) => R) {
  const next = queue.then(async () => {
    let result: R
    try {
      result = await run()
    } catch (error) {
      result = failed(error)
    }
    return { result, inventory: await getInventory() }
  })
  queue = next.catch(() => undefined)
  return next
}

const write = (run: () => Promise<WriteResult>) =>
  serialized<WriteResult>(run, (error) => ({ ok: false, reason: 'unreadable', message: String(error) }))

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('inventory.get', getInventory)
  orca.panels.handle('plugin.setEnabled', (change) => write(() => setPluginEnabled(fs, paths, change)))
  orca.panels.handle('plugin.setProjectState', (change) => write(() => setProjectPluginState(fs, paths, change)))
  orca.panels.handle('plugin.uninstall', ({ id }) =>
    serialized<UninstallResult>(
      () => uninstallPlugin(fs, cli, paths, id),
      (error) => ({ ok: false, reason: 'cli-failed', message: String(error), backups: [] })
    )
  )
  orca.panels.handle('backups.list', async () =>
    (await listBackups(fs, paths)).map((name) => ({ name, target: backupTarget(paths, name) ?? '' }))
  )
  orca.panels.handle('backup.restore', (restore) => write(() => restoreBackup(fs, paths, restore)))
}
