import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readInventory, versionOf as versionOfText } from './inventory.ts'
import { listBackups as storeBackups } from '../../core/backups.ts'
import type { ActionResult } from '../../adapters/view.ts'
import { claudeBackups, setProjectPluginState, updateJsonFile } from './toggle.ts'
import { fakeCli, fakeFs, paths, runAction } from './test-support.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const SHOP_SHARED = '/work/shop/.claude/settings.json'
const SHOP_LOCAL = '/work/shop/.claude/settings.local.json'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const listBackups = (fs: ReturnType<typeof fakeFs>, p: typeof paths) => storeBackups(fs, claudeBackups(p))

/** A restore through the real router, which runs it from Claude Code's declared backups. */
async function restore(fs: ReturnType<typeof fakeFs>, name: string, versions: Record<string, string>, at = clock): Promise<ActionResult> {
  return (await runAction({ fs, cli: fakeCli(), paths, clock: at }, { agent: 'claude', action: { type: 'restore', name }, versions })).result
}
const shared = JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'a@m': false } }, null, 2) + '\n'

function setup(extra: Record<string, string> = {}) {
  return fakeFs({
    '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
    '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {} } }),
    '/work/shop/package.json': '{}',
    [SHOP_SHARED]: shared,
    ...extra
  })
}

async function version(fs: ReturnType<typeof setup>, file: string) {
  return (await readInventory(fs, paths)).versions[file]
}

test('turns a plugin on only for me in one project, creating settings.local.json', async () => {
  const fs = setup()
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'b@m', project: '/work/shop', scope: 'local', enabled: true, version: await version(fs, SHOP_LOCAL) },
    clock
  )
  assert.equal(result.ok, true)
  assert.equal(fs.files[SHOP_LOCAL], JSON.stringify({ enabledPlugins: { 'b@m': true } }, null, 2) + '\n')
})

test('changes the shared project file, keeping its other keys, and backs it up', async () => {
  const fs = setup()
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'a@m', project: '/work/shop', scope: 'project', enabled: true, version: await version(fs, SHOP_SHARED) },
    clock
  )
  const backup = `${BACKUPS}/${encodeURIComponent(SHOP_SHARED)}.2026-11-24T10-00-00-000Z.json`
  assert.deepEqual(result, { ok: true, backup })
  assert.equal(fs.files[backup], shared)
  assert.equal(
    fs.files[SHOP_SHARED],
    JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'a@m': true } }, null, 2) + '\n'
  )
})

test('follow global removes the override', async () => {
  const fs = setup()
  await setProjectPluginState(
    fs,
    paths,
    { id: 'a@m', project: '/work/shop', scope: 'project', enabled: null, version: await version(fs, SHOP_SHARED) },
    clock
  )
  assert.equal(fs.files[SHOP_SHARED], JSON.stringify({ permissions: { allow: [] }, enabledPlugins: {} }, null, 2) + '\n')
})

test('refuses a folder that is not a known project, and writes nothing', async () => {
  const fs = setup({ '/etc/app/x': '1' })
  const before = { ...fs.files }
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'a@m', project: '/etc/app', scope: 'local', enabled: true, version: '' },
    clock
  )
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.deepEqual(fs.files, before)
})

test('refuses a plugin id the setup does not know', async () => {
  const fs = setup()
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'nope@m', project: '/work/shop', scope: 'local', enabled: true, version: await version(fs, SHOP_LOCAL) },
    clock
  )
  assert.equal(result.ok === false && result.reason, 'unknown-plugin')
})

test('refuses when the project file changed after it was read', async () => {
  const fs = setup()
  const stale = await version(fs, SHOP_SHARED)
  fs.files[SHOP_SHARED] = shared.replace('"allow": []', '"allow": ["Bash"]')
  const before = { ...fs.files }
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'a@m', project: '/work/shop', scope: 'project', enabled: true, version: stale },
    clock
  )
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(fs.files, before)
})

test('project backups are listed and restore to their own file', async () => {
  const fs = setup()
  await setProjectPluginState(
    fs,
    paths,
    { id: 'a@m', project: '/work/shop', scope: 'project', enabled: true, version: await version(fs, SHOP_SHARED) },
    clock
  )
  const [name] = await listBackups(fs, paths)
  assert.equal(name, `${encodeURIComponent(SHOP_SHARED)}.2026-11-24T10-00-00-000Z.json`)
  const later = () => new Date('2026-11-24T11:00:00.000Z')
  const result = await restore(fs, name, { [SHOP_SHARED]: await version(fs, SHOP_SHARED) }, later)
  assert.equal(result.ok, true, result.message)
  assert.equal(fs.files[SHOP_SHARED], shared)
})

test("backups of projects with spaces or !*'() in their path can be listed", async () => {
  const project = "/work/my shop (v2)!"
  const fs = fakeFs({
    '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true } }),
    '/home/.claude.json': JSON.stringify({ projects: { [project]: {} } }),
    [`${project}/package.json`]: '{}'
  })
  const file = `${project}/.claude/settings.local.json`
  await setProjectPluginState(fs, paths, { id: 'a@m', project, scope: 'local', enabled: false, version: '' }, clock)
  assert.deepEqual(await listBackups(fs, paths), [`${encodeURIComponent(file)}.2026-11-24T10-00-00-000Z.json`])
})

