// The shared router over stand-in providers: agent choice, detection, declared actions, errors.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeFs } from '../core/test-support.ts'
import type { Action, ActionRequest, AgentInfo, Kind } from '../adapters/view.ts'
import { assertUniqueIds, lookupProvider, routeAction, routeUpdates, routeView } from './router.ts'
import { fakeExec } from './testing.ts'
import type { AgentProvider, ProviderDeps } from './types.ts'

const deps: ProviderDeps = { fs: fakeFs({}), exec: fakeExec(), home: '/home', clock: () => new Date('2026-11-24T10:00:00.000Z') }
const http = { getJson: async () => ({ ok: false as const, status: null, error: 'offline', rateLimited: false }) }

/** A provider whose calls are recorded; it supports `supports` and is detected unless told otherwise. */
function stub(id: string, options: { detected?: boolean; supports?: AgentInfo['supports']; fail?: 'view' | 'action' } = {}) {
  const calls: ActionRequest[] = []
  const provider: AgentProvider = {
    id,
    async info() {
      return {
        id,
        name: `Agent ${id}`,
        detected: options.detected ?? true,
        kinds: ['skills', 'mcp'] as Kind[],
        supports: options.supports ?? { skills: ['remove'] },
        configHome: `~/.${id}`,
        note: `${id} keeps hooks elsewhere.`
      }
    },
    async buildView() {
      if (options.fail === 'view') throw new Error('unreadable config')
      return {
        items: [{ key: `skills:/home/.${id}/skills/x`, agent: id, kind: 'skills', name: 'x', description: '', project: null, scope: 'user', source: '', movable: false, removable: true }],
        projects: [],
        versions: {},
        backups: [],
        problems: []
      }
    },
    async runAction(_deps, request) {
      calls.push(request)
      if (options.fail === 'action') throw new Error('disk full')
      return { ok: true, message: `${id} did ${request.action.type}` }
    }
  }
  return { provider, calls }
}

const request = (agent: unknown, action: Action, versions: Record<string, string> = {}) => ({ agent, action, versions }) as ActionRequest

test('view.get without an agent shows the first detected one, and lists every agent for the switcher', async () => {
  const a = stub('a', { detected: false })
  const b = stub('b')
  const answer = await routeView(deps, [a.provider, b.provider], {})
  assert.ok(answer.ok)
  assert.equal(answer.view.agent, 'b')
  assert.deepEqual(answer.view.agents.map((info) => [info.id, info.detected]), [['a', false], ['b', true]])
  assert.equal(answer.view.items[0].agent, 'b')
})

test('view.get without any detected agent falls back to the first registered one', async () => {
  const answer = await routeView(deps, [stub('a', { detected: false }).provider, stub('b', { detected: false }).provider])
  assert.ok(answer.ok)
  assert.equal(answer.view.agent, 'a')
})

test('view.get names an agent: its view, even when it is not installed; an unknown agent is an error', async () => {
  const providers = [stub('a').provider, stub('b', { detected: false }).provider]
  const named = await routeView(deps, providers, { agent: 'b' })
  assert.ok(named.ok)
  assert.equal(named.view.agent, 'b')
  assert.deepEqual(await routeView(deps, providers, { agent: 'zed' }), { ok: false, error: 'Unknown agent "zed".' })
  assert.deepEqual(await routeView(deps, providers, { agent: 7 }), { ok: false, error: 'The request names no agent.' })
})

test('a view that cannot be read is an error answer, not a throw', async () => {
  const answer = await routeView(deps, [stub('a', { fail: 'view' }).provider], { agent: 'a' })
  assert.deepEqual(answer, { ok: false, error: 'Error: unreadable config' })
})

test('action.run goes to the agent the request names, with that agent fresh view after it', async () => {
  const a = stub('a')
  const b = stub('b')
  const answer = await routeAction(deps, [a.provider, b.provider], request('b', { type: 'remove', key: 'skills:/x' }, { f: '1' }))
  assert.deepEqual(answer.result, { ok: true, message: 'b did remove' })
  assert.deepEqual(a.calls, [])
  assert.deepEqual(b.calls, [{ agent: 'b', action: { type: 'remove', key: 'skills:/x' }, versions: { f: '1' } }])
  assert.ok(answer.view.ok)
  assert.equal(answer.view.view.agent, 'b')
})

test('action.run refuses a missing or unknown agent, and an agent that is not installed, before anything runs', async () => {
  const a = stub('a', { detected: false })
  for (const agent of [undefined, '', 'zed', '__proto__', 42]) {
    const answer = await routeAction(deps, [a.provider], request(agent, { type: 'remove', key: 'skills:/x' }))
    assert.equal(answer.result.ok === false && answer.result.reason, 'unknown-agent', String(agent))
    assert.equal(answer.view.ok, false)
  }
  const absent = await routeAction(deps, [a.provider], request('a', { type: 'remove', key: 'skills:/x' }))
  assert.deepEqual(absent.result, { ok: false, reason: 'not-detected', message: 'Agent a is not installed on this machine, so nothing was changed.' })
  assert.ok(absent.view.ok, 'the view of an agent that is not installed still reads')
  assert.deepEqual(a.calls, [])
  const garbage = await routeAction(deps, [a.provider], 'not a request')
  assert.equal(garbage.result.ok === false && garbage.result.reason, 'unknown-agent')
})

