// 'copyToAgent' in the shared router: what it checks before any provider runs, and what it answers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeFs } from '../core/test-support.ts'
import type { Action, ActionRequest, ActionResult, AgentInfo, Kind, Target } from '../adapters/view.ts'
import { routeAction } from './router.ts'
import { fakeExec, projectScopeProblems } from './testing.ts'
import type { AgentProvider, Portable, ProviderDeps } from './types.ts'

const deps: ProviderDeps = { fs: fakeFs({}), exec: fakeExec(), home: '/home', clock: () => new Date('2026-11-24T10:00:00.000Z') }

const SKILL: Portable = { kind: 'skills', name: 'pdf', dir: '/home/.a/skills/pdf', link: null }

/** A provider that records every exportItem and importItem call. */
function agent(
  id: string,
  options: {
    detected?: boolean
    exports?: Kind[]
    imports?: Kind[]
    projectScopes?: AgentInfo['projectScopes']
    exported?: Awaited<ReturnType<NonNullable<AgentProvider['exportItem']>>>
    imported?: ActionResult
    versions?: Record<string, string>
  } = {}
) {
  const calls: string[] = []
  const provider: AgentProvider = {
    id,
    async info() {
      return {
        id,
        name: `Agent ${id}`,
        detected: options.detected ?? true,
        kinds: ['skills', 'mcp'] as Kind[],
        supports: {},
        projectScopes: options.projectScopes ?? {},
        exports: options.exports ?? [],
        imports: options.imports ?? [],
        configHome: `~/.${id}`
      }
    },
    async buildView() {
      return { items: [], projects: [], versions: options.versions ?? { [`/home/.${id}/file`]: `v-${id}` }, backups: [], problems: [] }
    },
    async runAction(_deps, request) {
      calls.push(`runAction ${request.action.type}`)
      return { ok: true, message: 'ran' }
    },
    async exportItem(_deps, key) {
      calls.push(`export ${key}`)
      return options.exported ?? { ok: true, item: SKILL }
    },
    async importItem(_deps, item, to, versions) {
      calls.push(`import ${item.name} ${JSON.stringify(to)} ${JSON.stringify(versions)}`)
      return options.imported ?? { ok: true, message: 'Copied skill "pdf".', undo: { type: 'remove', key: 'skills:/home/.b/skills/pdf' } }
    }
  }
  return { provider, calls }
}

const copy = (key: string, toAgent: string, to: Target = { project: null }): ActionRequest =>
  ({ agent: 'a', action: { type: 'copyToAgent', key, toAgent, to } as Action, versions: {} }) as ActionRequest

const refusedWith = (result: ActionResult) => (result.ok ? 'ok' : result.reason)

test('copyToAgent exports from the source, imports into the target with its own versions, and answers with the source view', async () => {
  const a = agent('a', { exports: ['skills'] })
  const b = agent('b', { imports: ['skills'] })
  const answer = await routeAction(deps, [a.provider, b.provider], copy('skills:/home/.a/skills/pdf', 'b'))
  assert.deepEqual(answer.result, {
    ok: true,
    message: 'Agent b: Copied skill "pdf".',
    undo: { type: 'remove', key: 'skills:/home/.b/skills/pdf' },
    undoAgent: 'b'
  })
  assert.deepEqual(a.calls, ['export skills:/home/.a/skills/pdf'])
  assert.deepEqual(b.calls, ['import pdf {"project":null} {"/home/.b/file":"v-b"}'])
  assert.ok(answer.view.ok)
  assert.equal(answer.view.view.agent, 'a', 'the view is the source agent')
})

test('copyToAgent without an undo from the target has no undoAgent', async () => {
  const a = agent('a', { exports: ['skills'] })
  const b = agent('b', { imports: ['skills'], imported: { ok: true, message: 'Copied.' } })
  const answer = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b'))
  assert.deepEqual(answer.result, { ok: true, message: 'Agent b: Copied.' })
})

test('copyToAgent is refused when the source does not export the class, before any provider runs', async () => {
  const a = agent('a', { exports: ['mcp'] })
  const b = agent('b', { imports: ['skills'] })
  const answer = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b'))
  assert.deepEqual(answer.result, { ok: false, reason: 'unsupported', message: 'Agent a cannot copy skills to another agent here.' })
  assert.deepEqual([...a.calls, ...b.calls], [])
})