test('a project key that is the home folder spelled differently cannot write the user settings', async () => {
  for (const alias of ['/home/', '/home/sub/..']) {
    const user = JSON.stringify({ enabledPlugins: { 'a@m': false } })
    const fs = fakeFs({
      '/home/.claude/settings.json': user,
      '/home/.claude.json': JSON.stringify({ projects: { [alias]: {} } }),
      '/home/sub/x': '1'
    })
    const inventory = await readInventory(fs, paths)
    assert.deepEqual(inventory.plugins[0].overrides, [], alias)
    const result = await setProjectPluginState(
      fs,
      paths,
      { id: 'a@m', project: alias, scope: 'project', enabled: true, version: versionOfText(user) },
      clock
    )
    assert.equal(result.ok === false && result.reason, 'unknown-project', alias)
    assert.equal(fs.files['/home/.claude/settings.json'], user, alias)
  }
})

test('restore refuses a backup whose project is no longer known, and creates nothing', async () => {
  const fs = setup()
  await setProjectPluginState(
    fs,
    paths,
    { id: 'b@m', project: '/work/shop', scope: 'local', enabled: true, version: '' },
    clock
  )
  const [name] = await listBackups(fs, paths)
  fs.files['/home/.claude.json'] = JSON.stringify({ projects: {} })
  for (const key of Object.keys(fs.files)) if (key.startsWith('/work/shop/')) delete fs.files[key]
  const result = await restore(fs, name, {})
  assert.equal(result.ok === false && result.reason, 'refused')
  assert.deepEqual(Object.keys(fs.files).filter((key) => key.startsWith('/work/')), [])
})

test('refuses a project file whose enabledPlugins is not an object', async () => {
  for (const bad of ['[]', '"x"']) {
    const fs = setup({ [SHOP_SHARED]: `{"enabledPlugins": ${bad}}` })
    const result = await setProjectPluginState(
      fs,
      paths,
      { id: 'a@m', project: '/work/shop', scope: 'project', enabled: true, version: await version(fs, SHOP_SHARED) },
      clock
    )
    assert.equal(result.ok === false && result.reason, 'unreadable', bad)
    assert.equal(fs.files[SHOP_SHARED], `{"enabledPlugins": ${bad}}`)
  }
})

test('a plugin installed but only set in another project can be turned on here', async () => {
  const fs = setup({
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'c@m': [{ scope: 'user' }] } })
  })
  const result = await setProjectPluginState(
    fs,
    paths,
    { id: 'c@m', project: '/work/shop', scope: 'local', enabled: true, version: '' },
    clock
  )
  assert.equal(result.ok, true)
})

test('a project that only holds dot folders is still listed', async () => {
  const fs = setup({ '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {}, '/work/dots': {} } }), '/work/dots/.git/HEAD': 'x' })
  assert.deepEqual((await readInventory(fs, paths)).projects, ['/work/dots', '/work/shop'])
})

test('restore still puts back an only-me backup, and refuses a .mcp.json of a project no longer known', async () => {
  const fs = setup({ '/work/old/.mcp.json': '{}' })
  await setProjectPluginState(fs, paths, { id: 'b@m', project: '/work/shop', scope: 'local', enabled: true, version: '' }, clock)
  const [name] = await listBackups(fs, paths)
  const later = () => new Date('2026-11-24T11:00:00.000Z')
  const restored = await restore(fs, name, { [SHOP_LOCAL]: await version(fs, SHOP_LOCAL) }, later)
  assert.equal(restored.ok, true, restored.message)
  assert.equal(fs.files[SHOP_LOCAL], '{}\n')

  const stray = `${encodeURIComponent('/work/old/.mcp.json')}.2026-11-24T09-00-00-000Z.json`
  fs.files[`${BACKUPS}/${stray}`] = '{"mcpServers":{}}'
  const refused = await restore(fs, stray, { '/work/old/.mcp.json': versionOfText('{}') }, later)
  assert.equal(refused.ok === false && refused.reason, 'refused')
  assert.equal(fs.files['/work/old/.mcp.json'], '{}')
})

test('updateJsonFile keeps the project-write invariants: known projects only, never the user file by alias', async () => {
  const user = JSON.stringify({ enabledPlugins: {} })
  const fs = fakeFs({
    '/home/.claude/settings.json': user,
    '/home/.claude.json': JSON.stringify({ projects: { '/home/sub/..': {} } }),
    '/home/sub/x': '1'
  })
  const edit = (json: Record<string, any>) => void (json.hooks = {})
  const alias = await updateJsonFile(
    fs,
    paths,
    { project: '/home/sub/..', file: '/home/sub/../.claude/settings.json', version: versionOfText(user), edit },
    clock
  )
  assert.equal(alias.ok === false && alias.reason, 'unknown-project')
  const unknown = await updateJsonFile(fs, paths, { project: '/etc', file: '/etc/.claude/settings.json', version: '', edit }, clock)
  assert.equal(unknown.ok === false && unknown.reason, 'unknown-project')
  assert.equal(fs.files['/home/.claude/settings.json'], user)
  assert.equal(fs.files['/etc/.claude/settings.json'], undefined)
})
