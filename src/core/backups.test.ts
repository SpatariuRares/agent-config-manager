import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backUp, backupTarget, listAllBackups, listBackups, restoreFile } from './backups.ts'
import { versionOf } from './json.ts'
import { appBackupDir } from './paths.ts'
import { fakeFs } from './test-support.ts'

const clock = () => new Date('2026-11-24T10:00:00.000Z')
const store = { dir: appBackupDir('/home', 'codex') }

test('a store keeps backups under the neutral app folder, named by the encoded path, newest first', async () => {
  const fs = fakeFs({ '/home/.codex/config.json': '{"a":1}' })
  const first = await backUp(fs, store, '/home/.codex/config.json', '{"a":1}', clock)
  const second = await backUp(fs, store, '/home/.codex/config.json', '{"a":2}', () => new Date('2026-11-24T11:00:00.000Z'))
  assert.equal(first, '/home/.config/claude-config-manager/backups/codex/%2Fhome%2F.codex%2Fconfig.json.2026-11-24T10-00-00-000Z.json')
  assert.deepEqual(await listBackups(fs, store), [second.slice(store.dir.length + 1), first.slice(store.dir.length + 1)])
  assert.equal(backupTarget(store, first.slice(store.dir.length + 1)), '/home/.codex/config.json')
  assert.equal((await listAllBackups(fs, store))[0].target, '/home/.codex/config.json')
})

test('an alias names a well-known file; a name with an alias the store does not have is no backup', async () => {
  const aliased = { dir: '/b', aliases: { settings: '/home/.x/settings.json' } }
  const fs = fakeFs({ '/b/other.2026-11-24T10-00-00-000Z.json': '{}' })
  const path = await backUp(fs, aliased, '/home/.x/settings.json', '{}', clock)
  assert.equal(path, '/b/settings.2026-11-24T10-00-00-000Z.json')
  assert.deepEqual(await listBackups(fs, aliased), ['settings.2026-11-24T10-00-00-000Z.json'])
  assert.equal(backupTarget(aliased, 'other.2026-11-24T10-00-00-000Z.json'), null)
  assert.equal(backupTarget({ dir: '/b' }, 'toString.2026-11-24T10-00-00-000Z.json'), null)
})

test('restoring a file refuses a stale view and what the guard refuses, else backs the current file up first', async () => {
  const fs = fakeFs({ '/home/.codex/a.json': 'old' })
  const name = (await backUp(fs, store, '/home/.codex/a.json', 'old', clock)).slice(store.dir.length + 1)
  fs.files['/home/.codex/a.json'] = 'new'
  const stale = await restoreFile(fs, store, { name, version: versionOf('old') }, clock)
  assert.equal(stale.ok === false && stale.reason, 'changed')
  const guarded = await restoreFile(fs, store, { name, version: versionOf('new') }, clock, async () => ({ ok: false, reason: 'owned', message: 'no' }))
  assert.equal(guarded.ok === false && guarded.reason, 'owned')
  assert.equal(fs.files['/home/.codex/a.json'], 'new')
  const restored = await restoreFile(fs, store, { name, version: versionOf('new') }, () => new Date('2026-11-24T12:00:00.000Z'))
  assert.ok(restored.ok)
  assert.equal(fs.files['/home/.codex/a.json'], 'old')
  assert.equal(fs.files[restored.backup], 'new')
})