test('copyToAgent is refused when the target does not import the class, before any provider runs', async () => {
  const a = agent('a', { exports: ['skills'] })
  const b = agent('b', { imports: ['mcp'] })
  const answer = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b'))
  assert.deepEqual(answer.result, { ok: false, reason: 'unsupported', message: 'Agent b cannot take skills from another agent here.' })
  assert.deepEqual([...a.calls, ...b.calls], [])
})

test('copyToAgent is refused when either agent is not detected, before any provider runs', async () => {
  const absentSource = agent('a', { exports: ['skills'], detected: false })
  const b = agent('b', { imports: ['skills'] })
  const fromAbsent = await routeAction(deps, [absentSource.provider, b.provider], copy('skills:/x', 'b'))
  assert.deepEqual(fromAbsent.result, { ok: false, reason: 'not-detected', message: 'Agent a is not installed on this machine, so nothing was copied.' })

  const a = agent('a', { exports: ['skills'] })
  const absentTarget = agent('b', { imports: ['skills'], detected: false })
  const toAbsent = await routeAction(deps, [a.provider, absentTarget.provider], copy('skills:/x', 'b'))
  assert.deepEqual(toAbsent.result, { ok: false, reason: 'not-detected', message: 'Agent b is not installed on this machine, so nothing was copied.' })
  assert.deepEqual([...absentSource.calls, ...b.calls, ...a.calls, ...absentTarget.calls], [])
})

test('copyToAgent into a project is refused when the target did not declare that scope, before any provider runs', async () => {
  const a = agent('a', { exports: ['skills', 'mcp'] })
  const b = agent('b', { imports: ['skills', 'mcp'], projectScopes: { skills: ['project'] } })
  const local = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b', { project: '/work/shop', scope: 'local' }))
  assert.deepEqual(local.result, {
    ok: false,
    reason: 'unsupported',
    message: 'Agent b cannot put skills into a project as "only me" (local); it can use "team" (project).'
  })
  const none = await routeAction(deps, [a.provider, b.provider], copy('mcp:["x"]', 'b', { project: '/work/shop', scope: 'project' }))
  assert.deepEqual(none.result, { ok: false, reason: 'unsupported', message: 'Agent b cannot put mcp into a project here.' })
  assert.deepEqual([...a.calls, ...b.calls], [])

  const team = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b', { project: '/work/shop', scope: 'project' }))
  assert.equal(team.result.ok, true)
  assert.match(b.calls[0], /^import pdf \{"project":"\/work\/shop","scope":"project"\}/)
})

test('copyToAgent refuses an unknown target, the source itself, a key with no class and a missing destination', async () => {
  const a = agent('a', { exports: ['skills'], imports: ['skills'] })
  const providers = [a.provider]
  assert.equal(refusedWith((await routeAction(deps, providers, copy('skills:/x', 'zed'))).result), 'unknown-agent')
  assert.equal(refusedWith((await routeAction(deps, providers, copy('skills:/x', 'a'))).result), 'same-agent')
  assert.equal(refusedWith((await routeAction(deps, providers, copy('/x', 'a'))).result), 'changed')
  const b = agent('b', { imports: ['skills'] })
  const noPlace = { agent: 'a', action: { type: 'copyToAgent', key: 'skills:/x', toAgent: 'b' }, versions: {} } as unknown as ActionRequest
  assert.equal(refusedWith((await routeAction(deps, [a.provider, b.provider], noPlace)).result), 'invalid')
  assert.deepEqual([...a.calls, ...b.calls], [])
})

test('a source refusal names the source agent; a target refusal names the target agent', async () => {
  const a = agent('a', { exports: ['skills'], exported: { ok: false, reason: 'not-portable', message: '"pdf" is a relative link.' } })
  const b = agent('b', { imports: ['skills'] })
  const fromSource = await routeAction(deps, [a.provider, b.provider], copy('skills:/x', 'b'))
  assert.deepEqual(fromSource.result, { ok: false, reason: 'not-portable', message: 'Agent a: "pdf" is a relative link.' })
  assert.deepEqual(b.calls, [])

  const c = agent('c', { imports: ['skills'], imported: { ok: false, reason: 'exists', message: 'It is already there.' } })
  const fromTarget = await routeAction(deps, [a.provider, c.provider], copy('skills:/x', 'c'))
  assert.equal(fromTarget.result.ok, false)
})

test('the contract check: projectScopes may list a class the agent imports, even when it does not move it', () => {
  const info: AgentInfo = { id: 'a', name: 'A', detected: true, kinds: ['skills'], supports: {}, projectScopes: { skills: ['project'] }, imports: ['skills'], configHome: '~/.a' }
  assert.deepEqual(projectScopeProblems(info), [])
})
