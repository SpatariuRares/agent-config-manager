// The panel contract end to end over in-memory doubles: buildView and runAction.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { itemKey } from '../providers/item-index.ts'
import { buildView, fakeClaude, fakeFs, runAction } from '../providers/claude/test-support.ts'
import { actionQueue } from './backend.ts'
import type { Action, ActionAnswer, Item, View } from './view.ts'

const BACKUPS = '/home/.claude/backups/claude-config-manager'
const STAMP = '2026-11-24T10-00-00-000Z'
const USER = '/home/.claude/settings.json'
const SHOP = '/work/shop'
const SHOP_TEAM = '/work/shop/.claude/settings.json'
const SHOP_LOCAL = '/work/shop/.claude/settings.local.json'
const BLOG = '/work/blog'
const BLOG_LOCAL = '/work/blog/.claude/settings.local.json'
const BLOG_TEAM = '/work/blog/.claude/settings.json'
const NOTE = 'Changes apply to new Claude Code sessions, or after /reload-plugins.'
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const backupOf = (file: string) => `${BACKUPS}/${file === USER ? 'settings' : encodeURIComponent(file)}.${STAMP}.json`

const userSettings = {
  enabledPlugins: { 'a@m': true, 'b@m': false },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user', timeout: 5 }] }] }
}
const shopTeam = {
  enabledPlugins: { 'b@m': true },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
}
const userConfig = {
  mcpServers: { web: { type: 'http', url: 'https://web.example' } },
  projects: { [SHOP]: { mcpServers: { db: { command: 'db-server', args: ['--port', '1'] } } }, [BLOG]: {} }
}

function setup(extra: Record<string, string> = {}, links: Record<string, string> = {}) {
  const fs = fakeFs(
    {
      [USER]: json(userSettings),
      '/home/.claude.json': JSON.stringify(userConfig),
      '/home/.claude/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'a@m': [{ scope: 'user', version: '1.0.0' }], 'b@m': [{ scope: 'user', version: '2.0.0' }] }
      }),
      '/home/.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Reviews code\n---\n',
      '/home/.claude/agents/helper.md': '---\ndescription: Helps\n---\n',
      [SHOP_TEAM]: json(shopTeam),
      '/work/shop/.mcp.json': json({ mcpServers: { docs: { command: 'docs-server' } } }),
      '/work/shop/.claude/skills/deploy/SKILL.md': '---\ndescription: Deploys\n---\n',
      '/work/shop/.claude/agents/tester.md': 'tests',
      '/work/blog/README.md': 'blog',
      ...extra
    },
    links
  )
  return { fs, exec: fakeClaude(fs), clock: () => new Date('2026-11-24T10:00:00.000Z') }
}

type Deps = ReturnType<typeof setup>

async function view(deps: Deps): Promise<View> {
  const answer = await buildView(deps)
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}

const find = (v: View, kind: Item['kind'], name: string, project: string | null = null) => {
  const item = v.items.find((i) => i.kind === kind && i.name === name && i.project === project)
  assert.ok(item, `${kind} ${name} in ${project ?? 'global'}`)
  return item
}

async function run(deps: Deps, action: Action, versions?: Record<string, string>): Promise<ActionAnswer> {
  return runAction(deps, { agent: 'claude', action, versions: versions ?? (await view(deps)).versions })
}

const ok = (answer: ActionAnswer) => {
  assert.equal(answer.result.ok, true, answer.result.message)
  return answer.result as { ok: true; message: string; undo?: Action; warning?: string }
}

const failed = (answer: ActionAnswer) => {
  assert.equal(answer.result.ok, false, answer.result.message)
  return answer.result as { ok: false; reason: string; message: string }
}

test('lists every class globally and per project, each item with its scope and source', async () => {
  const v = await view(setup())
  const summary = v.items.map((i) => [i.kind, i.name, i.project, i.scope, i.source])
  assert.deepEqual(summary, [
    ['plugins', 'a', null, 'user', USER],
    ['plugins', 'b', null, 'user', USER],
    ['plugins', 'b', SHOP, 'project', SHOP_TEAM],
    ['skills', 'review', null, 'user', '/home/.claude/skills/review'],
    ['skills', 'deploy', SHOP, 'project', '/work/shop/.claude/skills/deploy'],
    ['agents', 'helper', null, 'user', '/home/.claude/agents/helper.md'],
    ['agents', 'tester', SHOP, 'project', '/work/shop/.claude/agents/tester.md'],
    ['mcp', 'web', null, 'user', '/home/.claude.json'],
    ['mcp', 'docs', SHOP, 'project', '/work/shop/.mcp.json'],
    ['mcp', 'db', SHOP, 'local', '/home/.claude.json'],
    ['hooks', 'echo user', null, 'user', USER],
    ['hooks', 'say done', SHOP, 'project', SHOP_TEAM]
  ])
  assert.deepEqual(v.projects, [BLOG, SHOP])
  assert.equal(new Set(v.items.map((i) => i.key)).size, v.items.length)
  assert.equal(find(v, 'skills', 'review').key, itemKey('skills', '/home/.claude/skills/review'))
  assert.deepEqual(find(v, 'mcp', 'db', SHOP).mcp, { transport: 'stdio', target: 'db-server --port 1' })
  assert.deepEqual(find(v, 'hooks', 'echo user').hook, { event: 'PreToolUse', matcher: 'Bash', command: 'echo user' })
  assert.deepEqual(find(v, 'hooks', 'say done', SHOP).hook, { event: 'Stop', matcher: '*', command: 'say done' })
  assert.deepEqual(v.problems, [])
})

