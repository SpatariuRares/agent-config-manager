// Uninstalling a plugin through `claude plugin uninstall`, through the provider and the router.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult, View } from '../../adapters/view.ts'
import { buildView, fakeClaude, machine, runAction, type TestDeps } from './test-support.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const userSettings = JSON.stringify({ enabledPlugins: { 'a@m': true, 'ghost@m': true } })
const shopSettings = JSON.stringify({ enabledPlugins: { 'a@m': true } })
const installed = (records: unknown[]) => JSON.stringify({ plugins: { 'a@m': records } })
const BOTH = [
  { scope: 'user', installPath: '/cache/a' },
  { scope: 'project', projectPath: '/work/shop', installPath: '/cache/a' }
]

function setup(records: unknown[] = BOTH, failing: string[] = []): TestDeps {
  const deps = machine(
    {
      '/home/.claude/settings.json': userSettings,
      '/work/shop/.claude/settings.json': shopSettings,
      '/home/.claude/plugins/installed_plugins.json': installed(records)
    },
    {},
    clock
  )
  deps.exec = fakeClaude(deps.fs, failing)
  return deps
}

async function uninstall(deps: TestDeps, id: string): Promise<ActionResult> {
  const answer = await buildView(deps)
  const view = (answer as { ok: true; view: View }).view
  const item = view.items.find((i) => i.kind === 'plugins' && i.plugin?.id === id && i.project === null)
  assert.ok(item, id)
  return (await runAction(deps, { agent: 'claude', action: { type: 'uninstall', key: item.key }, versions: view.versions })).result
}

test('uninstalls every install record through the CLI, keeping data, after backing up settings', async () => {
  const deps = setup()
  const result = await uninstall(deps, 'a@m')
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(deps.exec.calls, [
    'claude plugin uninstall a@m --scope user --keep-data --json @ -',
    'claude plugin uninstall a@m --scope project --keep-data --json @ /work/shop'
  ])
  assert.equal(deps.fs.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], userSettings)
  assert.equal(deps.fs.files[`${BACKUPS}/${encodeURIComponent('/work/shop/.claude/settings.json')}.2026-11-24T10-00-00-000Z.json`], shopSettings)
})

test('refuses a plugin that is not installed and runs nothing', async () => {
  const deps = setup()
  const result = await uninstall(deps, 'ghost@m')
  assert.equal(result.ok === false && result.reason, 'unknown-plugin')
  assert.deepEqual(deps.exec.calls, [])
})

test('reports which installs the CLI could not remove', async () => {
  const deps = setup(BOTH, ['project'])
  const result = await uninstall(deps, 'a@m')
  assert.equal(result.ok === false && result.reason, 'cli-failed')
  assert.match(result.message, /project \(\/work\/shop\): cannot uninstall from project/)
  assert.equal(deps.exec.calls.length, 2)
})

test('a project install record without its folder is reported, not run in the home folder', async () => {
  const deps = setup([{ scope: 'project' }])
  const result = await uninstall(deps, 'a@m')
  assert.equal(result.ok === false && result.reason, 'cli-failed')
  assert.match(result.message, /project: no project folder recorded/)
  assert.deepEqual(deps.exec.calls, [])
})
