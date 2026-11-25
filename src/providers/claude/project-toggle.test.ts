// Plugin values in project settings files (overrides), their backups and restores, through the provider and the router.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, ActionResult, Item, Target, View } from '../../adapters/view.ts'
import { itemKey } from '../item-index.ts'
import { versionOf } from '../toolkit.ts'
import { buildView, machine, runAction, type TestDeps } from './test-support.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const USER = '/home/.claude/settings.json'
const SHOP = '/work/shop'
const SHOP_SHARED = '/work/shop/.claude/settings.json'
const SHOP_LOCAL = '/work/shop/.claude/settings.local.json'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const later = () => new Date('2026-11-24T11:00:00.000Z')
const shared = JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'a@m': false } }, null, 2) + '\n'

function setup(extra: Record<string, string> = {}): TestDeps {
  return machine(
    {
      [USER]: JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
      '/home/.claude.json': JSON.stringify({ projects: { [SHOP]: {} } }),
      '/work/shop/package.json': '{}',
      [SHOP_SHARED]: shared,
      ...extra
    },
    {},
    clock
  )
}

async function view(deps: TestDeps): Promise<View> {
  const answer = await buildView(deps)
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}
const plugin = (v: View, id: string, project: string | null = null, scope?: string): Item | undefined =>
  v.items.find((i) => i.kind === 'plugins' && i.plugin?.id === id && i.project === project && (scope === undefined || i.scope === scope))
async function run(deps: TestDeps, action: Action, versions?: Record<string, string>): Promise<ActionResult> {
  return (await runAction(deps, { agent: 'claude', action, versions: versions ?? (await view(deps)).versions })).result
}
/** Copies the global value of a plugin into a project (on there): the write that creates a project override. */
async function copyIn(deps: TestDeps, id: string, to: Target): Promise<ActionResult> {
  const item = plugin(await view(deps), id)
  assert.ok(item, id)
  return run(deps, { type: 'move', key: item.key, to, copy: true })
}
const restore = async (deps: TestDeps, name: string) => run({ ...deps, clock: later }, { type: 'restore', name })

test('turns a plugin on only for me in one project, creating settings.local.json', async () => {
  const deps = setup()
  const result = await copyIn(deps, 'b@m', { project: SHOP, scope: 'local' })
  assert.equal(result.ok, true, result.message)
  assert.equal(deps.fs.files[SHOP_LOCAL], JSON.stringify({ enabledPlugins: { 'b@m': true } }, null, 2) + '\n')
})

test('changes the shared project file, keeping its other keys, and backs it up', async () => {
  const deps = setup()
  const override = plugin(await view(deps), 'a@m', SHOP, 'project')!
  const result = await run(deps, { type: 'setEnabled', key: override.key, enabled: true })
  assert.equal(result.ok, true, result.message)
  const backup = `${BACKUPS}/${encodeURIComponent(SHOP_SHARED)}.2026-11-24T10-00-00-000Z.json`
  assert.equal(deps.fs.files[backup], shared)
  assert.equal(deps.fs.files[SHOP_SHARED], JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'a@m': true } }, null, 2) + '\n')
})

test('follow global removes the override', async () => {
  const deps = setup()
  const override = plugin(await view(deps), 'a@m', SHOP, 'project')!
  assert.equal((await run(deps, { type: 'clearOverride', key: override.key })).ok, true)
  assert.equal(deps.fs.files[SHOP_SHARED], JSON.stringify({ permissions: { allow: [] }, enabledPlugins: {} }, null, 2) + '\n')
})

test('refuses a folder that is not a known project, and writes nothing', async () => {
  const deps = setup({ '/etc/app/x': '1' })
  const before = { ...deps.fs.files }
  const result = await copyIn(deps, 'a@m', { project: '/etc/app', scope: 'local' })
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.deepEqual(deps.fs.files, before)
})

test('refuses a plugin override the view does not show, and writes nothing', async () => {
  const deps = setup()
  const before = { ...deps.fs.files }
  const result = await run(deps, { type: 'setEnabled', key: itemKey('plugins', SHOP, 'local', 'nope@m'), enabled: true })
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(deps.fs.files, before)
})

test('refuses when the project file changed after it was read', async () => {
  const deps = setup()
  const v = await view(deps)
  deps.fs.files[SHOP_SHARED] = shared.replace('"allow": []', '"allow": ["Bash"]')
  const before = { ...deps.fs.files }
  const result = await run(deps, { type: 'setEnabled', key: plugin(v, 'a@m', SHOP, 'project')!.key, enabled: true }, v.versions)
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(deps.fs.files, before)
})

test('project backups are listed and restore to their own file', async () => {
  const deps = setup()
  await run(deps, { type: 'setEnabled', key: plugin(await view(deps), 'a@m', SHOP, 'project')!.key, enabled: true })
  const [backup] = (await view(deps)).backups
  assert.equal(backup.name, `${encodeURIComponent(SHOP_SHARED)}.2026-11-24T10-00-00-000Z.json`)
  const result = await restore(deps, backup.name)
  assert.equal(result.ok, true, result.message)
  assert.equal(deps.fs.files[SHOP_SHARED], shared)
})

