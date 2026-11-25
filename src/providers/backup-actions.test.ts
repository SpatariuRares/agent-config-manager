// restore, snapshot and trash return, run once for every provider from what it declares (a BackupPlan).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backUp, trashEntry } from '../core/backups.ts'
import { versionOf } from '../core/json.ts'
import { fakeExec, fakeFs } from '../core/test-support.ts'
import type { ActionResult } from '../adapters/view.ts'
import { runBackupAction, type BackupPlan } from './backup-actions.ts'
import type { ProviderDeps } from './types.ts'

const STORE = { dir: '/home/.backups' }
const SETTINGS = '/home/.agent/settings.json'
const OWNED = '/home/.agent.json'
const SKILLS = '/home/.agent/skills'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const later = () => new Date('2026-11-24T11:00:00.000Z')

const plan = (extra: Partial<BackupPlan> = {}): BackupPlan => ({
  owner: 'Agent',
  store: STORE,
  files: [SETTINGS, '/work/shop/.agent/settings.json'],
  owned: [{ file: OWNED, reason: 'agent-owned', why: 'Agent rewrites all the time, so this app never writes it' }],
  entryFolders: [SKILLS],
  say: (path) => path.replace('/home/', '~/'),
  ...extra
})

function machine(files: Record<string, string> = {}) {
  const fs = fakeFs({ [SETTINGS]: '// mine\n{"a":1}', [OWNED]: '{"o":1}', [`${SKILLS}/review/SKILL.md`]: 'review', ...files })
  const deps: ProviderDeps = { fs, exec: fakeExec(), home: '/home', clock }
  return { fs, deps }
}

const name = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const failed = (result: ActionResult) => {
  assert.equal(result.ok, false, result.message)
  return result as ActionResult & { ok: false }
}

test('snapshot backs up every declared file that exists, owned ones too', async () => {
  const { fs, deps } = machine()
  const result = await runBackupAction(deps, plan(), { type: 'snapshot' }, {})
  assert.deepEqual(result, { ok: true, message: 'Backed up 2 settings files to ~/.backups.' })
  assert.deepEqual(
    Object.keys(fs.files).filter((path) => path.startsWith(STORE.dir)).map((path) => fs.files[path]),
    ['// mine\n{"a":1}', '{"o":1}']
  )
})

test('snapshot with nothing to back up is refused as missing', async () => {
  const deps: ProviderDeps = { fs: fakeFs({}), exec: fakeExec(), home: '/home', clock }
  const result = failed(await runBackupAction(deps, plan(), { type: 'snapshot' }, {}))
  assert.equal(result.reason, 'missing')
})

test('a file backup restores as is, after a backup of the current file, with an undo and the note', async () => {
  const { fs, deps } = machine()
  const backup = name(await backUp(fs, STORE, SETTINGS, '// old\n{"a":0}', clock))
  const versions = { [SETTINGS]: versionOf(fs.files[SETTINGS]) }
  const result = await runBackupAction({ ...deps, clock: later }, plan({ note: 'Restart it.' }), { type: 'restore', name: backup }, versions)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.message, 'Restored ~/.agent/settings.json from its backup. Restart it.')
  assert.equal(fs.files[SETTINGS], '// old\n{"a":0}')
  assert.deepEqual(result.ok && result.undo, { type: 'restore', name: `${encodeURIComponent(SETTINGS)}.2026-11-24T11-00-00-000Z.json` })
  assert.equal(fs.files[`${STORE.dir}/${encodeURIComponent(SETTINGS)}.2026-11-24T11-00-00-000Z.json`], '// mine\n{"a":1}')
})

test('a restore refuses a file changed since the view, and writes nothing', async () => {
  const { fs, deps } = machine()
  const backup = name(await backUp(fs, STORE, SETTINGS, 'old', clock))
  const before = structuredClone(fs.files)
  const result = failed(await runBackupAction(deps, plan(), { type: 'restore', name: backup }, { [SETTINGS]: versionOf('then') }))
  assert.equal(result.reason, 'changed')
  assert.deepEqual(fs.files, before)
})

