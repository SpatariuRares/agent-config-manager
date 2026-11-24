// The shared part of every request: which provider answers it, whether its agent is installed, and whether
// it declared the action. A provider is never called with an action it did not list in `info().supports`.
import { isObject } from '../core/json.ts'
import type { Http } from '../core/ports.ts'
import type { Action, ActionAnswer, ActionRequest, ActionResult, AgentInfo, AgentRequest, Kind, UpdatesAnswer, ViewAnswer } from '../adapters/view.ts'
import { ACTION_TYPES, BACKUP_ACTIONS, isKind, kindOfKey, type AgentProvider, type ProviderDeps } from './types.ts'

export type ProviderLookup = { ok: true; provider: AgentProvider } | { ok: false; reason: 'unknown-agent'; message: string }

/** The provider with this id; anything else (a missing id, a non-string, an unknown name) is refused. */
export function lookupProvider(providers: readonly AgentProvider[], id: unknown): ProviderLookup {
  if (typeof id !== 'string' || id === '') return { ok: false, reason: 'unknown-agent', message: 'The request names no agent.' }
  const provider = providers.find((p) => p.id === id)
  if (provider === undefined) return { ok: false, reason: 'unknown-agent', message: `Unknown agent ${JSON.stringify(id.slice(0, 64))}.` }
  return { ok: true, provider }
}

/** Throws when two providers share an id: the registry must be unambiguous. */
export function assertUniqueIds(providers: readonly AgentProvider[]): void {
  const seen = new Set<string>()
  for (const { id } of providers) {
    if (seen.has(id)) throw new Error(`Two agent providers share the id "${id}".`)
    seen.add(id)
  }
}

/** The requested agent, or without one the first detected agent (the first registered when none is). */
async function pick(deps: ProviderDeps, providers: readonly AgentProvider[], request: unknown) {
  const infos = await Promise.all(providers.map((provider) => provider.info(deps)))
  const wanted = isObject(request) ? request.agent : undefined
  if (wanted === undefined) {
    if (providers.length === 0) return { infos, found: { ok: false, reason: 'unknown-agent', message: 'No agents are registered.' } as const }
    const index = Math.max(0, infos.findIndex((info) => info.detected))
    return { infos, found: { ok: true, provider: providers[index] } as const }
  }
  return { infos, found: lookupProvider(providers, wanted) }
}

/** 'view.get': that agent's view, plus every registered agent for the switcher. Never throws. */
export async function routeView(deps: ProviderDeps, providers: readonly AgentProvider[], request?: AgentRequest | unknown): Promise<ViewAnswer> {
  try {
    const { infos, found } = await pick(deps, providers, request)
    if (!found.ok) return { ok: false, error: found.message }
    const view = await found.provider.buildView(deps)
    return { ok: true, view: { agents: infos, agent: found.provider.id, ...view } }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** 'action.run': checks agent, detection and support, runs the action, then reads that agent's view again. */
export async function routeAction(deps: ProviderDeps, providers: readonly AgentProvider[], request: ActionRequest | unknown): Promise<ActionAnswer> {
  const found = lookupProvider(providers, isObject(request) ? request.agent : undefined)
  if (!found.ok) return { result: { ok: false, reason: found.reason, message: found.message }, view: { ok: false, error: found.message } }
  const { provider } = found
  let result: ActionResult
  try {
    result = await checked(deps, provider, request as ActionRequest)
  } catch (error) {
    result = { ok: false, reason: 'error', message: String(error) }
  }
  return { result, view: await routeView(deps, providers, { agent: provider.id }) }
}

async function checked(deps: ProviderDeps, provider: AgentProvider, request: ActionRequest): Promise<ActionResult> {
  const info = await provider.info(deps)
  if (!info.detected) {
    return { ok: false, reason: 'not-detected', message: `${info.name} is not installed on this machine, so nothing was changed.` }
  }
  const action = isObject(request.action) ? (request.action as Action) : null
  if (action === null || typeof action.type !== 'string') return { ok: false, reason: 'unsupported', message: 'That request is not an action.' }
  const refused = refusal(info, action)
  if (refused !== null) return refused
  const versions: Record<string, string> = isObject(request.versions) ? request.versions : {}
  return provider.runAction(deps, { agent: provider.id, action, versions })
}

/** Why the agent cannot run this action, or null when it declared it for the action's class. */
export function refusal(info: AgentInfo, action: Action): (ActionResult & { ok: false }) | null {
  const type: string = action.type
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return { ok: false, reason: 'unsupported', message: `Unknown action ${type}.` }
  const declared = (kind: Kind) => (info.supports[kind] ?? []).includes(action.type)
  const unsupported = (where: string) => ({
    ok: false as const,
    reason: 'unsupported',
    message: `${info.name} cannot do "${type}" ${where} here.${info.note ? ` ${info.note}` : ''}`
  })

  if (BACKUP_ACTIONS.includes(action.type)) return info.kinds.some(declared) ? null : unsupported('on its backups')
  const kind: Kind | null =
    action.type === 'refreshMarketplaces'
      ? 'plugins'
      : action.type === 'updateAll'
        ? (isKind(action.kind) ? action.kind : null)
        : kindOfKey((action as { key?: unknown }).key)
  if (kind === null) {
    if (action.type === 'updateAll') return { ok: false, reason: 'unsupported', message: 'There is nothing to update.' }
    return { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' }
  }
  return info.kinds.includes(kind) && declared(kind) ? null : unsupported(`for ${kind}`)
}

/** 'updates.check': the agent's own check, or nothing to check when it has none. Never throws. */
export async function routeUpdates(
  deps: ProviderDeps & { http: Http },
  providers: readonly AgentProvider[],
  request?: AgentRequest | unknown
): Promise<UpdatesAnswer> {
  const checkedAt = (deps.clock ?? (() => new Date()))().getTime()
  try {
    const { found } = await pick(deps, providers, request)
    if (!found.ok) return { checkedAt, statuses: {}, errors: [found.message] }
    if (found.provider.checkUpdates === undefined) return { checkedAt, statuses: {}, errors: [] }
    return await found.provider.checkUpdates(deps)
  } catch (error) {
    return { checkedAt, statuses: {}, errors: [`The check stopped: ${String(error)}`] }
  }
}
