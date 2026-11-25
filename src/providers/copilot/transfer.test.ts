// Copilot CLI as the source and the target of 'copyToAgent': MCP servers and skills.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult } from '../../adapters/view.ts'
import { itemKey, type PortableMcp, type PortableSkill, type ProviderDeps } from '../toolkit.ts'
import { fakeExec, fakeFs } from '../testing.ts'
import { copilotProvider } from './index.ts'

const HOME = '/home/me'
const DIR = `${HOME}/.copilot`
const MCP = `${DIR}/mcp-config.json`
const SHOP = '/work/shop'
const SHOP_MCP = `${SHOP}/.github/mcp.json`
const STORE = `${HOME}/.config/agent-config-manager/backups/copilot`
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

const FILES: Record<string, string> = {
  [`${DIR}/config.json`]: `// managed\n${json({ trustedFolders: [SHOP] })}`,
  [MCP]: json({
    mcpServers: {
      context7: { type: 'local', command: 'npx', args: ['-y', 'context7-mcp'], env: { LOG: 'info' }, tools: ['*'] },
      vercel: { type: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' }, tools: ['*'] },
      picky: { command: 'picky', tools: ['read'] },
      odd: { command: 'odd', cwd: '/tmp' }
    }
  }),
  [`${DIR}/skills/review/SKILL.md`]: '---\nname: review\ndescription: Reviews a diff.\n---\n',
  [`${HOME}/.agents/skills/shared/SKILL.md`]: '---\nname: shared\n---\n',
  [`${SHOP}/README.md`]: 'shop',
  [`${SHOP}/.mcp.json`]: json({ mcpServers: { team: { command: 'team-mcp' } } }),
  ['/src/pdf/SKILL.md']: '---\nname: pdf\n---\n',
  ['/src/pdf/scripts/run.sh']: 'echo run\n'
}

const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')
function machine(overrides: Record<string, string> = {}, links: Record<string, string> = {}) {
  const fs = fakeFs({ ...structuredClone(FILES), ...overrides }, links)
  const exec = fakeExec()
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: CLOCK }
  return { fs, exec, deps }
}
const provider = copilotProvider()
const versionsOf = async (deps: ProviderDeps) => (await provider.buildView(deps)).versions
const importInto = async (deps: ProviderDeps, item: PortableMcp | PortableSkill, project: string | null = null, versions?: Record<string, string>) =>
  provider.importItem!(deps, item, project === null ? { project: null } : { project, scope: 'project' }, versions ?? (await versionsOf(deps)))
const refused = (result: ActionResult) => result as ActionResult & { ok: false }

const SERVER: PortableMcp = { kind: 'mcp', name: 'docs', transport: 'stdio', command: 'docs-mcp', args: ['--port', '1'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } }

test('Copilot CLI declares that it exports and imports skills and MCP servers', async () => {
  const info = await provider.info(machine().deps)
  assert.deepEqual(info.exports, ['skills', 'mcp'])
  assert.deepEqual(info.imports, ['skills', 'mcp'])
})

test('Copilot export: an MCP server as a Portable; local means stdio, and tools ["*"] is every tool, as elsewhere', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', MCP, 'context7')), {
    ok: true,
    item: { kind: 'mcp', name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'context7-mcp'], env: { LOG: 'info' } }
  })
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', MCP, 'vercel')), {
    ok: true,
    item: { kind: 'mcp', name: 'vercel', transport: 'http', url: 'https://mcp.vercel.com', headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' } }
  })
  // Read-only shared places can still be copied from: an export only reads.
  const team = await provider.exportItem!(deps, itemKey('mcp', `${SHOP}/.mcp.json`, 'team'))
  assert.equal(team.ok, true)
})

test('Copilot export refuses a server with settings another agent cannot take, naming them', async () => {
  const { deps } = machine()
  for (const [name, field] of [['picky', 'tools'], ['odd', 'cwd']]) {
    const result = await provider.exportItem!(deps, itemKey('mcp', MCP, name))
    assert.equal(result.ok, false, name)
    assert.equal(refused(result as ActionResult).reason, 'not-portable')
    assert.match((result as ActionResult).message, new RegExp(`\\(rest\\.${field}\\)`))
  }
  assert.equal(refused((await provider.exportItem!(deps, itemKey('mcp', MCP, 'gone'))) as ActionResult).reason, 'changed')
})

