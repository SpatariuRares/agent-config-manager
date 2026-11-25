// Copilot CLI against the provider contract, plus one test per rule of its own. Nothing here runs `copilot` or `gh`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, Item } from '../../adapters/view.ts'
import { itemKey, type ProviderDeps } from '../toolkit.ts'
import { routeAction } from '../router.ts'
import { fakeExec, fakeFs, providerContract } from '../testing.ts'
import { copilotProvider, COPILOT_SUPPORTS } from './index.ts'

const HOME = '/home/me'
const DIR = `${HOME}/.copilot`
const MCP = `${DIR}/mcp-config.json`
const SHOP = '/work/shop'
const STORE = `${HOME}/.config/agent-config-manager/backups/copilot`
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

const FILES: Record<string, string> = {
  // config.json is JSONC: it starts with comment lines. /gone is trusted but no longer exists.
  [`${DIR}/config.json`]: `// User settings belong in settings.json.\n// This file is managed automatically.\n${json({ firstLaunchAt: '2026-01-01', trustedFolders: [SHOP, '/gone'] })}`,
  [MCP]: json({
    mcpServers: {
      context7: { command: 'npx', args: ['-y', '--package=@upstash/context7-mcp@2.2.5', '--', 'context7-mcp'] },
      vercel: { type: 'http', url: 'https://mcp.vercel.com', tools: ['*'] }
    }
  }),
  [`${DIR}/skills/review/SKILL.md`]: '---\nname: review\ndescription: Reviews a diff.\n---\n',
  [`${HOME}/.agents/skills/shared/SKILL.md`]: '---\nname: shared\n---\n',
  [`${DIR}/agents/planner.agent.md`]: '---\nname: planner\ndescription: Plans work.\n---\n',
  [`${DIR}/agents/legacy.md`]: '---\ndescription: A plain .md profile.\n---\n',
  [`${DIR}/hooks/audit.json`]: json({
    version: 1,
    hooks: { preToolUse: [{ type: 'command', bash: './audit.sh', matcher: 'edit|create' }], sessionStart: [{ exec: 'node', args: ['init.js'] }] }
  }),
  [`${DIR}/installed-plugins/awesome-copilot/frontend/plugin.json`]: json({ name: 'frontend', description: 'UI kit', version: '1.0.0' }),
  [`${DIR}/installed-plugins/_direct/acme-tools/.github/plugin/plugin.json`]: json({ name: 'acme', description: 'Direct install' }),
  [`${SHOP}/README.md`]: 'shop',
  [`${SHOP}/.github/skills/deploy/SKILL.md`]: '---\nname: deploy\n---\n',
  [`${SHOP}/.claude/skills/claude-only/SKILL.md`]: '---\nname: claude-only\n---\n',
  [`${SHOP}/.github/agents/ops.agent.md`]: '---\nname: ops\n---\n',
  [`${SHOP}/.github/mcp.json`]: json({ mcpServers: { db: { command: 'db-mcp', args: [] } } }),
  [`${SHOP}/.mcp.json`]: json({ mcpServers: { team: { command: 'team-mcp', args: [] } } }),
  [`${SHOP}/.github/hooks/ci.json`]: json({ version: 1, hooks: { sessionEnd: [{ command: 'echo bye' }] } })
}

const mcpKey = (file: string, name: string) => itemKey('mcp', file, name)

providerContract(copilotProvider(), {
  home: HOME,
  files: FILES,
  write: { action: () => ({ type: 'remove', key: mcpKey(MCP, 'context7') }), file: MCP }
})

const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')
function machine(overrides: Record<string, string> = {}, commands: Record<string, string> = {}) {
  const fs = fakeFs({ ...structuredClone(FILES), ...overrides })
  const exec = fakeExec({ commands })
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: CLOCK }
  return { fs, exec, deps }
}
const provider = copilotProvider()
const viewOf = (deps: ProviderDeps) => provider.buildView(deps)
/** Through the real router, which runs restore from the provider's declared backups. */
const run = async (deps: ProviderDeps, action: Action, versions?: Record<string, string>) =>
  (await routeAction(deps, [provider], { agent: 'copilot', action, versions: versions ?? (await viewOf(deps)).versions })).result