test("backups of projects with spaces or !*'() in their path can be listed", async () => {
  const project = '/work/my shop (v2)!'
  const deps = machine(
    {
      [USER]: JSON.stringify({ enabledPlugins: { 'a@m': true } }),
      '/home/.claude.json': JSON.stringify({ projects: { [project]: {} } }),
      [`${project}/package.json`]: '{}'
    },
    {},
    clock
  )
  assert.equal((await copyIn(deps, 'a@m', { project, scope: 'local' })).ok, true)
  const file = `${project}/.claude/settings.local.json`
  assert.deepEqual((await view(deps)).backups.map((b) => b.name), [`${encodeURIComponent(file)}.2026-11-24T10-00-00-000Z.json`])
})

test('a project key that is the home folder spelled differently cannot write the user settings, for plugins or hooks', async () => {
  for (const alias of ['/home/', '/home/sub/..']) {
    const user = JSON.stringify({ enabledPlugins: { 'a@m': false }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
    const deps = machine(
      {
        [USER]: user,
        '/home/.claude.json': JSON.stringify({ projects: { [alias]: {}, '/work/blog': {} } }),
        '/home/sub/x': '1',
        // A plugin the user settings do not list, so only the project guard can stop the write.
        '/work/blog/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'c@m': true } }),
        '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'c@m': [{ scope: 'user' }] } })
      },
      {},
      clock
    )
    const v = await view(deps)
    assert.deepEqual(v.items.filter((i) => i.kind === 'plugins' && i.project !== null && i.project !== '/work/blog'), [], alias)
    const blog = plugin(v, 'c@m', '/work/blog')!
    const moved = await run(deps, { type: 'move', key: blog.key, to: { project: alias, scope: 'project' }, copy: true })
    assert.equal(moved.ok === false && moved.reason, 'unknown-project', alias)
    const hook = v.items.find((i) => i.kind === 'hooks')!
    const hookMoved = await run(deps, { type: 'move', key: hook.key, to: { project: alias, scope: 'project' }, copy: true })
    assert.equal(hookMoved.ok === false && hookMoved.reason, 'unknown-project', alias)
    assert.equal(deps.fs.files[USER], user, alias)
  }
})

test('a hook is never written into a folder that is not a known project', async () => {
  const user = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
  const deps = machine({ [USER]: user, '/home/.claude.json': '{}' }, {}, clock)
  const hook = (await view(deps)).items.find((i) => i.kind === 'hooks')!
  const result = await run(deps, { type: 'move', key: hook.key, to: { project: '/etc', scope: 'project' }, copy: true })
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.equal(deps.fs.files['/etc/.claude/settings.json'], undefined)
})

test('restore refuses a backup whose project is no longer known, and creates nothing', async () => {
  const deps = setup()
  await copyIn(deps, 'b@m', { project: SHOP, scope: 'local' })
  const [backup] = (await view(deps)).backups
  deps.fs.files['/home/.claude.json'] = JSON.stringify({ projects: {} })
  for (const key of Object.keys(deps.fs.files)) if (key.startsWith('/work/shop/')) delete deps.fs.files[key]
  const result = await restore(deps, backup.name)
  assert.equal(result.ok === false && result.reason, 'refused')
  assert.deepEqual(Object.keys(deps.fs.files).filter((key) => key.startsWith('/work/')), [])
})

test('refuses a project file whose enabledPlugins is not an object', async () => {
  for (const bad of ['[]', '"x"']) {
    const deps = setup({ [SHOP_SHARED]: `{"enabledPlugins": ${bad}}` })
    const result = await copyIn(deps, 'a@m', { project: SHOP, scope: 'project' })
    assert.equal(result.ok === false && result.reason, 'unreadable', bad)
    assert.equal(deps.fs.files[SHOP_SHARED], `{"enabledPlugins": ${bad}}`)
  }
})

test('a plugin installed but only set in another project can be turned on here', async () => {
  const deps = setup({
    '/home/.claude.json': JSON.stringify({ projects: { [SHOP]: {}, '/work/blog': {} } }),
    '/work/blog/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'c@m': true } }),
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'c@m': [{ scope: 'user' }] } })
  })
  const elsewhere = plugin(await view(deps), 'c@m', '/work/blog')!
  const result = await run(deps, { type: 'move', key: elsewhere.key, to: { project: SHOP, scope: 'local' }, copy: true })
  assert.equal(result.ok, true, result.message)
  assert.equal(JSON.parse(deps.fs.files[SHOP_LOCAL]).enabledPlugins['c@m'], true)
})

test('a project that only holds dot folders is still listed', async () => {
  const deps = setup({ '/home/.claude.json': JSON.stringify({ projects: { [SHOP]: {}, '/work/dots': {} } }), '/work/dots/.git/HEAD': 'x' })
  assert.deepEqual((await view(deps)).projects, ['/work/dots', SHOP])
})

test('restore still puts back an only-me backup, and refuses a .mcp.json of a project no longer known', async () => {
  const deps = setup({ '/work/old/.mcp.json': '{}' })
  await copyIn(deps, 'b@m', { project: SHOP, scope: 'local' })
  const [backup] = (await view(deps)).backups
  const restored = await restore(deps, backup.name)
  assert.equal(restored.ok, true, restored.message)
  assert.equal(deps.fs.files[SHOP_LOCAL], '{}\n')

  const stray = `${encodeURIComponent('/work/old/.mcp.json')}.2026-11-24T09-00-00-000Z.json`
  deps.fs.files[`${BACKUPS}/${stray}`] = '{"mcpServers":{}}'
  const refused = await run({ ...deps, clock: later }, { type: 'restore', name: stray }, { '/work/old/.mcp.json': versionOf('{}') })
  assert.equal(refused.ok === false && refused.reason, 'refused')
  assert.equal(deps.fs.files['/work/old/.mcp.json'], '{}')
})
