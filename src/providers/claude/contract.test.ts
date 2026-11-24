// Claude Code against the contract every provider must pass, plus its own info.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeFs } from '../../core/test-support.ts'
import { fakeExec, providerContract } from '../testing.ts'
import { claudeProvider, CLAUDE_PROJECT_SCOPES, CLAUDE_SUPPORTS } from './index.ts'

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
    projectScopes: CLAUDE_PROJECT_SCOPES,
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

test('B2: MCP args and URLs are shown without their secrets', async () => {
  const userConfig = {
    projects: { '/work/shop': {} },
    mcpServers: {
      probe: { type: 'stdio', command: 'npx', args: ['srv', '--api-key', 'sk-live-SECRET1234567890'] },
      'probe-url': { type: 'http', url: 'https://x.io/mcp?token=abc123tok' }
    }
  }
  const fs = fakeFs({ ...files, '/home/.claude.json': JSON.stringify(userConfig) })
  const view = await claudeProvider().buildView({ fs, exec: fakeExec(), home: '/home' })
  assert.doesNotMatch(JSON.stringify(view.items), /sk-live|abc123tok/)
  assert.equal(view.items.find((item) => item.name === 'probe')?.mcp?.target, 'npx srv --api-key <redacted>')
  assert.equal(view.items.find((item) => item.name === 'probe-url')?.mcp?.target, 'https://x.io/mcp?token=<redacted>')
})

test('B2: hook commands are shown without their secrets, in the item and in its key', async () => {
  const settings = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: "curl -H 'Authorization: Bearer hunter2' https://x.io" }] }] }
  }
  const fs = fakeFs({ ...files, '/home/.claude/settings.json': JSON.stringify(settings) })
  const view = await claudeProvider().buildView({ fs, exec: fakeExec(), home: '/home' })
  const hook = view.items.find((item) => item.kind === 'hooks')
  assert.ok(hook)
  assert.doesNotMatch(JSON.stringify(view.items), /hunter2/)
  assert.doesNotMatch(hook.name, /hunter2/)
})