test('plugin items: a global one per user setting, a project one per override, removable only as overrides', async () => {
  const v = await view(setup())
  const global = find(v, 'plugins', 'b')
  assert.equal(global.plugin?.enabled, false)
  assert.equal(global.plugin?.installed, true)
  assert.equal(global.plugin?.version, '2.0.0')
  assert.equal(global.removable, false)
  const override = find(v, 'plugins', 'b', SHOP)
  assert.equal(override.plugin?.enabled, true)
  assert.equal(override.removable, true)
  assert.ok(v.items.every((i) => i.movable))
})

test('versions cover every file read, plus the project files a change might create', async () => {
  const v = await view(setup())
  for (const file of [USER, '/home/.claude.json', SHOP_TEAM, '/work/shop/.mcp.json']) assert.notEqual(v.versions[file], '', file)
  for (const file of [SHOP_LOCAL, BLOG_TEAM, BLOG_LOCAL, '/work/blog/.mcp.json']) assert.equal(v.versions[file], '', file)
})

test('a symlinked skill with a relative link cannot be moved; an absolute link can', async () => {
  const v = await view(
    setup({ '/dots/abs/SKILL.md': 'a', '/home/.claude/rel-target/SKILL.md': 'r' }, {
      '/home/.claude/skills/abs': '/dots/abs',
      '/home/.claude/skills/rel': '../rel-target'
    })
  )
  assert.equal(find(v, 'skills', 'abs').movable, true)
  const rel = find(v, 'skills', 'rel')
  assert.equal(rel.movable, false)
  assert.match(rel.notMovableReason ?? '', /relative link/)
})

test('a home folder listed as a project does not repeat the global skills and settings', async () => {
  const deps = setup({
    '/home/.claude.json': JSON.stringify({ ...userConfig, projects: { ...userConfig.projects, '/home': {} } })
  })
  const v = await view(deps)
  assert.equal(v.items.filter((i) => i.project === '/home').length, 0)
})

const versionsOf = (answer: ActionAnswer) => (answer.view.ok ? answer.view.view.versions : {})
const userKey = (id: string) => itemKey('plugins', null, 'user', id)
const overrideKey = (project: string, scope: string, id: string) => itemKey('plugins', project, scope, id)
const mcpKeyOf = (project: string | null, scope: string, name: string) => itemKey('mcp', project, scope, name)
/** A hook's key: its command is hashed, so a secret in it never reaches the panel through the key. */
const hookKeyOf = (file: string, event: string, matcher: string, command: string) =>
  itemKey('hooks', file, event, matcher, createHash('sha256').update(command).digest('hex').slice(0, 16), 0)
const REVIEW = '/home/.claude/skills/review'
const REVIEW_KEY = itemKey('skills', '/home/.claude/skills/review')

// ---- skills and agents (S5, S7)

test('moving a skill to a project moves its folder, offers a move back, and touches no settings', async () => {
  const deps = setup({ '/home/.claude/skills/review/notes/a.txt': 'a' })
  const settingsBefore = deps.fs.files[USER]
  const answer = await run(deps, { type: 'move', key: REVIEW_KEY, to: { project: SHOP }, copy: false })
  const result = ok(answer)
  assert.equal(deps.fs.files['/work/shop/.claude/skills/review/notes/a.txt'], 'a')
  assert.equal(deps.fs.files[`${REVIEW}/SKILL.md`], undefined)
  assert.equal(deps.fs.files[USER], settingsBefore)
  assert.match(result.message, /^Moved skill "review" from global to \/work\/shop\./)
  assert.match(result.message, new RegExp(NOTE.replace(/[./]/g, '\\$&')))
  const movedKey = itemKey('skills', '/work/shop/.claude/skills/review')
  assert.deepEqual(result.undo, { type: 'move', key: movedKey, to: { project: null }, copy: false })
  assert.ok(answer.view.ok && answer.view.view.items.some((i) => i.key === movedKey))

  ok(await run(deps, result.undo!, versionsOf(answer)))
  assert.equal(deps.fs.files[`${REVIEW}/SKILL.md`], '---\nname: review\ndescription: Reviews code\n---\n')
  assert.equal(deps.fs.files['/work/shop/.claude/skills/review/SKILL.md'], undefined)
})