const byKind = (items: Item[], kind: Item['kind']) => items.filter((item) => item.kind === kind)
const summary = (item: Item) => `${item.name} ${item.project ?? 'global'} ${item.movable ? 'rw' : 'ro'}`

test('Copilot CLI info: id, name, config home, all five classes, what works today and why the rest is read-only', async () => {
  const info = await provider.info(machine().deps)
  assert.equal(info.id, 'copilot')
  assert.equal(info.name, 'Copilot CLI')
  assert.equal(info.configHome, '~/.copilot')
  assert.deepEqual(info.kinds, ['plugins', 'skills', 'agents', 'mcp', 'hooks'])
  assert.deepEqual(info.supports, COPILOT_SUPPORTS)
  assert.match(info.note ?? '', /Plugins are read-only/)
  assert.match(info.note ?? '', /Hooks are read-only/)
})

test('Copilot CLI is detected from the copilot binary alone, or the copy gh copilot downloaded, but not from gh alone', async () => {
  const detected = async (files: Record<string, string>, commands: Record<string, string>) =>
    (await provider.info({ fs: fakeFs(files), exec: fakeExec({ commands }), home: HOME })).detected
  assert.equal(await detected({}, { copilot: '/opt/homebrew/bin/copilot' }), true)
  assert.equal(await detected({ [`${HOME}/.local/share/gh/copilot/copilot`]: 'bin' }, {}), true)
  assert.equal(await detected({}, { gh: '/opt/homebrew/bin/gh' }), false)
})

test('skills: Copilot folders are writable, ~/.agents/skills and project .agents/.claude skills are shown read-only', async () => {
  const skills = byKind((await viewOf(machine().deps)).items, 'skills')
  assert.deepEqual(skills.map(summary), ['review global rw', 'shared global ro', 'deploy /work/shop rw', 'claude-only /work/shop ro'])
  assert.equal(skills[0].description, 'Reviews a diff.')
  assert.equal(skills[0].source, `${DIR}/skills/review/SKILL.md`)
})

test('agents: both <name>.agent.md and <name>.md profiles, named from the frontmatter or the file', async () => {
  const agents = byKind((await viewOf(machine().deps)).items, 'agents')
  assert.deepEqual(agents.map(summary), ['legacy global rw', 'planner global rw', 'ops /work/shop rw'])
  assert.equal(agents[1].description, 'Plans work.')
})

test('mcp: servers of mcp-config.json, .github/mcp.json and the shared .mcp.json, with transport and target', async () => {
  const servers = byKind((await viewOf(machine().deps)).items, 'mcp')
  assert.deepEqual(servers.map(summary), ['context7 global rw', 'vercel global rw', 'db /work/shop rw', 'team /work/shop ro'])
  assert.deepEqual(servers[0].mcp, { transport: 'stdio', target: 'npx -y --package=@upstash/context7-mcp@2.2.5 -- context7-mcp' })
  assert.deepEqual(servers[1].mcp, { transport: 'http', target: 'https://mcp.vercel.com' })
})

test('hooks: one item per entry of ~/.copilot/hooks/*.json and .github/hooks/*.json, read-only', async () => {
  const hooks = byKind((await viewOf(machine().deps)).items, 'hooks')
  assert.deepEqual(
    hooks.map((item) => [item.project, item.hook, item.movable]),
    [
      [null, { event: 'preToolUse', matcher: 'edit|create', command: './audit.sh' }, false],
      [null, { event: 'sessionStart', matcher: '', command: 'node init.js' }, false],
      [SHOP, { event: 'sessionEnd', matcher: '', command: 'echo bye' }, false]
    ]
  )
})

test('plugins: marketplace and direct installs from their manifests, read-only', async () => {
  const plugins = byKind((await viewOf(machine().deps)).items, 'plugins')
  assert.deepEqual(
    plugins.map((item) => [item.name, item.description, item.source, item.removable]),
    [
      ['acme', 'Direct install', `${DIR}/installed-plugins/_direct/acme-tools`, false],
      ['frontend@awesome-copilot', 'UI kit', `${DIR}/installed-plugins/awesome-copilot/frontend`, false]
    ]
  )
})

