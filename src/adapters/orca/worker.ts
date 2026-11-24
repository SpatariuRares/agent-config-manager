// Orca worker: the only part of the plugin with disk access. It answers the panel contract in ../view.ts.
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import { actionQueue, buildView, checkUpdates, runAction, type BackendDeps } from '../backend.ts'
import { nodeCommandRunner } from '../claude-cli.ts'
import { nodeFileSystem } from '../node-fs.ts'
import { fetchHttp } from '../updates.ts'
import type { ActionRequest, AgentRequest } from '../view.ts'

const deps: BackendDeps & { http: ReturnType<typeof fetchHttp> } = {
  fs: nodeFileSystem,
  exec: nodeCommandRunner(),
  home: homedir(),
  http: fetchHttp()
}

// Actions run one at a time: each reads files, checks their versions, then writes.
const serialized = actionQueue()

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('view.get', (request) => buildView(deps, request as AgentRequest))
  orca.panels.handle('action.run', (request) => serialized(() => runAction(deps, request as ActionRequest)))
  // A check only reads (files, GitHub, npm), so it runs outside the action queue; only on demand.
  orca.panels.handle('updates.check', (request) => checkUpdates(deps, request as AgentRequest))
}
