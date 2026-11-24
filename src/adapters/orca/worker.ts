// Orca worker: the only part of the plugin with disk access. It answers the panel contract in ../view.ts.
import type { OrcaWorkerApi } from 'orca/worker'
import { actionQueue, buildView, runAction, type BackendDeps } from '../backend.ts'
import { claudeCli } from '../claude-cli.ts'
import { defaultClaudePaths, nodeFileSystem } from '../node-fs.ts'
import type { ActionRequest } from '../view.ts'

const deps: BackendDeps = { fs: nodeFileSystem, cli: claudeCli(), paths: defaultClaudePaths() }

// Actions run one at a time: each reads files, checks their versions, then writes.
const serialized = actionQueue()

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('view.get', () => buildView(deps))
  orca.panels.handle('action.run', (request) => serialized(() => runAction(deps, request as ActionRequest)))
}
