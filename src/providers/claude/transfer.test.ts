// Claude Code as the source and the target of 'copyToAgent': MCP servers and skills.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult, Kind, Scope, Target } from '../../adapters/view.ts'
import type { PortableMcp, PortableSkill, ProviderDeps } from '../types.ts'
import { claudeProvider } from './index.ts'
import { fakeClaude, fakeFs, HOME } from './test-support.ts'

const SHOP = '/work/shop'
const BACKUPS = '/home/.claude/backups/claude-config-manager'
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const userConfig = {
  mcpServers: {
    web: { type: 'http', url: 'https://web.example/mcp', headers: { Authorization: 'Bearer ${WEB_TOKEN}' } },
    authed: { type: 'http', url: 'https://auth.example/mcp', oauth: { clientId: 'x' } }
  },
  projects: { [SHOP]: { mcpServers: { db: { command: 'db-server', args: ['--port', '1'], env: { LOG: 'info' } } } } }
}

function machine(failing: string[] = []) {
  const fs = fakeFs({
    '/home/.claude/settings.json': json({}),
    '/home/.claude.json': JSON.stringify(userConfig),
    '/home/.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Reviews code\n---\n',
    [`${SHOP}/.mcp.json`]: json({ mcpServers: { docs: { command: 'docs-server' } } }),
    '/src/pdf/SKILL.md': '---\nname: pdf\n---\n',
    '/src/pdf/run.sh': 'echo\n'
  })
  const exec = fakeClaude(fs, failing)
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: () => new Date('2026-11-24T10:00:00.000Z') }
  return { fs, exec, deps, provider: claudeProvider() }
}

type Machine = ReturnType<typeof machine>
const importInto = async (m: Machine, item: PortableMcp | PortableSkill, to: Target = { project: null }) =>
  m.provider.importItem!(m.deps, item, to, (await m.provider.buildView(m.deps)).versions)
const refused = (result: ActionResult) => result as ActionResult & { ok: false }
/** The key of the item the view shows now: keys are opaque, so a test reads them from the view. */
async function keyOf(m: Machine, kind: Kind, name: string, project: string | null = null, scope?: Scope): Promise<string> {
  const items = (await m.provider.buildView(m.deps)).items
  const item = items.find((i) => i.kind === kind && i.name === name && i.project === project && (scope === undefined || i.scope === scope))
  assert.ok(item, `${kind} ${name} in ${project ?? 'global'}`)
  return item.key
}

const STDIO: PortableMcp = { kind: 'mcp', name: 'docs', transport: 'stdio', command: 'docs-mcp', args: ['--port', '1'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } }

test('Claude Code declares that it exports and imports skills and MCP servers', async () => {
  const info = await machine().provider.info(machine().deps)
  assert.deepEqual(info.exports, ['skills', 'mcp'])
  assert.deepEqual(info.imports, ['skills', 'mcp'])
})

test('Claude export: an http server with headers, and an only-me stdio server with env', async () => {
  const m = machine()
  assert.deepEqual(await m.provider.exportItem!(m.deps, await keyOf(m, 'mcp', 'web')), {
    ok: true,
    item: { kind: 'mcp', name: 'web', transport: 'http', url: 'https://web.example/mcp', headers: { Authorization: 'Bearer ${WEB_TOKEN}' } }
  })
  assert.deepEqual(await m.provider.exportItem!(m.deps, await keyOf(m, 'mcp', 'db', SHOP, 'local')), {
    ok: true,
    item: { kind: 'mcp', name: 'db', transport: 'stdio', command: 'db-server', args: ['--port', '1'], env: { LOG: 'info' } }
  })
})

test('Claude export refuses a server with settings another agent cannot take, naming them', async () => {
  const m = machine()
  const result = (await m.provider.exportItem!(m.deps, await keyOf(m, 'mcp', 'authed'))) as ActionResult
  assert.equal(refused(result).reason, 'not-portable')
  assert.match(result.message, /\(rest\.oauth\)/)
})

test('Claude export: a skill as its folder', async () => {
  const m = machine()
  assert.deepEqual(await m.provider.exportItem!(m.deps, await keyOf(m, 'skills', 'review')), {
    ok: true,
    item: { kind: 'skills', name: 'review', dir: '/home/.claude/skills/review', link: null }
  })
})