test('an action the agent did not declare for that class is refused as unsupported and never reaches it', async () => {
  const a = stub('a', { supports: { skills: ['remove'], mcp: ['update', 'updateAll'] } })
  const refused: Action[] = [
    { type: 'move', key: 'skills:/x', to: { project: null }, copy: false },
    { type: 'remove', key: 'mcp:["x"]' },
    { type: 'setEnabled', key: 'skills:/x', enabled: true },
    { type: 'update', key: 'plugins:["x"]' },
    { type: 'updateAll', kind: 'skills', keys: ['skills:/x'] },
    { type: 'refreshMarketplaces' },
    { type: 'snapshot' },
    { type: 'restore', name: 'x.json' }
  ]
  for (const action of refused) {
    const answer = await routeAction(deps, [a.provider], request('a', action))
    assert.equal(answer.result.ok === false && answer.result.reason, 'unsupported', action.type)
  }
  const message = await routeAction(deps, [a.provider], request('a', { type: 'remove', key: 'mcp:["x"]' }))
  assert.equal(message.result.message, 'Agent a cannot do "remove" for mcp here. a keeps hooks elsewhere.')
  assert.deepEqual(a.calls, [])
  ok(await routeAction(deps, [a.provider], request('a', { type: 'updateAll', kind: 'mcp', keys: [] })))
  assert.equal(a.calls.length, 1)
})

test('a class the agent does not have is refused even if its supports names it', async () => {
  const a = stub('a', { supports: { hooks: ['remove'] } })
  const answer = await routeAction(deps, [a.provider], request('a', { type: 'remove', key: 'hooks:["x"]' }))
  assert.equal(answer.result.ok === false && answer.result.reason, 'unsupported')
  assert.deepEqual(a.calls, [])
})

test('backup actions belong to no class: allowed when any class lists them', async () => {
  const a = stub('a', { supports: { mcp: ['restore', 'snapshot'] } })
  ok(await routeAction(deps, [a.provider], request('a', { type: 'snapshot' })))
  ok(await routeAction(deps, [a.provider], request('a', { type: 'restore', name: 'x.json' })))
  assert.deepEqual(a.calls.map((call) => call.action.type), ['snapshot', 'restore'])
})

test('a key that names no class is gone, an unknown type is unsupported, and a non-action is refused', async () => {
  const a = stub('a', { supports: { skills: ['remove'] } })
  const gone = await routeAction(deps, [a.provider], request('a', { type: 'remove', key: '/x' }))
  assert.deepEqual(gone.result, { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' })
  const unknown = await routeAction(deps, [a.provider], request('a', { type: 'explode' } as unknown as Action))
  assert.deepEqual(unknown.result, { ok: false, reason: 'unsupported', message: 'Unknown action explode.' })
  const none = await routeAction(deps, [a.provider], { agent: 'a', action: null } as unknown as ActionRequest)
  assert.deepEqual(none.result, { ok: false, reason: 'unsupported', message: 'That request is not an action.' })
  assert.deepEqual(a.calls, [])
})

test('a provider that throws while acting is reported as an error, with the view read again', async () => {
  const answer = await routeAction(deps, [stub('a', { fail: 'action' }).provider], request('a', { type: 'remove', key: 'skills:/x' }))
  assert.deepEqual(answer.result, { ok: false, reason: 'error', message: 'Error: disk full' })
  assert.ok(answer.view.ok)
})

test('updates.check asks the named agent; one without a check has nothing to check; an unknown one is an error', async () => {
  const checked = stub('a')
  checked.provider.checkUpdates = async () => ({ checkedAt: 1, statuses: { k: { status: 'current', latest: '1' } }, errors: [] })
  const plain = stub('b')
  const providers = [checked.provider, plain.provider]
  assert.deepEqual(await routeUpdates({ ...deps, http }, providers, { agent: 'a' }), { checkedAt: 1, statuses: { k: { status: 'current', latest: '1' } }, errors: [] })
  const at = new Date('2026-11-24T10:00:00.000Z').getTime()
  assert.deepEqual(await routeUpdates({ ...deps, http }, providers, { agent: 'b' }), { checkedAt: at, statuses: {}, errors: [] })
  assert.deepEqual(await routeUpdates({ ...deps, http }, providers, { agent: 'zed' }), { checkedAt: at, statuses: {}, errors: ['Unknown agent "zed".'] })
  checked.provider.checkUpdates = async () => {
    throw new Error('boom')
  }
  assert.deepEqual(await routeUpdates({ ...deps, http }, providers, {}), { checkedAt: at, statuses: {}, errors: ['The check stopped: Error: boom'] })
})

test('provider lookup refuses unknown ids, and a registry refuses two providers with one id', () => {
  const a = stub('a').provider
  assert.equal(lookupProvider([a], 'a').ok, true)
  assert.equal(lookupProvider([a], 'constructor').ok, false)
  assert.throws(() => assertUniqueIds([a, stub('a').provider]), /share the id "a"/)
})

function ok(answer: { result: { ok: boolean; message: string } }) {
  assert.equal(answer.result.ok, true, answer.result.message)
}
