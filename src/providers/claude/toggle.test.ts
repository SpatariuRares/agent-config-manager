import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readInventory } from './inventory.ts'
import { listBackups as storeBackups } from '../../core/backups.ts'
import { claudeBackups, setPluginEnabled } from './toggle.ts'
import { fakeFs, paths } from './test-support.ts'

const SETTINGS = '/home/.claude/settings.json'
const BACKUPS = '/home/.claude/backups/claude-config-manager'
const original =
  JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': true, 'b@m': false }, hooks: { Stop: [] } }, null, 2) + '\n'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const listBackups = (fs: Parameters<typeof storeBackups>[0], p: typeof paths) => storeBackups(fs, claudeBackups(p))

async function setup() {
  const fs = fakeFs({ [SETTINGS]: original })
  const { settingsVersion } = await readInventory(fs, paths)
  return { fs, settingsVersion }
}

test('turns a plugin off, changing only that value and keeping the file format', async () => {
  const { fs, settingsVersion } = await setup()
  const result = await setPluginEnabled(fs, paths, { id: 'a@m', enabled: false, settingsVersion }, clock)
  assert.equal(result.ok, true)
  assert.equal(
    fs.files[SETTINGS],
    JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': false, 'b@m': false }, hooks: { Stop: [] } }, null, 2) + '\n'
  )
})

test('backs up the previous file before writing', async () => {
  const { fs, settingsVersion } = await setup()
  const result = await setPluginEnabled(fs, paths, { id: 'b@m', enabled: true, settingsVersion }, clock)
  assert.deepEqual(result, { ok: true, backup: `${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json` })
  assert.equal(fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], original)
})

test('refuses when the file changed after the panel read it, and writes nothing', async () => {
  const { fs, settingsVersion } = await setup()
  fs.files[SETTINGS] = original.replace('"opus"', '"sonnet"')
  const before = { ...fs.files }
  const result = await setPluginEnabled(fs, paths, { id: 'a@m', enabled: false, settingsVersion }, clock)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(fs.files, before)
})

test('refuses an unknown plugin id, and writes nothing', async () => {
  const { fs, settingsVersion } = await setup()
  const result = await setPluginEnabled(fs, paths, { id: 'nope@m', enabled: true, settingsVersion }, clock)
  assert.equal(result.ok === false && result.reason, 'unknown-plugin')
  assert.deepEqual(Object.keys(fs.files), [SETTINGS])
})

test('refuses to rewrite a settings file it cannot parse', async () => {
  const fs = fakeFs({ [SETTINGS]: '{ broken' })
  const { settingsVersion } = await readInventory(fs, paths)
  const result = await setPluginEnabled(fs, paths, { id: 'a@m', enabled: true, settingsVersion }, clock)
  assert.equal(result.ok === false && result.reason, 'unreadable')
  assert.equal(fs.files[SETTINGS], '{ broken')
})

test('the settings version changes when the file changes', async () => {
  const { fs, settingsVersion } = await setup()
  fs.files[SETTINGS] = original.replace('"opus"', '"sonnet"')
  assert.notEqual((await readInventory(fs, paths)).settingsVersion, settingsVersion)
})

test('two writes in the same millisecond keep both backups', async () => {
  const { fs, settingsVersion } = await setup()
  await setPluginEnabled(fs, paths, { id: 'a@m', enabled: false, settingsVersion }, clock)
  const { settingsVersion: next } = await readInventory(fs, paths)
  const second = await setPluginEnabled(fs, paths, { id: 'b@m', enabled: true, settingsVersion: next }, clock)
  assert.deepEqual(second, { ok: true, backup: `${BACKUPS}/settings.2026-11-24T10-00-00-000Z-1.json` })
  assert.equal(fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], original)
  assert.equal((await listBackups(fs, paths)).length, 2)
})

test('a toggle to the value the plugin already has writes nothing', async () => {
  const { fs, settingsVersion } = await setup()
  const result = await setPluginEnabled(fs, paths, { id: 'a@m', enabled: true, settingsVersion }, clock)
  assert.deepEqual(result, { ok: true, backup: null })
  assert.deepEqual(Object.keys(fs.files), [SETTINGS])
})
