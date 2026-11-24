// Claude Code against the contract every provider must pass, plus its own info.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeFs } from '../../core/test-support.ts'
import { fakeExec, providerContract } from '../testing.ts'
import { claudeProvider, CLAUDE_SUPPORTS } from './index.ts'

const USER = '/home/.claude/settings.json'
const files = {
  [USER]: JSON.stringify({ enabledPlugins: { 'a@m': true } }, null, 2) + '\n',
  '/home/.claude.json': JSON.stringify({ projects: { '/work/shop': {} } }),
  '/home/.claude/skills/review/SKILL.md': '---\nname: review\n---\n',
  '/work/shop/README.md': 'shop'
}

providerContract(claudeProvider(), {
  home: '/home',
  files,
  write: {
    action: (view) => ({ type: 'setEnabled', key: view.items.find((item) => item.kind === 'plugins')!.key, enabled: false }),
    file: USER
  }
})

test('Claude Code info: id, name, config home, all five classes and what works today', async () => {
  const info = await claudeProvider().info({ fs: fakeFs(files), exec: fakeExec(), home: '/home' })
  assert.deepEqual(info, {
    id: 'claude',
    name: 'Claude Code',
    detected: true,
    kinds: ['plugins', 'skills', 'agents', 'mcp', 'hooks'],
    supports: CLAUDE_SUPPORTS,
    configHome: '~/.claude'
  })
})

test('Claude Code is detected from its binary on PATH alone, or from ~/.claude.json alone', async () => {
  const onPath = await claudeProvider().info({ fs: fakeFs({}), exec: fakeExec({ commands: { claude: '/usr/bin/claude' } }), home: '/home' })
  assert.equal(onPath.detected, true)
  const config = await claudeProvider().info({ fs: fakeFs({ '/home/.claude.json': '{}' }), exec: fakeExec(), home: '/home' })
  assert.equal(config.detected, true)
})

test('Claude Code runs its CLI through the shared command runner, by argv', async () => {
  const exec = fakeExec({ commands: { claude: '/usr/bin/claude' } })
  const fs = fakeFs({ ...files, '/home/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'a@m': [{ scope: 'user' }] } }) })
  const provider = claudeProvider()
  const deps = { fs, exec, home: '/home', clock: () => new Date('2026-11-24T10:00:00.000Z') }
  const view = await provider.buildView(deps)
  const key = view.items.find((item) => item.kind === 'plugins')!.key
  const result = await provider.runAction(deps, { agent: 'claude', action: { type: 'uninstall', key }, versions: view.versions })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(exec.calls, ['claude plugin uninstall a@m --scope user --keep-data --json @ -'])
})