test('copying an agent keeps the original, and its undo removes the copy', async () => {
  const deps = setup()
  const result = ok(await run(deps, { type: 'move', key: itemKey('agents', '/home/.claude/agents/helper.md'), to: { project: BLOG }, copy: true }))
  assert.equal(deps.fs.files['/work/blog/.claude/agents/helper.md'], '---\ndescription: Helps\n---\n')
  assert.equal(deps.fs.files['/home/.claude/agents/helper.md'], '---\ndescription: Helps\n---\n')
  assert.match(result.message, /^Copied agent "helper" from global to \/work\/blog\./)
  assert.deepEqual(result.undo, { type: 'remove', key: itemKey('agents', '/work/blog/.claude/agents/helper.md') })
})

test('a move refuses when the destination already has an item with that name, and changes nothing', async () => {
  const deps = setup({ '/work/shop/.claude/skills/review/SKILL.md': 'theirs' })
  const before = { ...deps.fs.files }
  const result = failed(await run(deps, { type: 'move', key: REVIEW_KEY, to: { project: SHOP }, copy: false }))
  assert.equal(result.reason, 'exists')
  assert.deepEqual(deps.fs.files, before)
})

test('a symlinked skill moves as a link; its target stays put', async () => {
  const deps = setup({ '/dots/linked/SKILL.md': 'linked' }, { '/home/.claude/skills/linked': '/dots/linked' })
  ok(await run(deps, { type: 'move', key: itemKey('skills', '/home/.claude/skills/linked'), to: { project: SHOP }, copy: false }))
  assert.deepEqual(deps.fs.links, { '/work/shop/.claude/skills/linked': '/dots/linked' })
  assert.equal(deps.fs.files['/dots/linked/SKILL.md'], 'linked')
})

test('a relative-link skill is refused for move', async () => {
  const deps = setup({ '/home/.claude/rel/SKILL.md': 'r' }, { '/home/.claude/skills/rel': '../rel' })
  const result = failed(await run(deps, { type: 'move', key: itemKey('skills', '/home/.claude/skills/rel'), to: { project: SHOP }, copy: false }))
  assert.equal(result.reason, 'not-movable')
  assert.deepEqual(deps.fs.links, { '/home/.claude/skills/rel': '../rel' })
})

test('a skill or agent move or remove refuses as changed when its file changed since the view, and changes nothing', async () => {
  const deps = setup()
  const versions = (await view(deps)).versions
  deps.fs.files[`${REVIEW}/SKILL.md`] += 'edited meanwhile\n'
  deps.fs.files['/home/.claude/agents/helper.md'] += 'edited meanwhile\n'
  const before = { ...deps.fs.files }
  const helper = itemKey('agents', '/home/.claude/agents/helper.md')
  for (const action of [
    { type: 'move', key: REVIEW_KEY, to: { project: SHOP }, copy: false },
    { type: 'move', key: helper, to: { project: BLOG }, copy: true },
    { type: 'remove', key: REVIEW_KEY },
    { type: 'remove', key: helper }
  ] satisfies Action[]) {
    assert.equal(failed(await run(deps, action, versions)).reason, 'changed', JSON.stringify(action))
  }
  assert.deepEqual(deps.fs.files, before)
})

test('removing a skill puts it in a restorable trash listed with the backups', async () => {
  const deps = setup()
  const answer = await run(deps, { type: 'remove', key: REVIEW_KEY })
  const result = ok(answer)
  const name = `${encodeURIComponent(REVIEW)}.${STAMP}.trash`
  assert.equal(deps.fs.files[`${BACKUPS}/${name}/SKILL.md`], '---\nname: review\ndescription: Reviews code\n---\n')
  assert.equal(deps.fs.files[`${REVIEW}/SKILL.md`], undefined)
  assert.match(result.message, /^Removed skill "review" from global\./)
  assert.deepEqual(result.undo, { type: 'restore', name })
  assert.ok(answer.view.ok)
  assert.deepEqual(answer.view.view.backups, [{ name, target: REVIEW, at: Date.parse('2026-11-24T10:00:00.000Z') }])

  const restored = ok(await run(deps, { type: 'restore', name }, versionsOf(answer)))
  assert.equal(deps.fs.files[`${REVIEW}/SKILL.md`], '---\nname: review\ndescription: Reviews code\n---\n')
  assert.deepEqual(restored.undo, { type: 'remove', key: REVIEW_KEY })
})

test('restoring a trashed skill refuses when something is now in its place', async () => {
  const deps = setup()
  const answer = await run(deps, { type: 'remove', key: REVIEW_KEY })
  const { undo } = ok(answer)
  deps.fs.files[`${REVIEW}/SKILL.md`] = 'new one'
  const result = failed(await run(deps, undo!, versionsOf(answer)))
  assert.equal(result.reason, 'exists')
  assert.equal(deps.fs.files[`${REVIEW}/SKILL.md`], 'new one')
})