test('project scope: projects are the trusted folders that still exist, and their items carry the project', async () => {
  const view = await viewOf(machine().deps)
  assert.deepEqual(view.projects, [SHOP])
  const local = view.items.filter((item) => item.project !== null)
  assert.ok(local.length > 0)
  assert.ok(local.every((item) => item.project === SHOP && item.scope === 'project'))
  assert.ok(view.items.filter((item) => item.project === null).every((item) => item.scope === 'user'))
  assert.equal(view.problems.length, 0, view.problems.join('\n'))
})

test('an MCP remove keeps every other key and server, in the 2-space format with a trailing newline', async () => {
  const original = { $schema: 'x', mcpServers: { a: { command: 'a', args: [] }, context7: { command: 'npx', args: [] }, z: { url: 'https://z', type: 'http', tools: ['*'] } }, extra: { keep: true } }
  const { deps, fs } = machine({ [MCP]: json(original) })
  const result = await run(deps, { type: 'remove', key: mcpKey(MCP, 'context7') })
  assert.equal(result.ok, true, result.message)
  assert.equal(fs.files[MCP], json({ $schema: 'x', mcpServers: { a: original.mcpServers.a, z: original.mcpServers.z }, extra: { keep: true } }))
})

test('an MCP move to a project adds the server unchanged to .github/mcp.json and takes it out of mcp-config.json', async () => {
  const { deps, fs } = machine()
  const result = await run(deps, { type: 'move', key: mcpKey(MCP, 'context7'), to: { project: SHOP, scope: 'project' }, copy: false })
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(JSON.parse(fs.files[`${SHOP}/.github/mcp.json`]).mcpServers, {
    db: { command: 'db-mcp', args: [] },
    context7: JSON.parse(FILES[MCP]).mcpServers.context7
  })
  assert.deepEqual(Object.keys(JSON.parse(fs.files[MCP]).mcpServers), ['vercel'])
  assert.deepEqual(result.ok && result.undo, { type: 'move', key: mcpKey(`${SHOP}/.github/mcp.json`, 'context7'), to: { project: null, scope: 'project' }, copy: false })
})

test('every MCP write backs the file up before changing it, and the undo restores it', async () => {
  const { deps, fs } = machine()
  const order: string[] = []
  const writeText = fs.writeText.bind(fs)
  fs.writeText = async (path, text) => {
    order.push(path)
    return writeText(path, text)
  }
  const result = await run(deps, { type: 'remove', key: mcpKey(MCP, 'vercel') })
  assert.equal(result.ok, true, result.message)
  assert.equal(order.length, 2)
  assert.ok(order[0].startsWith(`${STORE}/mcp-config.`), order[0])
  assert.equal(order[1], MCP)
  assert.equal(fs.files[order[0]], FILES[MCP])
  const undone = await run(deps, (result as { undo: Action }).undo)
  assert.equal(undone.ok, true, undone.message)
  assert.equal(fs.files[MCP], FILES[MCP])
})

test('a write refuses a stale view: nothing is written, not even half a move', async () => {
  const { deps, fs } = machine()
  const view = await viewOf(deps)
  const before = structuredClone(fs.files)
  const staleTarget = { ...view.versions, [`${SHOP}/.github/mcp.json`]: 'stale' }
  const moved = await run(deps, { type: 'move', key: mcpKey(MCP, 'context7'), to: { project: SHOP, scope: 'project' }, copy: false }, staleTarget)
  assert.equal(moved.ok, false)
  assert.equal(!moved.ok && moved.reason, 'changed')
  // A stale source is noticed before the destination is written.
  const staleSource = { ...view.versions, [MCP]: 'stale' }
  const half = await run(deps, { type: 'move', key: mcpKey(MCP, 'context7'), to: { project: SHOP, scope: 'project' }, copy: false }, staleSource)
  assert.equal(!half.ok && half.reason, 'changed')
  const removed = await run(deps, { type: 'remove', key: mcpKey(MCP, 'context7') }, { ...view.versions, [MCP]: 'stale' })
  assert.equal(!removed.ok && removed.reason, 'changed')
  assert.deepEqual(fs.files, before)
})

