// The backend of the panel contract in ./view.ts: the registered agent providers behind the shared router.
// Transports (the Orca worker, the localhost server) only pass requests in and answers out.
import type { Http } from '../core/ports.ts'
import { PROVIDERS } from '../providers/registry.ts'
import { routeAction, routeUpdates, routeView } from '../providers/router.ts'
import type { AgentProvider, ProviderDeps } from '../providers/types.ts'
import type { ActionAnswer, ActionRequest, AgentRequest, UpdatesAnswer, ViewAnswer } from './view.ts'

export { actionQueue } from '../core/queue.ts'

export interface BackendDeps extends ProviderDeps {
  /** The agents to answer for; defaults to every registered provider. */
  providers?: readonly AgentProvider[]
}

const providersOf = (deps: BackendDeps) => deps.providers ?? PROVIDERS

/** 'view.get': the requested agent's view (without one, the first detected agent). Never throws. */
export const buildView = (deps: BackendDeps, request?: AgentRequest): Promise<ViewAnswer> => routeView(deps, providersOf(deps), request)

/** 'action.run': runs one action for `request.agent`, then reads that agent's setup again. Never throws. */
export const runAction = (deps: BackendDeps, request: ActionRequest): Promise<ActionAnswer> => routeAction(deps, providersOf(deps), request)

/** 'updates.check': the agent's on-demand update check. Never throws. */
export const checkUpdates = (deps: BackendDeps & { http: Http }, request?: AgentRequest): Promise<UpdatesAnswer> =>
  routeUpdates(deps, providersOf(deps), request)