// ---- MCP (S5, S7): only through the CLI, never writing ~/.claude.json

test('moving a global MCP server into a project adds it there through the CLI, then removes it globally', async () => {
  const deps = setup()
  const config = deps.fs.files['/home/.claude.json']
  const result = ok(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'web'), to: { project: SHOP }, copy: false }))
  assert.deepEqual(deps.exec.calls, [
    'claude mcp add-json web {"type":"http","url":"https://web.example"} --scope local @ /work/shop',
    'claude mcp remove web --scope user @ -'
  ])
  // Only the CLI wrote ~/.claude.json (the double writes it as Claude Code would); the app backed it up first.
  const written = JSON.parse(deps.fs.files['/home/.claude.json'])
  assert.deepEqual(written.mcpServers, {})
  assert.deepEqual(written.projects[SHOP].mcpServers.web, { type: 'http', url: 'https://web.example' })
  assert.equal(deps.fs.files[backupOf('/home/.claude.json')], config)
  assert.match(result.message, /^Moved MCP server "web" from global to \/work\/shop \(only me\)\./)
  assert.deepEqual(result.undo, { type: 'move', key: mcpKeyOf(SHOP, 'local', 'web'), to: { project: null }, copy: false })
})

test('copying an MCP server to a project team file only adds it, with the project scope', async () => {
  const deps = setup()
  const result = ok(
    await run(deps, { type: 'move', key: mcpKeyOf(SHOP, 'local', 'db'), to: { project: BLOG, scope: 'project' }, copy: true })
  )
  assert.deepEqual(deps.exec.calls, ['claude mcp add-json db {"type":"stdio","command":"db-server","args":["--port","1"]} --scope project @ /work/blog'])
  assert.deepEqual(result.undo, { type: 'remove', key: mcpKeyOf(BLOG, 'project', 'db') })
})

test('an MCP server with a secret-looking arg or url is not copied or moved into a project team file, which the team shares', async () => {
  const deps = setup({
    '/home/.claude.json': JSON.stringify({
      ...userConfig,
      mcpServers: {
        ...userConfig.mcpServers,
        keyed: { command: 'npx', args: ['srv', '--api-key', 'sk-live-SECRET1234567890'] },
        hook: { type: 'http', url: 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX' }
      }
    })
  })
  for (const [name, copy] of [['keyed', true], ['hook', false]] as const) {
    const result = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', name), to: { project: SHOP, scope: 'project' }, copy }))
    assert.equal(result.reason, 'secret', name)
    assert.match(result.message, /secret-looking/)
    assert.doesNotMatch(result.message, /SECRET1234567890|XXXXXXXX/)
  }
  assert.deepEqual(deps.exec.calls, [])
  assert.equal(deps.fs.files['/work/shop/.mcp.json'], json({ mcpServers: { docs: { command: 'docs-server' } } }))
  // Only me lives in ~/.claude.json, but add-json takes the whole config on its command line: refused too.
  assert.equal(failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'keyed'), to: { project: SHOP, scope: 'local' }, copy: true })).reason, 'secret')
  assert.deepEqual(deps.exec.calls, [])
})

test('a Claude Code move to only me refuses a literal secret header too: add-json puts the whole config on its command line', async () => {
  const deps = setup({
    '/home/.claude.json': JSON.stringify({
      ...userConfig,
      mcpServers: {
        ...userConfig.mcpServers,
        headed: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer abc123secret' } },
        referenced: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } }
      }
    })
  })
  const refusal = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'headed'), to: { project: SHOP, scope: 'local' }, copy: true }))
  assert.equal(refusal.reason, 'secret')
  assert.match(refusal.message, /secret-looking values \(headers\.Authorization\)/)
  assert.doesNotMatch(refusal.message, /abc123secret/)
  assert.deepEqual(deps.exec.calls, [])
  ok(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'referenced'), to: { project: SHOP, scope: 'local' }, copy: true }))
  assert.deepEqual(deps.exec.calls, [
    'claude mcp add-json referenced {"type":"http","url":"https://api.example/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}} --scope local @ /work/shop'
  ])
})

test('L-B: an MCP server with literal env or header values is not copied or moved into a project team file; ${VAR} references are', async () => {
  const deps = setup({
    '/home/.claude.json': JSON.stringify({
      ...userConfig,
      mcpServers: {
        ...userConfig.mcpServers,
        envy: { command: 'npx', args: ['srv'], env: { API_TOKEN: 'plain-value-1234' } },
        headed: { type: 'http', url: 'https://api.example/mcp', headers: { Authorization: 'Bearer abc' } },
        referenced: { command: 'npx', args: ['srv'], env: { API_TOKEN: '${API_TOKEN}' } }
      }
    })
  })
  for (const [name, copy] of [['envy', true], ['headed', false]] as const) {
    const result = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', name), to: { project: SHOP, scope: 'project' }, copy }))
    assert.equal(result.reason, 'secret', name)
    assert.match(result.message, /literal env or header values/)
    assert.doesNotMatch(result.message, /plain-value-1234|Bearer abc/)
  }
  assert.deepEqual(deps.exec.calls, [])
  assert.equal(deps.fs.files['/work/shop/.mcp.json'], json({ mcpServers: { docs: { command: 'docs-server' } } }))
  ok(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'referenced'), to: { project: SHOP, scope: 'project' }, copy: true }))
  // Only me is not shared, but add-json puts the value on its command line: a secret-looking one is refused.
  const onlyMe = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'envy'), to: { project: SHOP, scope: 'local' }, copy: true }))
  assert.equal(onlyMe.reason, 'secret')
  assert.match(onlyMe.message, /secret-looking values \(env\.API_TOKEN\)/)
})

