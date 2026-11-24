import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uninstallPlugin } from './uninstall.ts'
import { fakeCli, fakeFs, paths } from './test-support.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const clock = () => new Date('2026-11-24T10:00:00.000Z')
const userSettings = JSON.stringify({ enabledPlugins: { 'a@m': true } })
const shopSettings = JSON.stringify({ enabledPlugins: { 'a@m': true } })

const fs = () =>
  fakeFs({
    '/home/.claude/settings.json': userSettings,
    '/work/shop/.claude/settings.json': shopSettings,
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
      plugins: {
        'a@m': [
          { scope: 'user', installPath: '/cache/a' },
          { scope: 'project', projectPath: '/work/shop', installPath: '/cache/a' }
        ]
      }
    })
  })

test('uninstalls every install record through the CLI, keeping data, after backing up settings', async () => {
  const files = fs()
  const cli = fakeCli()
  const result = await uninstallPlugin(files, cli, paths, 'a@m', clock)
  assert.deepEqual(cli.calls, ['a@m user -', 'a@m project /work/shop'])
  assert.deepEqual(result, {
    ok: true,
    backups: [
      `${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`,
      `${BACKUPS}/${encodeURIComponent('/work/shop/.claude/settings.json')}.2026-11-24T10-00-00-000Z.json`
    ]
  })
  assert.equal(files.files[`${BACKUPS}/settings.2026-11-24T10-00-00-000Z.json`], userSettings)
})

test('refuses a plugin that is not installed and runs nothing', async () => {
  const cli = fakeCli()
  const result = await uninstallPlugin(fs(), cli, paths, 'ghost@m', clock)
  assert.equal(result.ok === false && result.reason, 'unknown-plugin')
  assert.deepEqual(cli.calls, [])
})

test('reports which installs the CLI could not remove', async () => {
  const cli = fakeCli(['project'])
  const result = await uninstallPlugin(fs(), cli, paths, 'a@m', clock)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'cli-failed')
  assert.match(result.ok === false ? result.message : '', /project \(\/work\/shop\): cannot uninstall from project/)
  assert.deepEqual(cli.calls, ['a@m user -', 'a@m project /work/shop'])
})