test('Claude import: `claude mcp add-json` globally after a backup, with an undo that removes it', async () => {
  const m = machine()
  const before = m.fs.files['/home/.claude.json']
  const result = await importInto(m, STDIO)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(m.exec.calls, [
    'claude mcp add-json docs {"type":"stdio","command":"docs-mcp","args":["--port","1"],"env":{"DOCS_TOKEN":"${DOCS_TOKEN}"}} --scope user @ -'
  ])
  assert.equal(m.fs.files[`${BACKUPS}/%2Fhome%2F.claude.json.2026-11-24T10-00-00-000Z.json`], before)
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: await keyOf(m, 'mcp', 'docs') })
})

test('Claude import into a project: only me by default (the first declared scope), team in .mcp.json', async () => {
  const m = machine()
  const local = await importInto(m, STDIO, { project: SHOP })
  assert.equal(local.ok, true, local.message)
  assert.deepEqual((local as { undo?: unknown }).undo, { type: 'remove', key: await keyOf(m, 'mcp', 'docs', SHOP, 'local') })
  const team = await importInto(m, { ...STDIO, name: 'tools' }, { project: SHOP, scope: 'project' })
  assert.equal(team.ok, true, team.message)
  assert.deepEqual(m.exec.calls.map((call) => call.replace(/ \{.*\} /, ' {…} ')), [
    'claude mcp add-json docs {…} --scope local @ /work/shop',
    'claude mcp add-json tools {…} --scope project @ /work/shop'
  ])
  assert.deepEqual((team as { undo?: unknown }).undo, { type: 'remove', key: await keyOf(m, 'mcp', 'tools', SHOP, 'project') })
})

test('Claude import refuses secrets: literal values into the team .mcp.json, secret-looking values on the add-json command line', async () => {
  const m = machine()
  const team = await importInto(m, { ...STDIO, env: { LOG: 'info' } }, { project: SHOP, scope: 'project' })
  assert.equal(refused(team).reason, 'secret')
  assert.match(team.message, /literal env or header values/)
  const env = await importInto(m, { ...STDIO, env: { API_KEY: 'sk-live-0123456789abcdef' } })
  assert.equal(refused(env).reason, 'secret')
  const header = await importInto(m, { kind: 'mcp', name: 'h', transport: 'http', url: 'https://h.example/mcp', headers: { Authorization: 'Bearer abc' } })
  assert.equal(refused(header).reason, 'secret')
  const args = await importInto(m, { ...STDIO, env: undefined, args: ['--api-key', 'sk-live-0123456789abcdef'] }, { project: SHOP, scope: 'local' })
  assert.equal(refused(args).reason, 'secret')
  for (const result of [env, header, args]) assert.doesNotMatch(result.message, /sk-live|Bearer abc/)
  assert.deepEqual(m.exec.calls, [])
})

test('Claude import refuses a name already there and an unknown project, and reports a failing CLI', async () => {
  const m = machine()
  assert.equal(refused(await importInto(m, { ...STDIO, name: 'docs' }, { project: SHOP, scope: 'project' })).reason, 'exists')
  assert.equal(refused(await importInto(m, STDIO, { project: '/elsewhere' })).reason, 'unknown-project')
  assert.deepEqual(m.exec.calls, [])
  const failing = machine(['mcp-add:user'])
  assert.equal(refused(await importInto(failing, STDIO)).reason, 'cli-failed')
})

test('Claude import: a skill folder is copied into ~/.claude/skills or <project>/.claude/skills, with an undo that removes it', async () => {
  const m = machine()
  const skill: PortableSkill = { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null }
  const global = await importInto(m, skill)
  assert.equal(global.ok, true, global.message)
  assert.equal(m.fs.files['/home/.claude/skills/pdf/run.sh'], 'echo\n')
  assert.deepEqual((global as { undo?: unknown }).undo, { type: 'remove', key: await keyOf(m, 'skills', 'pdf') })
  const project = await importInto(m, skill, { project: SHOP, scope: 'project' })
  assert.equal(project.ok, true, project.message)
  assert.ok(m.fs.files[`${SHOP}/.claude/skills/pdf/SKILL.md`])
  assert.equal(refused(await importInto(m, skill)).reason, 'exists')
})