test('an MCP move whose removal fails reports the partial result honestly', async () => {
  const deps = setup()
  deps.exec = fakeClaude(deps.fs, ['mcp-remove:user'])
  const result = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'web'), to: { project: SHOP }, copy: false }))
  assert.equal(result.reason, 'partial')
  assert.match(result.message, /^claude mcp add-json for web worked; then claude mcp remove for web failed: cannot mcp-remove in user\. The backups made first can put the files back: %2Fhome%2F\.claude\.json\./)
})

test('a claude mcp command that exits 0 without changing the file is reported as did-not-change', async () => {
  const deps = setup()
  deps.exec.silent = true
  const mcp = deps.fs.files['/work/shop/.mcp.json']
  const removed = failed(await run(deps, { type: 'remove', key: mcpKeyOf(SHOP, 'project', 'docs') }))
  assert.equal(removed.reason, 'did-not-change')
  assert.equal(removed.message, 'claude mcp remove for docs exited without an error, but /work/shop/.mcp.json does not show the change: no output.')
  assert.equal(deps.fs.files['/work/shop/.mcp.json'], mcp)
  const moved = failed(await run(deps, { type: 'move', key: mcpKeyOf(null, 'user', 'web'), to: { project: SHOP }, copy: false }))
  assert.equal(moved.reason, 'did-not-change')
  assert.deepEqual(deps.exec.calls, ['claude mcp remove docs --scope project @ /work/shop', 'claude mcp add-json web {"type":"http","url":"https://web.example"} --scope local @ /work/shop'])
})

test('an MCP server name that looks like an option is refused before claude runs', async () => {
  const deps = setup({ '/work/shop/.mcp.json': json({ mcpServers: { '-h': { command: 'x' } } }) })
  const result = failed(await run(deps, { type: 'remove', key: mcpKeyOf(SHOP, 'project', '-h') }))
  assert.equal(result.reason, 'refused')
  assert.match(result.message, /cannot start with "-"/)
  assert.deepEqual(deps.exec.calls, [])
})

test('an MCP move refuses a name already used at the destination, and runs nothing', async () => {
  const deps = setup({ '/work/shop/.mcp.json': json({ mcpServers: { docs: { command: 'docs-server' }, db: { command: 'team-db' } } }) })
  const result = failed(await run(deps, { type: 'move', key: mcpKeyOf(SHOP, 'local', 'db'), to: { project: SHOP, scope: 'project' }, copy: false }))
  assert.equal(result.reason, 'exists')
  assert.deepEqual(deps.exec.calls, [])
  const docs = failed(await run(deps, { type: 'move', key: mcpKeyOf(SHOP, 'project', 'docs'), to: { project: SHOP, scope: 'project' }, copy: false }))
  assert.equal(docs.reason, 'same-place')
})

test('an MCP change refuses when the project .mcp.json changed since the view', async () => {
  const deps = setup()
  const versions = (await view(deps)).versions
  deps.fs.files['/work/shop/.mcp.json'] = json({ mcpServers: { docs: { command: 'other' } } })
  const result = failed(await run(deps, { type: 'remove', key: mcpKeyOf(SHOP, 'project', 'docs') }, versions))
  assert.equal(result.reason, 'changed')
  assert.deepEqual(deps.exec.calls, [])
})

test('removing an MCP server goes through the CLI after a backup', async () => {
  const deps = setup()
  const mcp = deps.fs.files['/work/shop/.mcp.json']
  const result = ok(await run(deps, { type: 'remove', key: mcpKeyOf(SHOP, 'project', 'docs') }))
  assert.deepEqual(deps.exec.calls, ['claude mcp remove docs --scope project @ /work/shop'])
  assert.equal(deps.fs.files[backupOf('/work/shop/.mcp.json')], mcp)
  assert.match(result.message, /^Removed MCP server "docs" from \/work\/shop \(team\)\./)
  assert.deepEqual(result.undo, { type: 'restore', name: backupOf('/work/shop/.mcp.json').slice(BACKUPS.length + 1) })
})

// ---- hooks (S5, S7)

