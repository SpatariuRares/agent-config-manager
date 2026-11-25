// What the Claude Code view shows of a global setup, read through the provider and the router.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item, Kind, View } from '../../adapters/view.ts'
import { buildView, machine } from './test-support.ts'

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

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

const files = {
  '/home/.claude/settings.json': JSON.stringify(settings),
  '/home/.claude.json': JSON.stringify(userConfig),
  '/home/.claude/skills/tdd/SKILL.md': skillMd('tdd', 'Test-driven development.'),
  '/home/.claude/skills/quoted/SKILL.md': skillMd('quoted', '"Has: a colon"'),
  '/home/.claude/skills/_shared/notes.md': 'not a skill',
  '/home/.claude/agents/reviewer.md': skillMd('reviewer', 'Reviews code.'),
  '/home/.claude/agents/notes.txt': 'not an agent'
}

async function view(files: Record<string, string>): Promise<View> {
  const answer = await buildView(machine(files))
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}
const of = (v: View, kind: Kind) => v.items.filter((item: Item) => item.kind === kind)

test('lists plugins with their marketplace and enabled state', async () => {
  assert.deepEqual(
    of(await view(files), 'plugins').map((i) => ({ id: i.plugin?.id, name: i.name, description: i.description, enabled: i.plugin?.enabled })),
    [
      { id: 'github@official', name: 'github', description: 'from official', enabled: true },
      { id: 'slack@productivity', name: 'slack', description: 'from productivity', enabled: false }
    ]
  )
})

test('lists only skill folders that hold a SKILL.md, with their description', async () => {
  assert.deepEqual(
    of(await view(files), 'skills').map(({ name, description, source }) => ({ name, description, source })),
    [
      { name: 'quoted', description: 'Has: a colon', source: '/home/.claude/skills/quoted' },
      { name: 'tdd', description: 'Test-driven development.', source: '/home/.claude/skills/tdd' }
    ]
  )
})

test('lists only markdown agents, with their description', async () => {
  assert.deepEqual(
    of(await view(files), 'agents').map(({ name, description, source }) => ({ name, description, source })),
    [{ name: 'reviewer', description: 'Reviews code.', source: '/home/.claude/agents/reviewer.md' }]
  )
})

test('lists user MCP servers with their transport', async () => {
  assert.deepEqual(
    of(await view(files), 'mcp').map(({ name, mcp }) => ({ name, ...mcp })),
    [
      { name: 'engram', transport: 'stdio', target: 'engram mcp' },
      { name: 'remote', transport: 'http', target: 'https://example.com/mcp' }
    ]
  )
})

test('flattens hooks into one row per command, keeping event and matcher', async () => {
  assert.deepEqual(
    of(await view(files), 'hooks')
      .map((i) => i.hook)
      .sort((a, b) => `${a?.event}${a?.command}`.localeCompare(`${b?.event}${b?.command}`)),
    [
      { event: 'PreToolUse', matcher: 'Edit|Write', command: 'c' },
      { event: 'Stop', matcher: '*', command: 'a' },
      { event: 'Stop', matcher: '*', command: 'b' }
    ]
  )
})

test('an empty setup reads as an empty view, not an error', async () => {
  const v = await view({})
  assert.deepEqual({ items: v.items, projects: v.projects, problems: v.problems, backups: v.backups }, { items: [], projects: [], problems: [], backups: [] })
  assert.equal(v.versions['/home/.claude/settings.json'], '')
})

test('a broken settings file is reported as a problem, the rest still loads', async () => {
  const v = await view({ '/home/.claude/settings.json': '{ not json', '/home/.claude/agents/reviewer.md': skillMd('reviewer', 'Reviews code.') })
  assert.equal(of(v, 'plugins').length, 0)
  assert.equal(of(v, 'agents').length, 1)
  assert.equal(v.problems.length, 1)
  assert.match(v.problems[0], /settings\.json/)
})

test('reads multi-line YAML descriptions (>, >-, |) as one line of text', async () => {
  const folded = '---\nname: folded\ndescription: >-\n  Spans two\n  lines.\ntools: Read\n---\n'
  const literal = '---\nname: literal\ndescription: |\n  First line.\n  Second line.\n---\n'
  const v = await view({ '/home/.claude/agents/folded.md': folded, '/home/.claude/agents/literal.md': literal })
  assert.deepEqual(
    of(v, 'agents').map((a) => a.description),
    ['Spans two lines.', 'First line. Second line.']
  )
})

test('a malformed MCP entry is skipped instead of breaking the view', async () => {
  const v = await view({ '/home/.claude.json': JSON.stringify({ mcpServers: { broken: null, ok: { command: 'x' } } }) })
  assert.deepEqual(of(v, 'mcp').map(({ name, mcp }) => ({ name, ...mcp })), [{ name: 'ok', transport: 'stdio', target: 'x' }])
})