test('an owned file is backed up but never restored: the answer says how to put it back by hand', async () => {
  const { fs, deps } = machine()
  const backup = name(await backUp(fs, STORE, OWNED, 'old', clock))
  const result = failed(await runBackupAction(deps, plan(), { type: 'restore', name: backup }, { [OWNED]: versionOf('{"o":1}') }))
  assert.equal(result.reason, 'agent-owned')
  assert.equal(
    result.message,
    `${backup} is a copy of ~/.agent.json, which Agent rewrites all the time, so this app never writes it. To put it back by hand: cp "${STORE.dir}/${backup}" "${OWNED}"`
  )
  assert.equal(fs.files[OWNED], '{"o":1}')
})

test('a backup of a file the plan does not list (an unknown project, anything else) is refused', async () => {
  const { fs, deps } = machine({ '/work/gone/.agent/settings.json': 'now' })
  for (const target of ['/work/gone/.agent/settings.json', '/etc/passwd']) {
    const backup = name(await backUp(fs, STORE, target, 'evil', clock))
    const result = failed(await runBackupAction(deps, plan(), { type: 'restore', name: backup }, {}))
    assert.equal(result.reason, 'refused', target)
    assert.equal(result.message, `${target} is not a file this app writes for Agent.`)
  }
  assert.equal(fs.files['/work/gone/.agent/settings.json'], 'now')
  assert.equal(fs.files['/etc/passwd'], undefined)
})

test('a name that is not a backup of the store is unknown', async () => {
  const { deps } = machine()
  for (const bad of ['../settings.json', 'settings.2026-11-24T10-00-00-000Z.json', `${encodeURIComponent(SETTINGS)}.2026-11-24T10-00-00-000Z.json`]) {
    assert.equal(failed(await runBackupAction(deps, plan(), { type: 'restore', name: bad }, {})).reason, 'unknown-backup', bad)
  }
})

test('a trashed skill goes back to a declared folder, with the undo the plan gives', async () => {
  const { fs, deps } = machine()
  const trashed = await trashEntry(fs, STORE, `${SKILLS}/review`, clock)
  assert.ok(trashed.ok)
  const result = await runBackupAction(deps, plan({ entryKey: (target) => `skills:${target}` }), { type: 'restore', name: trashed.name }, {})
  assert.deepEqual(result, { ok: true, message: 'Put back ~/.agent/skills/review.', undo: { type: 'remove', key: `skills:${SKILLS}/review` } })
  assert.equal(fs.files[`${SKILLS}/review/SKILL.md`], 'review')
})

test('a trashed entry goes back only to a declared folder, and never over something there now', async () => {
  const { fs, deps } = machine()
  const trashed = await trashEntry(fs, STORE, `${SKILLS}/review`, clock)
  assert.ok(trashed.ok)
  assert.equal(failed(await runBackupAction(deps, plan({ entryFolders: [] }), { type: 'restore', name: trashed.name }, {})).reason, 'unknown-backup')
  assert.equal(failed(await runBackupAction(deps, plan({ entryFolders: ['/elsewhere'] }), { type: 'restore', name: trashed.name }, {})).reason, 'unknown-project')
  fs.files[`${SKILLS}/review/SKILL.md`] = 'new one'
  assert.equal(failed(await runBackupAction(deps, plan(), { type: 'restore', name: trashed.name }, {})).reason, 'exists')
  assert.equal(fs.files[`${SKILLS}/review/SKILL.md`], 'new one')
})

test('a restore the agent runs its own way (a declared hook) answers instead, with the approval it was sent', async () => {
  const { fs, deps } = machine()
  const record = '/home/.agent/ext/x/record.json'
  const backup = name(await backUp(fs, STORE, record, '{}', clock))
  const seen: unknown[] = []
  const own: BackupPlan['restoreOwn'] = (restore) => {
    if (restore.target !== record) return null
    seen.push(restore)
    return Promise.resolve({ ok: true, message: 'Reinstalled x.' })
  }
  const result = await runBackupAction(deps, plan({ restoreOwn: own }), { type: 'restore', name: backup, acceptCommand: 'abc' }, { a: '1' })
  assert.deepEqual(result, { ok: true, message: 'Reinstalled x.' })
  assert.deepEqual(seen, [{ name: backup, target: record, text: '{}', acceptCommand: 'abc', versions: { a: '1' } }])
})