test('moving a hook keeps its event, matcher and fields, backs up both files, and offers a move back', async () => {
  const deps = setup()
  const answer = await run(deps, {
    type: 'move',
    key: hookKeyOf(USER, 'PreToolUse', 'Bash', 'echo user'),
    to: { project: BLOG },
    copy: false
  })
  const result = ok(answer)
  assert.deepEqual(JSON.parse(deps.fs.files[BLOG_LOCAL]), {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user', timeout: 5 }] }] }
  })
  assert.equal(deps.fs.files[USER], json({ enabledPlugins: userSettings.enabledPlugins, hooks: {} }))
  assert.equal(deps.fs.files[backupOf(USER)], json(userSettings))
  assert.ok(deps.fs.files[backupOf(BLOG_LOCAL)] !== undefined)
  assert.match(result.message, /^Moved hook "echo user" from global to \/work\/blog \(only me\)\./)
  const movedKey = hookKeyOf(BLOG_LOCAL, 'PreToolUse', 'Bash', 'echo user')
  assert.deepEqual(result.undo, { type: 'move', key: movedKey, to: { project: null }, copy: false })
  ok(await run(deps, result.undo!, versionsOf(answer)))
  assert.deepEqual(JSON.parse(deps.fs.files[USER]).hooks, userSettings.hooks)
})

test('copying a hook into a group with the same matcher appends to that group', async () => {
  const deps = setup({ [SHOP_LOCAL]: json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } }) })
  const result = ok(
    await run(deps, { type: 'move', key: hookKeyOf(SHOP_TEAM, 'Stop', '', 'say done'), to: { project: SHOP, scope: 'local' }, copy: true })
  )
  assert.deepEqual(JSON.parse(deps.fs.files[SHOP_LOCAL]).hooks.Stop, [
    { hooks: [{ type: 'command', command: 'beep' }, { type: 'command', command: 'say done' }] }
  ])
  assert.equal(deps.fs.files[SHOP_TEAM], json(shopTeam))
  assert.deepEqual(result.undo, { type: 'remove', key: hookKeyOf(SHOP_LOCAL, 'Stop', '', 'say done') })
})

test('removing a hook is a versioned write with a backup, undone by restoring that backup', async () => {
  const deps = setup()
  const answer = await run(deps, { type: 'remove', key: hookKeyOf(SHOP_TEAM, 'Stop', '', 'say done') })
  const result = ok(answer)
  assert.equal(deps.fs.files[SHOP_TEAM], json({ enabledPlugins: shopTeam.enabledPlugins, hooks: {} }))
  assert.equal(deps.fs.files[backupOf(SHOP_TEAM)], json(shopTeam))
  assert.deepEqual(result.undo, { type: 'restore', name: backupOf(SHOP_TEAM).slice(BACKUPS.length + 1) })
  deps.clock = () => new Date('2026-11-24T11:00:00.000Z')
  ok(await run(deps, result.undo!, versionsOf(answer)))
  assert.equal(deps.fs.files[SHOP_TEAM], json(shopTeam))
})

test('a hook change refuses when a file changed since the view, and writes nothing', async () => {
  const deps = setup()
  const versions = (await view(deps)).versions
  deps.fs.files[BLOG_LOCAL] = json({ model: 'x' })
  const before = { ...deps.fs.files }
  const result = failed(
    await run(deps, { type: 'move', key: hookKeyOf(USER, 'PreToolUse', 'Bash', 'echo user'), to: { project: BLOG }, copy: false }, versions)
  )
  assert.equal(result.reason, 'changed')
  assert.deepEqual(deps.fs.files, before)
})

test('a hook move whose second write throws is partial, names both backups, and a restore puts the destination back', async () => {
  const deps = setup({ [SHOP_LOCAL]: json({ model: 'x' }) })
  const writeText = deps.fs.writeText.bind(deps.fs)
  deps.fs.writeText = async (path, text) => {
    if (path === USER) throw Object.assign(new Error(`EACCES: permission denied, open '${USER}'`), { code: 'EACCES' })
    return writeText(path, text)
  }
  const result = failed(
    await run(deps, { type: 'move', key: hookKeyOf(USER, 'PreToolUse', 'Bash', 'echo user'), to: { project: SHOP, scope: 'local' }, copy: false })
  )
  const name = (file: string) => backupOf(file).slice(BACKUPS.length + 1)
  assert.equal(result.reason, 'partial')
  assert.ok(result.message.includes(name(SHOP_LOCAL)) && result.message.includes(name(USER)), result.message)
  assert.equal(deps.fs.files[USER], json(userSettings))
  assert.notEqual(deps.fs.files[SHOP_LOCAL], json({ model: 'x' }))
  deps.clock = () => new Date('2026-11-24T11:00:00.000Z')
  ok(await run(deps, { type: 'restore', name: name(SHOP_LOCAL) }))
  assert.equal(deps.fs.files[SHOP_LOCAL], json({ model: 'x' }))
})

// ---- plugins (S5)