test('Copilot export: a skill as its folder, also from a shared place', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('skills', `${DIR}/skills/review`)), {
    ok: true,
    item: { kind: 'skills', name: 'review', dir: `${DIR}/skills/review`, link: null }
  })
  const shared = await provider.exportItem!(deps, itemKey('skills', `${HOME}/.agents/skills/shared`))
  assert.equal(shared.ok, true)
})

test('Copilot import: an MCP server goes into mcp-config.json after a backup, with an undo that removes it', async () => {
  const { deps, fs } = machine()
  const before = fs.files[MCP]
  const result = await importInto(deps, SERVER)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(JSON.parse(fs.files[MCP]).mcpServers.docs, {
    type: 'local',
    command: 'docs-mcp',
    args: ['--port', '1'],
    env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
    tools: ['*']
  })
  assert.ok(Object.keys(fs.files).some((path) => path.startsWith(`${STORE}/`) && fs.files[path] === before), 'a backup of the previous file')
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('mcp', MCP, 'docs') })
  assert.match(result.message, /MCP server "docs"/)
})

test('Copilot import: a global server may keep literal env values; its own user file is not shared and no command line sees it', async () => {
  const { deps, fs } = machine()
  const result = await importInto(deps, { ...SERVER, env: { DOCS_TOKEN: 'sk-live-0123456789abcdef' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(JSON.parse(fs.files[MCP]).mcpServers.docs.env.DOCS_TOKEN, 'sk-live-0123456789abcdef')
})

test('Copilot import into a project: team file .github/mcp.json, refusing literal env or header values and secret args or urls', async () => {
  const { deps, fs } = machine()
  const before = structuredClone(fs.files)
  const literal = await importInto(deps, { ...SERVER, env: { DOCS_TOKEN: 'plain' } }, SHOP)
  assert.equal(refused(literal).reason, 'secret')
  assert.match(literal.message, /literal env or header values \(env\.DOCS_TOKEN\)/)
  const header = await importInto(deps, { kind: 'mcp', name: 'h', transport: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer abc' } }, SHOP)
  assert.equal(refused(header).reason, 'secret')
  const args = await importInto(deps, { ...SERVER, args: ['--api-key', 'sk-live-0123456789abcdef'] }, SHOP)
  assert.equal(refused(args).reason, 'secret')
  assert.doesNotMatch(args.message, /sk-live/)
  assert.deepEqual(fs.files, before, 'a refused import writes nothing')

  const result = await importInto(deps, SERVER, SHOP)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(JSON.parse(fs.files[SHOP_MCP]).mcpServers.docs.env, { DOCS_TOKEN: '${DOCS_TOKEN}' })
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('mcp', SHOP_MCP, 'docs') })
})

test('Copilot import refuses a name already there, an unknown project and a stale view, writing nothing', async () => {
  const { deps, fs } = machine()
  const before = structuredClone(fs.files)
  assert.equal(refused(await importInto(deps, { ...SERVER, name: 'context7' })).reason, 'refused')
  assert.equal(refused(await importInto(deps, SERVER, '/elsewhere')).reason, 'unknown-project')
  assert.equal(refused(await importInto(deps, SERVER, null, { [MCP]: 'stale' })).reason, 'changed')
  assert.deepEqual(fs.files, before)
})

test('Copilot import: a skill folder is copied into ~/.copilot/skills, a link kept as a link, with an undo that removes it', async () => {
  const { deps, fs } = machine({}, { '/src/linked': '/src/pdf' })
  const result = await importInto(deps, { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null })
  assert.equal(result.ok, true, result.message)
  assert.equal(fs.files[`${DIR}/skills/pdf/scripts/run.sh`], 'echo run\n')
  assert.equal(fs.files['/src/pdf/SKILL.md'], '---\nname: pdf\n---\n', 'the source stays')
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('skills', `${DIR}/skills/pdf`) })

  const linked = await importInto(deps, { kind: 'skills', name: 'pdf', dir: '/src/linked', link: '/src/pdf' }, SHOP)
  assert.equal(linked.ok, true, linked.message)
  assert.equal(fs.links[`${SHOP}/.github/skills/linked`], '/src/pdf')
  assert.equal(refused(await importInto(deps, { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null })).reason, 'exists')
})
