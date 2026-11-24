import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readInventory } from './inventory.ts'
import { fakeFs, paths } from './test-support.ts'

const install = (path: string, version: string) => [{ scope: 'user', installPath: path, version }]

const files = {
  '/home/.claude/settings.json': JSON.stringify({
    enabledPlugins: { 'toolkit@official': true, 'lsp@official': false, 'lsp@community': true }
  }),
  '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
    version: 2,
    plugins: {
      'toolkit@official': install('/cache/toolkit', '1.2.0'),
      'lsp@official': install('/cache/lsp-a', '0.1.0'),
      'lsp@community': install('/cache/lsp-b', '0.2.0')
    }
  }),
  '/cache/toolkit/skills/review/SKILL.md': '---\nname: review\n---\n',
  '/cache/toolkit/skills/assets/readme.txt': 'not a skill',
  '/cache/toolkit/agents/checker.md': '---\nname: checker\n---\n',
  '/cache/toolkit/commands/ship.md': '# ship',
  '/cache/toolkit/hooks/hooks.json': JSON.stringify({ hooks: { Stop: [], PreToolUse: [] } }),
  '/cache/toolkit/.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'x' } } }),
  '/cache/lsp-a/.mcp.json': JSON.stringify({ pyright: { command: 'pyright' } })
}

test('reads what each installed plugin contributes', async () => {
  const { plugins } = await readInventory(fakeFs(files), paths)
  const toolkit = plugins.find((p) => p.id === 'toolkit@official')
  assert.deepEqual(toolkit, {
    id: 'toolkit@official',
    name: 'toolkit',
    marketplace: 'official',
    enabled: true,
    version: '1.2.0',
    sharesNameWith: [],
    contributes: {
      skills: ['review'],
      agents: ['checker'],
      commands: ['ship'],
      hooks: ['PreToolUse', 'Stop'],
      mcpServers: ['docs']
    },
    overrides: [],
    installs: [{ scope: 'user', project: null }]
  })
})

test('reads a .mcp.json without the mcpServers wrapper', async () => {
  const { plugins } = await readInventory(fakeFs(files), paths)
  assert.deepEqual(plugins.find((p) => p.id === 'lsp@official')?.contributes.mcpServers, ['pyright'])
})

test('flags plugins with the same name in different marketplaces', async () => {
  const { plugins } = await readInventory(fakeFs(files), paths)
  assert.deepEqual(plugins.find((p) => p.id === 'lsp@official')?.sharesNameWith, ['lsp@community'])
  assert.deepEqual(plugins.find((p) => p.id === 'lsp@community')?.sharesNameWith, ['lsp@official'])
})

test('a plugin enabled in settings but not installed has no version and no contributions', async () => {
  const fs = fakeFs({ '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'ghost@x': true } }) })
  const { plugins } = await readInventory(fs, paths)
  assert.deepEqual(plugins[0], {
    id: 'ghost@x',
    name: 'ghost',
    marketplace: 'x',
    enabled: true,
    version: null,
    sharesNameWith: [],
    contributes: { skills: [], agents: [], commands: [], hooks: [], mcpServers: [] },
    overrides: [],
    installs: []
  })
})

test('reads components declared by custom paths in plugin.json, on top of the default folders', async () => {
  const fs = fakeFs({
    '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'custom@m': true } }),
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
      plugins: { 'custom@m': install('/cache/custom', '1.0.0') }
    }),
    '/cache/custom/.claude-plugin/plugin.json': JSON.stringify({
      skills: ['./skills/group/tdd', './extra-skills/'],
      agents: ['./more/agents/planner.md'],
      commands: './cmds',
      mcpServers: { browser: { command: 'npx' } }
    }),
    '/cache/custom/skills/group/tdd/SKILL.md': '---\nname: tdd\n---\n',
    '/cache/custom/extra-skills/design/SKILL.md': '---\nname: design\n---\n',
    '/cache/custom/agents/reviewer.md': '---\nname: reviewer\n---\n',
    '/cache/custom/more/agents/planner.md': '---\nname: planner\n---\n',
    '/cache/custom/cmds/deploy.md': '# deploy',
    '/cache/custom/.mcp.json': JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'x' } } })
  })
  const { plugins } = await readInventory(fs, paths)
  assert.deepEqual(plugins[0].contributes, {
    skills: ['design', 'tdd'],
    agents: ['planner', 'reviewer'],
    commands: ['deploy'],
    hooks: [],
    mcpServers: ['browser', 'docs']
  })
})

test('a malformed or escaping plugin.json gives empty contributions, not a crash', async () => {
  const fs = fakeFs({
    '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'odd@m': true, 'null@m': true, 'ok@m': true } }),
    '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
      plugins: { 'odd@m': install('/cache/odd', '1'), 'null@m': install('/cache/null', '1'), 'ok@m': install('/cache/ok', '1') }
    }),
    '/cache/odd/.claude-plugin/plugin.json': JSON.stringify({
      skills: [1, null, '../../outside'],
      agents: '/etc',
      mcpServers: ['x'],
      hooks: { hooks: null }
    }),
    '/outside/leaked/SKILL.md': '---\nname: leaked\n---\n',
    '/cache/null/.claude-plugin/plugin.json': 'null',
    '/cache/ok/agents/a.md': '---\nname: a\n---\n'
  })
  const { plugins } = await readInventory(fs, paths)
  const empty = { skills: [], agents: [], commands: [], hooks: [], mcpServers: [] }
  assert.deepEqual(plugins.find((p) => p.id === 'odd@m')?.contributes, empty)
  assert.deepEqual(plugins.find((p) => p.id === 'null@m')?.contributes, empty)
  assert.deepEqual(plugins.find((p) => p.id === 'ok@m')?.contributes.agents, ['a'])
})
