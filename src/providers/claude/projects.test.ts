// Projects and per-project plugin values in the Claude Code view, read and written through the provider and the router.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult, View } from '../../adapters/view.ts'
import { buildView, machine, runAction, type TestDeps } from './test-support.ts'

const files = {
  '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
  '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {}, '/work/blog': {}, '/gone': {} } }),
  '/work/shop/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': false, 'b@m': true } }),
  '/work/shop/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'b@m': false } }),
  '/work/shop/package.json': '{}',
  '/work/blog/README.md': '# blog'
}

async function view(deps: TestDeps): Promise<View> {
  const answer = await buildView(deps)
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}
const plugins = (v: View, id: string) =>
  v.items.filter((i) => i.kind === 'plugins' && i.plugin?.id === id).map((i) => ({ project: i.project, scope: i.scope, enabled: i.plugin?.enabled }))

/** Sets a plugin's value in the shop's team file, through the router. */
async function setTeam(deps: TestDeps, id: string, enabled: boolean): Promise<ActionResult> {
  const v = await view(deps)
  const item = v.items.find((i) => i.kind === 'plugins' && i.plugin?.id === id && i.project === '/work/shop' && i.scope === 'project')!
  return (await runAction(deps, { agent: 'claude', action: { type: 'setEnabled', key: item.key, enabled }, versions: v.versions })).result
}

test('lists the projects Claude Code knows that still exist, with their settings file versions', async () => {
  const v = await view(machine(files))
  assert.deepEqual(v.projects, ['/work/blog', '/work/shop'])
  assert.equal(v.versions['/work/blog/.claude/settings.json'], '')
  assert.notEqual(v.versions['/work/shop/.claude/settings.local.json'], '')
})

test('lists where each plugin is overridden per project', async () => {
  const v = await view(machine(files))
  assert.deepEqual(plugins(v, 'b@m'), [
    { project: null, scope: 'user', enabled: false },
    { project: '/work/shop', scope: 'project', enabled: true },
    { project: '/work/shop', scope: 'local', enabled: false }
  ])
  assert.deepEqual(plugins(v, 'a@m'), [
    { project: null, scope: 'user', enabled: true },
    { project: '/work/shop', scope: 'project', enabled: false }
  ])
})

test('the only-me value beats the team value: a team change it hides comes back with a warning', async () => {
  const hidden = await setTeam(machine({ ...files, '/work/shop/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': false, 'b@m': false } }) }), 'b@m', true)
  assert.equal(hidden.ok, true, hidden.message)
  assert.equal(
    hidden.warning,
    'Your only-me file /work/shop/.claude/settings.local.json sets plugin "b" off, and it wins there, so this team change does not apply to you.'
  )
  const applies = await setTeam(machine(files), 'a@m', true)
  assert.equal(applies.ok, true, applies.message)
  assert.equal(applies.warning, undefined)
})

test('a plugin only set in a project still shows up', async () => {
  const v = await view(
    machine({
      '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {} } }),
      '/work/shop/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'solo@m': true } })
    })
  )
  assert.deepEqual(plugins(v, 'solo@m'), [{ project: '/work/shop', scope: 'local', enabled: true }])
})

test('the home folder as a project does not read the user settings twice as an override', async () => {
  const v = await view(
    machine({
      '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true } }),
      '/home/.claude.json': JSON.stringify({ projects: { '/home': {} } }),
      '/home/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'a@m': false } })
    })
  )
  assert.deepEqual(v.projects, ['/home'])
  assert.deepEqual(plugins(v, 'a@m'), [
    { project: null, scope: 'user', enabled: true },
    { project: '/home', scope: 'local', enabled: false }
  ])
})
