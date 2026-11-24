import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readInventory } from './inventory.ts'
import { listBackups, restoreBackup, setProjectPluginState } from './toggle.ts'
import { fakeFs, paths } from './test-support.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const SHOP_SHARED = '/work/shop/.claude/settings.json'
const SHOP_LOCAL = '/work/shop/.claude/settings.local.json'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
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
  const result = await restoreBackup(fs, paths, { name, settingsVersion: await version(fs, SHOP_SHARED) }, later)
  assert.equal(result.ok, true)
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
