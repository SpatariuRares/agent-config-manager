import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readInventory } from './inventory.ts'
import { fakeFs, paths } from './test-support.ts'

const settings = {
  enabledPlugins: { 'github@official': true, 'slack@productivity': false },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
    PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'c' }] }]
  }
}

const userConfig = {
  mcpServers: {
    engram: { type: 'stdio', command: 'engram', args: ['mcp'] },
    remote: { type: 'http', url: 'https://example.com/mcp' }
  }
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

const fs = fakeFs({
  '/home/.claude/settings.json': JSON.stringify(settings),
  '/home/.claude.json': JSON.stringify(userConfig),
  '/home/.claude/skills/tdd/SKILL.md': skillMd('tdd', 'Test-driven development.'),
  '/home/.claude/skills/quoted/SKILL.md': skillMd('quoted', '"Has: a colon"'),
  '/home/.claude/skills/_shared/notes.md': 'not a skill',
  '/home/.claude/agents/reviewer.md': skillMd('reviewer', 'Reviews code.'),
  '/home/.claude/agents/notes.txt': 'not an agent'
})

test('lists plugins with their marketplace and enabled state', async () => {
  const { plugins } = await readInventory(fs, paths)
  assert.deepEqual(
    plugins.map(({ id, name, marketplace, enabled }) => ({ id, name, marketplace, enabled })),
    [
      { id: 'github@official', name: 'github', marketplace: 'official', enabled: true },
      { id: 'slack@productivity', name: 'slack', marketplace: 'productivity', enabled: false }
    ]
  )
})

test('lists only skill folders that hold a SKILL.md, with their description', async () => {
  const { skills } = await readInventory(fs, paths)
  assert.deepEqual(skills, [
    { name: 'quoted', description: 'Has: a colon', path: '/home/.claude/skills/quoted/SKILL.md' },
    { name: 'tdd', description: 'Test-driven development.', path: '/home/.claude/skills/tdd/SKILL.md' }
  ])
})

test('lists only markdown agents, with their description', async () => {
  const { agents } = await readInventory(fs, paths)
  assert.deepEqual(agents, [
    { name: 'reviewer', description: 'Reviews code.', path: '/home/.claude/agents/reviewer.md' }
  ])
})

test('lists user MCP servers with their transport', async () => {
  const { mcpServers } = await readInventory(fs, paths)
  assert.deepEqual(mcpServers, [
    { name: 'engram', transport: 'stdio', target: 'engram mcp' },
    { name: 'remote', transport: 'http', target: 'https://example.com/mcp' }
  ])
})

test('flattens hooks into one row per command, keeping event and matcher', async () => {
  const { hooks } = await readInventory(fs, paths)
  assert.deepEqual(hooks, [
    { event: 'PreToolUse', matcher: 'Edit|Write', command: 'c' },
    { event: 'Stop', matcher: '*', command: 'a' },
    { event: 'Stop', matcher: '*', command: 'b' }
  ])
})

test('an empty setup reads as an empty inventory, not an error', async () => {
  const inventory = await readInventory(fakeFs({}), paths)
  assert.deepEqual(inventory, { plugins: [], skills: [], agents: [], mcpServers: [], hooks: [], problems: [], settingsVersion: '', projects: [], versions: { '/home/.claude/settings.json': '' } })
})

test('a broken settings file is reported as a problem, the rest still loads', async () => {
  const inventory = await readInventory(
    fakeFs({
      '/home/.claude/settings.json': '{ not json',
      '/home/.claude/agents/reviewer.md': skillMd('reviewer', 'Reviews code.')
    }),
    paths
  )
  assert.equal(inventory.plugins.length, 0)
  assert.equal(inventory.agents.length, 1)
  assert.equal(inventory.problems.length, 1)
  assert.match(inventory.problems[0], /settings\.json/)
})

test('reads multi-line YAML descriptions (>, >-, |) as one line of text', async () => {
  const folded = '---\nname: folded\ndescription: >-\n  Spans two\n  lines.\ntools: Read\n---\n'
  const literal = '---\nname: literal\ndescription: |\n  First line.\n  Second line.\n---\n'
  const { agents } = await readInventory(
    fakeFs({ '/home/.claude/agents/folded.md': folded, '/home/.claude/agents/literal.md': literal }),
    paths
  )
  assert.deepEqual(
    agents.map((a) => a.description),
    ['Spans two lines.', 'First line. Second line.']
  )
})

test('a malformed MCP entry is skipped instead of breaking the inventory', async () => {
  const { mcpServers } = await readInventory(
    fakeFs({ '/home/.claude.json': JSON.stringify({ mcpServers: { broken: null, ok: { command: 'x' } } }) }),
    paths
  )
  assert.deepEqual(mcpServers, [{ name: 'ok', transport: 'stdio', target: 'x' }])
})