test('secrets in env, headers, args, URLs and hooks never appear in the view', async () => {
  const secrets = ['ghp_ENVSECRET1234', 'HEADERSECRET5678', 'ARGSECRET9012', 'URLSECRET3456', 'HOOKSECRET7890', 'HOOKENV1234', 'BAREghp']
  const { deps } = machine({
    [MCP]: json({
      mcpServers: {
        github: { command: 'gh-mcp', args: ['--api-key', 'ARGSECRET9012', 'ghp_BAREghpTOKEN123'], env: { GITHUB_TOKEN: 'ghp_ENVSECRET1234' } },
        remote: { type: 'http', url: 'https://mcp.example.com/sse?token=URLSECRET3456', headers: { Authorization: 'Bearer HEADERSECRET5678' } }
      }
    }),
    [`${DIR}/hooks/audit.json`]: json({ version: 1, hooks: { sessionStart: [{ bash: 'API_TOKEN=HOOKSECRET7890 ./start.sh', env: { KEY: 'HOOKENV1234' } }] } }),
    [`${DIR}/hooks/broken.json`]: '{"hooks": ghp_BAREghpTOKEN123'
  })
  const view = await viewOf(deps)
  const text = JSON.stringify(view)
  for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} leaked`)
  const server = view.items.find((item) => item.name === 'github')!
  assert.equal(server.mcp?.target, 'gh-mcp --api-key <redacted> <redacted>')
})

test('a malformed file is reported in problems, the rest still reads, and a write to it is refused', async () => {
  const { deps, fs } = machine({ [MCP]: '{ "mcpServers": ', [`${DIR}/hooks/audit.json`]: '[1, 2]' })
  const view = await viewOf(deps)
  assert.deepEqual(view.problems, [
    `${MCP}: not a valid JSON object, so its MCP servers are not shown.`,
    `${DIR}/hooks/audit.json: not a hooks file (a JSON object with a "hooks" object), so its hooks are not shown.`
  ])
  assert.ok(view.items.some((item) => item.name === 'review'))
  const moved = await run(deps, { type: 'move', key: mcpKey(`${SHOP}/.github/mcp.json`, 'db'), to: { project: null }, copy: true })
  assert.equal(!moved.ok && moved.reason, 'unreadable')
  assert.equal(fs.files[MCP], '{ "mcpServers": ')
})

test('an MCP server is not written to a project as only-me, nor with a literal secret', async () => {
  const { deps, fs } = machine({ [MCP]: json({ mcpServers: { keyed: { command: 'k', args: [], env: { KEY: 'literal' } }, ref: { command: 'r', args: [], env: { KEY: '${KEY}' } } } }) })
  const before = structuredClone(fs.files)
  const local = await run(deps, { type: 'move', key: mcpKey(MCP, 'ref'), to: { project: SHOP, scope: 'local' }, copy: false })
  assert.equal(!local.ok && local.reason, 'unsupported')
  const literal = await run(deps, { type: 'move', key: mcpKey(MCP, 'keyed'), to: { project: SHOP, scope: 'project' }, copy: true })
  assert.equal(!literal.ok && literal.reason, 'secret')
  assert.deepEqual(fs.files, before)
  const referenced = await run(deps, { type: 'move', key: mcpKey(MCP, 'ref'), to: { project: SHOP, scope: 'project' }, copy: true })
  assert.equal(referenced.ok, true, referenced.message)
})

test('a read-only item is refused before anything is written', async () => {
  const { deps, fs } = machine()
  const before = structuredClone(fs.files)
  const shared = await run(deps, { type: 'remove', key: mcpKey(`${SHOP}/.mcp.json`, 'team') })
  assert.equal(!shared.ok && shared.reason, 'not-movable')
  assert.deepEqual(fs.files, before)
})

test('skills and agents move between Copilot folders only, and a removed one comes back from the trash', async () => {
  const { deps, fs, exec } = machine()
  const skill = itemKey('skills', `${DIR}/skills/review`)
  const moved = await run(deps, { type: 'move', key: skill, to: { project: SHOP }, copy: false })
  assert.equal(moved.ok, true, moved.message)
  assert.equal(fs.files[`${SHOP}/.github/skills/review/SKILL.md`], FILES[`${DIR}/skills/review/SKILL.md`])
  assert.equal(fs.files[`${DIR}/skills/review/SKILL.md`], undefined)

  const agent = itemKey('agents', `${DIR}/agents/planner.agent.md`)
  const removed = await run(deps, { type: 'remove', key: agent })
  assert.equal(removed.ok, true, removed.message)
  assert.equal(fs.files[`${DIR}/agents/planner.agent.md`], undefined)
  const restored = await run(deps, (removed as { undo: Action }).undo)
  assert.equal(restored.ok, true, restored.message)
  assert.equal(fs.files[`${DIR}/agents/planner.agent.md`], FILES[`${DIR}/agents/planner.agent.md`])
  assert.deepEqual(exec.calls, [], 'no command was run')
})

test('A3: values after --key and -k are redacted too', async () => {
  const { deps } = machine({ [MCP]: json({ mcpServers: { keyed: { command: 'srv', args: ['--key', 'KEYSECRET1', '-k', 'KSECRET2'] } } }) })
  const view = await viewOf(deps)
  assert.equal(view.items.find((item) => item.name === 'keyed')?.mcp?.target, 'srv --key <redacted> -k <redacted>')
})

test('A4: a trusted folder that is a link to the home folder does not list the shared global folders twice', async () => {
  const fs = fakeFs(
    { ...structuredClone(FILES), [`${DIR}/config.json`]: json({ trustedFolders: [SHOP, '/link'] }) },
    { '/link': HOME }
  )
  const view = await viewOf({ fs, exec: fakeExec(), home: HOME, clock: CLOCK })
  assert.deepEqual(
    view.items.filter((item) => item.name === 'shared').map((item) => item.project),
    [null]
  )
})

test('an MCP server with a secret in its args or url is not copied into a project file, which the team shares', async () => {
  const { deps, fs } = machine({
    [MCP]: json({
      mcpServers: {
        argy: { command: 'srv', args: ['--token', 'sk-live-SECRET1234567890'] },
        urly: { type: 'http', url: 'https://x.io/mcp?token=abc123tok' }
      }
    })
  })
  const before = structuredClone(fs.files)
  for (const name of ['argy', 'urly']) {
    const moved = await run(deps, { type: 'move', key: mcpKey(MCP, name), to: { project: SHOP, scope: 'project' }, copy: true })
    assert.equal(!moved.ok && moved.reason, 'secret', name)
    assert.doesNotMatch(moved.message, /sk-live|abc123tok/)
  }
  assert.deepEqual(fs.files, before)
})

test('the Copilot bug: an env value with a `$` but no ${VAR} reference is a literal, and is not moved into the team .github/mcp.json', async () => {
  const value = 'sk-live-0123456789abcdef$x'
  const { deps, fs } = machine({ [MCP]: json({ mcpServers: { sneaky: { command: 's', args: [], env: { TOKEN: value } } } }) })
  const before = structuredClone(fs.files)
  const moved = await run(deps, { type: 'move', key: mcpKey(MCP, 'sneaky'), to: { project: SHOP, scope: 'project' }, copy: false })
  assert.equal(!moved.ok && moved.reason, 'secret')
  assert.match(moved.message, /literal env or header values \(env\.TOKEN\)/)
  assert.ok(!moved.message.includes(value), 'the message shows the value')
  assert.deepEqual(fs.files, before, 'nothing was written')
  // Its own user file is not shared, and no command line sees it: a copy to global keeps the literal.
  const global = machine({ [`${SHOP}/.github/mcp.json`]: json({ mcpServers: { sneaky: { command: 's', env: { TOKEN: value } } } }) })
  const copied = await run(global.deps, { type: 'move', key: mcpKey(`${SHOP}/.github/mcp.json`, 'sneaky'), to: { project: null }, copy: true })
  assert.equal(copied.ok, true, copied.message)
})
