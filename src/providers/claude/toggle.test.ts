// The global plugin switch (setEnabled on a global plugin), through the provider and the router.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, ActionResult, View } from '../../adapters/view.ts'
import { itemKey } from '../item-index.ts'
import { buildView, machine, runAction, type TestDeps } from './test-support.ts'

const SETTINGS = '/home/.claude/settings.json'
const BACKUPS = '/home/.claude/backups/claude-config-manager'
const original =
  JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': true, 'b@m': false }, hooks: { Stop: [] } }, null, 2) + '\n'
const clock = () => new Date('2026-11-24T10:00:00.000Z')

const setup = (settings = original) => machine({ [SETTINGS]: settings }, {}, clock)

async function view(deps: TestDeps): Promise<View> {
  const answer = await buildView(deps)
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}
const keyOf = (v: View, id: string) => v.items.find((i) => i.kind === 'plugins' && i.plugin?.id === id && i.project === null)!.key
async function toggle(deps: TestDeps, id: string, enabled: boolean, versions?: Record<string, string>): Promise<ActionResult> {
  const v = await view(deps)
  const action: Action = { type: 'setEnabled', key: keyOf(v, id), enabled }
  return (await runAction(deps, { agent: 'claude', action, versions: versions ?? v.versions })).result
}

test('turns a plugin off, changing only that value and keeping the file format', async () => {
  const deps = setup()
  const result = await toggle(deps, 'a@m', false)
  assert.equal(result.ok, true, result.message)
  assert.equal(
    deps.fs.files[SETTINGS],
    JSON.stringify({ model: 'opus', enabledPlugins: { 'a@m': false, 'b@m': false }, hooks: { Stop: [] } }, null, 2) + '\n'
  )
})

test('backs up the previous file before writing, and the undo switches it back', async () => {
  const deps = setup()
  const result = await toggle(deps, 'b@m', true)
  assert.equal(deps.fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], original)
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'setEnabled', key: keyOf(await view(deps), 'b@m'), enabled: false })
  assert.deepEqual((await view(deps)).backups.map((b) => b.name), ['settings.2026-11-24T10-00-00-000Z.json'])
})

test('refuses when the file changed after the panel read it, and writes nothing', async () => {
  const deps = setup()
  const stale = (await view(deps)).versions
  deps.fs.files[SETTINGS] = original.replace('"opus"', '"sonnet"')
  const before = { ...deps.fs.files }
  const result = await toggle(deps, 'a@m', false, stale)
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(deps.fs.files, before)
})

test('refuses a plugin the view does not show, and writes nothing', async () => {
  const deps = setup()
  const versions = (await view(deps)).versions
  const action: Action = { type: 'setEnabled', key: itemKey('plugins', null, 'user', 'nope@m'), enabled: true }
  const result = (await runAction(deps, { agent: 'claude', action, versions })).result
  assert.equal(result.ok === false && result.reason, 'changed')
  assert.deepEqual(Object.keys(deps.fs.files), [SETTINGS])
})

test('a settings file it cannot parse shows as a problem with no switch, and is never rewritten', async () => {
  const deps = setup('{ broken')
  const v = await view(deps)
  assert.equal(v.items.filter((i) => i.kind === 'plugins').length, 0)
  assert.match(v.problems.join('\n'), /settings\.json/)
  const action: Action = { type: 'setEnabled', key: itemKey('plugins', null, 'user', 'a@m'), enabled: true }
  const result = (await runAction(deps, { agent: 'claude', action, versions: v.versions })).result
  assert.equal(result.ok, false)
  assert.equal(deps.fs.files[SETTINGS], '{ broken')
})

test('the settings version changes when the file changes', async () => {
  const deps = setup()
  const before = (await view(deps)).versions[SETTINGS]
  deps.fs.files[SETTINGS] = original.replace('"opus"', '"sonnet"')
  assert.notEqual((await view(deps)).versions[SETTINGS], before)
})

test('two writes in the same millisecond keep both backups', async () => {
  const deps = setup()
  assert.equal((await toggle(deps, 'a@m', false)).ok, true)
  assert.equal((await toggle(deps, 'b@m', true)).ok, true)
  assert.equal(deps.fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], original)
  assert.ok(deps.fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z-1.json`])
  assert.equal((await view(deps)).backups.length, 2)
})

test('a toggle to the value the plugin already has writes nothing and offers no undo', async () => {
  const deps = setup()
  const result = await toggle(deps, 'a@m', true)
  assert.equal(result.ok, true)
  assert.equal((result as { undo?: unknown }).undo, undefined)
  assert.deepEqual(Object.keys(deps.fs.files), [SETTINGS])
})
