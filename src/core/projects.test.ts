import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveState, readInventory } from './inventory.ts'
import { fakeFs, paths } from './test-support.ts'

const files = {
  '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
  '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {}, '/work/blog': {}, '/gone': {} } }),
  '/work/shop/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': false, 'b@m': true } }),
  '/work/shop/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'b@m': false } }),
  '/work/shop/package.json': '{}',
  '/work/blog/README.md': '# blog'
}

test('lists the projects Claude Code knows that still exist, with their settings file versions', async () => {
  const { projects, versions } = await readInventory(fakeFs(files), paths)
  assert.deepEqual(projects, ['/work/blog', '/work/shop'])
  assert.equal(versions['/work/blog/.claude/settings.json'], '')
  assert.notEqual(versions['/work/shop/.claude/settings.local.json'], '')
})

test('lists where each plugin is overridden per project', async () => {
  const { plugins } = await readInventory(fakeFs(files), paths)
  assert.deepEqual(plugins.find((p) => p.id === 'b@m')?.overrides, [
    { project: '/work/shop', scope: 'project', enabled: true },
    { project: '/work/shop', scope: 'local', enabled: false }
  ])
  assert.deepEqual(plugins.find((p) => p.id === 'a@m')?.overrides, [{ project: '/work/shop', scope: 'project', enabled: false }])
})

test('the effective state follows local over project over global', async () => {
  const { plugins } = await readInventory(fakeFs(files), paths)
  const a = plugins.find((p) => p.id === 'a@m')!
  const b = plugins.find((p) => p.id === 'b@m')!
  assert.deepEqual(effectiveState(a, '/work/shop'), { enabled: false, from: 'project' })
  assert.deepEqual(effectiveState(a, '/work/blog'), { enabled: true, from: 'user' })
  assert.deepEqual(effectiveState(b, '/work/shop'), { enabled: false, from: 'local' })
})

test('a plugin only set in a project still shows up', async () => {
  const fs = fakeFs({
    '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {} } }),
    '/work/shop/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'solo@m': true } })
  })
  const { plugins } = await readInventory(fs, paths)
  assert.deepEqual(
    plugins.map(({ id, enabled, overrides }) => ({ id, enabled, overrides })),
    [{ id: 'solo@m', enabled: false, overrides: [{ project: '/work/shop', scope: 'local', enabled: true }] }]
  )
})

test('the home folder as a project does not read the user settings twice as an override', async () => {
  const fs = fakeFs({
    '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true } }),
    '/home/.claude.json': JSON.stringify({ projects: { '/home': {} } }),
    '/home/.claude/settings.local.json': JSON.stringify({ enabledPlugins: { 'a@m': false } })
  })
  const { plugins, projects } = await readInventory(fs, { claudeDir: '/home/.claude', userConfigFile: '/home/.claude.json' })
  assert.deepEqual(projects, ['/home'])
  assert.deepEqual(plugins[0].overrides, [{ project: '/home', scope: 'local', enabled: false }])
})