test('a plugin move checks every file it touches before writing: a stale one refuses it as changed and nothing is written', async () => {
  const deps = setup()
  const versions = (await view(deps)).versions
  deps.fs.files[USER] = json({ ...userSettings, model: 'edited meanwhile' })
  deps.fs.files[SHOP_TEAM] = json({ ...shopTeam, model: 'edited meanwhile' })
  const before = { ...deps.fs.files }
  // Global to a project: the project file is fresh, settings.json (cleared second) is stale.
  assert.equal(failed(await run(deps, { type: 'move', key: userKey('a@m'), to: { project: BLOG }, copy: false }, versions)).reason, 'changed')
  // A project override to global: settings.json (written first) is stale.
  assert.equal(failed(await run(deps, { type: 'move', key: overrideKey(SHOP, 'project', 'b@m'), to: { project: null }, copy: false }, versions)).reason, 'changed')
  assert.deepEqual(deps.fs.files, before)
})

test('a plugin move backs up both files before writing either', async () => {
  const deps = setup()
  const order: string[] = []
  const writeText = deps.fs.writeText.bind(deps.fs)
  deps.fs.writeText = async (path, text) => {
    order.push(path)
    return writeText(path, text)
  }
  ok(await run(deps, { type: 'move', key: overrideKey(SHOP, 'project', 'b@m'), to: { project: null }, copy: false }))
  assert.deepEqual(order, [backupOf(USER), backupOf(SHOP_TEAM), USER, SHOP_TEAM])
})

test('a plugin move whose second write throws is partial and names the backups', async () => {
  const deps = setup()
  const writeText = deps.fs.writeText.bind(deps.fs)
  deps.fs.writeText = async (path, text) => {
    if (path === USER) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    return writeText(path, text)
  }
  const result = failed(await run(deps, { type: 'move', key: userKey('a@m'), to: { project: BLOG }, copy: false }))
  assert.equal(result.reason, 'partial')
  assert.match(result.message, /ENOSPC: no space left on device/)
  assert.ok(result.message.includes(backupOf(USER).slice(BACKUPS.length + 1)), result.message)
  assert.deepEqual(JSON.parse(deps.fs.files[BLOG_LOCAL]), { enabledPlugins: { 'a@m': true } })
})

test('moving a global plugin to a project turns it on there (only me) and off globally', async () => {
  const deps = setup()
  const result = ok(await run(deps, { type: 'move', key: userKey('a@m'), to: { project: BLOG }, copy: false }))
  assert.deepEqual(JSON.parse(deps.fs.files[BLOG_LOCAL]), { enabledPlugins: { 'a@m': true } })
  assert.equal(JSON.parse(deps.fs.files[USER]).enabledPlugins['a@m'], false)
  assert.equal(deps.fs.files[backupOf(USER)], json(userSettings))
  assert.match(result.message, /^Moved plugin "a" from global to \/work\/blog \(only me\)\./)
  assert.deepEqual(result.undo, { type: 'move', key: overrideKey(BLOG, 'local', 'a@m'), to: { project: null }, copy: false })
  assert.equal(result.warning, undefined)
})

test('copying a global plugin to a project leaves the global switch alone', async () => {
  const deps = setup()
  const result = ok(await run(deps, { type: 'move', key: userKey('a@m'), to: { project: BLOG, scope: 'project' }, copy: true }))
  assert.deepEqual(JSON.parse(deps.fs.files[BLOG_TEAM]), { enabledPlugins: { 'a@m': true } })
  assert.equal(deps.fs.files[USER], json(userSettings))
  assert.deepEqual(result.undo, { type: 'clearOverride', key: overrideKey(BLOG, 'project', 'a@m') })
})

test('moving a project override to global turns it on globally and clears the override', async () => {
  const deps = setup()
  const result = ok(await run(deps, { type: 'move', key: overrideKey(SHOP, 'project', 'b@m'), to: { project: null }, copy: false }))
  assert.equal(JSON.parse(deps.fs.files[USER]).enabledPlugins['b@m'], true)
  assert.deepEqual(JSON.parse(deps.fs.files[SHOP_TEAM]).enabledPlugins, {})
  assert.deepEqual(result.undo, { type: 'move', key: userKey('b@m'), to: { project: SHOP, scope: 'project' }, copy: false })
})

test('a team change hidden by the only-me file comes with a warning', async () => {
  const deps = setup({ [SHOP_LOCAL]: json({ enabledPlugins: { 'b@m': false } }) })
  const result = ok(await run(deps, { type: 'setEnabled', key: overrideKey(SHOP, 'project', 'b@m'), enabled: false }))
  assert.equal(result.warning, undefined)
  const on = ok(await run(deps, { type: 'setEnabled', key: overrideKey(SHOP, 'project', 'b@m'), enabled: true }))
  assert.match(on.warning ?? '', /only-me file .*settings\.local\.json/)
})

