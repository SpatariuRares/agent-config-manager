// Orca worker: the only part of the plugin with disk access. It answers the panel contract in ../view.ts.
import type { OrcaWorkerApi } from 'orca/worker'
import { actionQueue, buildView, runAction, type BackendDeps } from '../backend.ts'
import { claudeCli } from '../claude-cli.ts'
import { defaultClaudePaths, nodeFileSystem } from '../node-fs.ts'
import { checkUpdates, fetchHttp } from '../updates.ts'
import type { ActionRequest } from '../view.ts'

const deps: BackendDeps & { http: ReturnType<typeof fetchHttp> } = {
  fs: nodeFileSystem,
  cli: claudeCli(),
  paths: defaultClaudePaths(),
  http: fetchHttp()
}

// Actions run one at a time: each reads files, checks their versions, then writes.
const serialized = actionQueue()

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('view.get', () => buildView(deps))
  orca.panels.handle('action.run', (request) => serialized(() => runAction(deps, request as ActionRequest)))
  // A check only reads (files, GitHub, npm), so it runs outside the action queue; only on demand.
  orca.panels.handle('updates.check', () => checkUpdates(deps))
}