test('setEnabled flips the global switch or a project override, with an undo that flips it back', async () => {
  const deps = setup()
  const global = ok(await run(deps, { type: 'setEnabled', key: userKey('b@m'), enabled: true }))
  assert.equal(JSON.parse(deps.fs.files[USER]).enabledPlugins['b@m'], true)
  assert.match(global.message, /^Turned plugin "b" on globally\./)
  assert.deepEqual(global.undo, { type: 'setEnabled', key: userKey('b@m'), enabled: false })
  const project = ok(await run(deps, { type: 'setEnabled', key: overrideKey(SHOP, 'project', 'b@m'), enabled: false }))
  assert.equal(JSON.parse(deps.fs.files[SHOP_TEAM]).enabledPlugins['b@m'], false)
  assert.match(project.message, /^Turned plugin "b" off in \/work\/shop \(team\)\./)
})

test('clearOverride and remove both clear a project override; a global plugin cannot be removed', async () => {
  const deps = setup()
  const cleared = ok(await run(deps, { type: 'remove', key: overrideKey(SHOP, 'project', 'b@m') }))
  assert.deepEqual(JSON.parse(deps.fs.files[SHOP_TEAM]).enabledPlugins, {})
  assert.deepEqual(cleared.undo, { type: 'restore', name: backupOf(SHOP_TEAM).slice(BACKUPS.length + 1) })
  const refused = failed(await run(deps, { type: 'remove', key: userKey('a@m') }))
  assert.equal(refused.reason, 'unsupported')
  assert.equal(failed(await run(deps, { type: 'clearOverride', key: userKey('a@m') })).reason, 'unsupported')
})

test('uninstall goes through the CLI', async () => {
  const deps = setup()
  const result = ok(await run(deps, { type: 'uninstall', key: userKey('a@m') }))
  assert.deepEqual(deps.exec.calls, ['claude plugin uninstall a@m --scope user --keep-data --json @ -'])
  assert.match(result.message, /^Uninstalled plugin "a"\./)
  assert.equal(result.undo, undefined)
})

// ---- backups (S4)

test('snapshot backs up every settings file that exists, in one action', async () => {
  const deps = setup({ [SHOP_LOCAL]: '{}' })
  const answer = await run(deps, { type: 'snapshot' })
  const result = ok(answer)
  const files = [USER, '/home/.claude.json', SHOP_TEAM, SHOP_LOCAL, '/work/shop/.mcp.json']
  for (const file of files) assert.equal(deps.fs.files[backupOf(file)], deps.fs.files[file], file)
  assert.equal(result.message, 'Backed up 5 settings files to ~/.claude/backups/claude-config-manager.')
  assert.ok(answer.view.ok)
  assert.equal(answer.view.view.backups.length, 5)
})

test('a .mcp.json backup restores; a ~/.claude.json backup is refused because Claude Code owns that file', async () => {
  const deps = setup()
  const answer = await run(deps, { type: 'snapshot' })
  const mcp = deps.fs.files['/work/shop/.mcp.json']
  deps.fs.files['/work/shop/.mcp.json'] = '{}'
  deps.clock = () => new Date('2026-11-24T11:00:00.000Z')
  const name = (file: string) => backupOf(file).slice(BACKUPS.length + 1)
  ok(await run(deps, { type: 'restore', name: name('/work/shop/.mcp.json') }))
  assert.equal(deps.fs.files['/work/shop/.mcp.json'], mcp)
  const refused = failed(await run(deps, { type: 'restore', name: name('/home/.claude.json') }, versionsOf(answer)))
  assert.equal(refused.reason, 'claude-owned')
  assert.match(refused.message, /claude-config-manager\/%2Fhome%2F.claude.json/)
})

test('an action on a key that is no longer there is refused as changed', async () => {
  const deps = setup()
  const result = failed(await run(deps, { type: 'remove', key: itemKey('skills', '/nowhere') }))
  assert.equal(result.reason, 'changed')
})

test('the action queue runs one action at a time, in order, and survives a failure', async () => {
  const queue = actionQueue()
  const log: string[] = []
  const step = (name: string, ms: number, fail = false) => async () => {
    log.push(`start ${name}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    log.push(`end ${name}`)
    if (fail) throw new Error(name)
    return name
  }
  const results = await Promise.allSettled([queue(step('a', 20, true)), queue(step('b', 1)), queue(step('c', 1))])
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'fulfilled', 'fulfilled'])
})

test('a plugin move refuses when the destination already has an override for it, and changes nothing', async () => {
  const deps = setup({ [BLOG_LOCAL]: json({ enabledPlugins: { 'b@m': false } }) })
  const v = await view(deps)
  const before = { ...deps.fs.files }
  for (const copy of [false, true]) {
    const answer = await run(deps, { type: 'move', key: find(v, 'plugins', 'b', SHOP).key, to: { project: BLOG, scope: 'local' }, copy }, v.versions)
    assert.equal(failed(answer).reason, 'exists')
    assert.deepEqual(deps.fs.files, before)
  }
})
