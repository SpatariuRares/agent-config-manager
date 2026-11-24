// Update sources in the view, the on-demand check, and the update actions, over in-memory doubles.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { CliResult, Http, HttpResult } from '../core/ports.ts'
import { fakeCli, fakeFs, paths, type FakeReplies } from '../core/test-support.ts'
import { buildView, runAction } from './backend.ts'
import { checkUpdates, fetchHttp } from './updates.ts'
import type { Action, ActionAnswer, Item, UpdatesAnswer, View } from './view.ts'

const SHOP = '/work/shop'
const INSTALLED = '/home/.claude/plugins/installed_plugins.json'
const LOCK = '/home/.agents/.skill-lock.json'
const MARKET = '/home/.claude/plugins/marketplaces/m'
const BACKUPS = '/home/.claude/backups/claude-config-manager'
const STAMP = '2026-11-24T10-00-00-000Z'
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

const installed = {
  version: 2,
  plugins: {
    'a@m': [{ scope: 'user', version: '1.0.0', gitCommitSha: 'c0ffee1' }],
    'b@m': [{ scope: 'user', gitCommitSha: 'b0b0b0b0b0b0b0b0' }],
    'c@ext': [{ scope: 'user', version: '2.0.0' }],
    'p@m': [{ scope: 'project', projectPath: SHOP, version: '1.0.0' }],
    'x@gone': [{ scope: 'user', version: '0.1.0' }]
  }
}
const lock = {
  version: 3,
  skills: {
    grill: { source: 'mattpocock/skills', sourceType: 'github', sourceUrl: 'https://github.com/mattpocock/skills.git', skillPath: 'skills/grill/SKILL.md', skillFolderHash: 'tree-grill' },
    tdd: { source: 'mattpocock/skills', sourceType: 'github', sourceUrl: 'https://github.com/mattpocock/skills.git', skillPath: 'skills/eng/tdd/SKILL.md', skillFolderHash: 'tree-tdd-old' },
    gsap: { source: 'greensock/gsap-skills', sourceType: 'github', sourceUrl: 'https://github.com/greensock/gsap-skills.git', skillPath: 'skills/gsap/SKILL.md', skillFolderHash: 'tree-gsap' }
  }
}
const userConfig = {
  mcpServers: {
    context7: { command: 'npx', args: ['-y', '--package=@upstash/context7-mcp@2.2.5', '--', 'context7-mcp'] },
    mem: { command: 'npx', args: ['-y', 'mem-mcp@1.4.0', '--flag', 'other@9.9.9'] },
    engram: { type: 'stdio', command: '/opt/homebrew/bin/engram', args: ['mcp'] },
    loose: { command: 'npx', args: ['-y', 'loose-mcp'] },
    py: { command: 'uvx', args: ['py-mcp@1.0.0'] },
    web: { type: 'http', url: 'https://web.example/mcp' }
  },
  projects: { [SHOP]: { mcpServers: { db: { command: 'npx', args: ['@scope/db-mcp@0.9.1'] } } } }
}

function setup(replies: FakeReplies = {}, extra: Record<string, string> = {}) {
  const fs = fakeFs(
    {
      '/home/.claude/settings.json': json({
        enabledPlugins: { 'a@m': true, 'b@m': true, 'c@ext': true, 'x@gone': true },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }
      }),
      '/home/.claude.json': JSON.stringify(userConfig),
      [INSTALLED]: JSON.stringify(installed),
      '/home/.claude/plugins/known_marketplaces.json': JSON.stringify({
        m: { source: { source: 'github', repo: 'owner/m' }, installLocation: MARKET },
        ext: { source: { source: 'directory', path: '/somewhere' }, installLocation: '/home/.claude/plugins/marketplaces/ext' }
      }),
      [`${MARKET}/.claude-plugin/marketplace.json`]: JSON.stringify({
        name: 'm',
        plugins: [
          { name: 'a', version: '1.10.0', source: './plugins/a' },
          { name: 'b', source: './plugins/b' },
          { name: 'p', version: '1.0.0', source: './plugins/p' }
        ]
      }),
      '/home/.claude/plugins/marketplaces/ext/.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'c', source: './c' }] }),
      [LOCK]: JSON.stringify(lock),
      '/home/.agents/skills/grill/SKILL.md': '---\nname: grill-me\n---\n',
      '/home/.claude/skills/tdd/SKILL.md': '---\nname: tdd\n---\n',
      '/home/.claude/skills/mine/SKILL.md': '---\nname: mine\n---\n',
      '/home/.claude/skills/gsap/SKILL.md': '---\nname: gsap\n---\n',
      '/home/.claude/agents/helper.md': 'helps',
      '/opt/homebrew/Cellar/engram/3.7.2/bin/engram': 'binary',
      [`${SHOP}/.claude/settings.json`]: json({ enabledPlugins: { 'p@m': true } }),
      [`${SHOP}/.mcp.json`]: json({ mcpServers: { team: { command: 'npx', args: ['--package', 'team-mcp@3.0.0', 'team'] } } }),
      ...extra
    },
    { '/home/.claude/skills/grill': '../../.agents/skills/grill', '/opt/homebrew/bin/engram': '../Cellar/engram/3.7.2/bin/engram' }
  )
  return { fs, cli: fakeCli([], replies), paths, clock: () => new Date('2026-11-24T10:00:00.000Z') }
}

/** Answers from a url -> result map, recording every url asked. */
function fakeHttp(answers: Record<string, HttpResult>): Http & { urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    async getJson(url) {
      urls.push(url)
      return answers[url] ?? { ok: false, status: 404, error: 'HTTP 404', rateLimited: false }
    }
  }
}
const okJson = (value: unknown): HttpResult => ({ ok: true, status: 200, json: value })
const TREE = (repo: string) => `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`
const NPM = (pkg: string) => `https://registry.npmjs.org/${pkg}/latest`

async function view(deps: ReturnType<typeof setup>): Promise<View> {
  const answer = await buildView(deps)
  assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
  return (answer as { ok: true; view: View }).view
}
const find = (v: View, kind: Item['kind'], name: string, project: string | null = null) => {
  const item = v.items.find((i) => i.kind === kind && i.name === name && i.project === project)
  assert.ok(item, `${kind} ${name} in ${project ?? 'global'}`)
  return item
}
async function run(deps: ReturnType<typeof setup> & { http?: Http }, action: Action): Promise<ActionAnswer> {
  return runAction(deps, { action, versions: (await view(deps)).versions })
}
const okResult = (answer: ActionAnswer) => {
  assert.equal(answer.result.ok, true, answer.result.message)
  return answer.result as { ok: true; message: string; undo?: Action }
}
const failed = (answer: ActionAnswer) => {
  assert.equal(answer.result.ok, false, answer.result.message)
  return answer.result as Extract<ActionAnswer['result'], { ok: false }>
}

// ---- update sources in the view (no network)

test('a plugin updates from its marketplace: current is its version, or its commit when it has no version', async () => {
  const v = await view(setup())
  assert.deepEqual(find(v, 'plugins', 'a').updateSource, { type: 'plugin', label: 'm', current: '1.0.0' })
  assert.deepEqual(find(v, 'plugins', 'b').updateSource, { type: 'plugin', label: 'm', current: 'b0b0b0b0b0b0b0b0' })
  // Installed only in a project: its project item carries the source.
  assert.deepEqual(find(v, 'plugins', 'p', SHOP).updateSource, { type: 'plugin', label: 'm', current: '1.0.0' })
})

test('a skill from the skills CLI is found by its real path or its name in ~/.agents/.skill-lock.json', async () => {
  const v = await view(setup())
  // A link into ~/.agents/skills, whose name (grill-me) differs from its lock entry (grill).
  assert.deepEqual(find(v, 'skills', 'grill-me').updateSource, { type: 'skills-cli', label: 'mattpocock/skills', current: 'tree-grill' })
  // A plain folder whose name is in the lock.
  assert.deepEqual(find(v, 'skills', 'tdd').updateSource, { type: 'skills-cli', label: 'mattpocock/skills', current: 'tree-tdd-old' })
  assert.equal(find(v, 'skills', 'mine').updateSource, undefined)
})

test('an MCP server launched from a pinned npm package updates from npm, in every argument form', async () => {
  const v = await view(setup())
  assert.deepEqual(find(v, 'mcp', 'context7').updateSource, { type: 'npm', label: '@upstash/context7-mcp', current: '2.2.5' })
  assert.deepEqual(find(v, 'mcp', 'mem').updateSource, { type: 'npm', label: 'mem-mcp', current: '1.4.0' })
  assert.deepEqual(find(v, 'mcp', 'db', SHOP).updateSource, { type: 'npm', label: '@scope/db-mcp', current: '0.9.1' })
  assert.deepEqual(find(v, 'mcp', 'team', SHOP).updateSource, { type: 'npm', label: 'team-mcp', current: '3.0.0' })
})

test('a Homebrew MCP binary is manual, with the brew command; unpinned, non-npm and remote servers have no source', async () => {
  const v = await view(setup())
  assert.deepEqual(find(v, 'mcp', 'engram').updateSource, {
    type: 'manual',
    label: 'Homebrew',
    current: '3.7.2',
    note: 'Managed by Homebrew: run `brew upgrade engram`.'
  })
  for (const name of ['loose', 'py', 'web']) assert.equal(find(v, 'mcp', name).updateSource, undefined, name)
})

test('agents and hooks have no update source', async () => {
  const v = await view(setup())
  assert.equal(find(v, 'agents', 'helper').updateSource, undefined)
  assert.equal(find(v, 'hooks', 'say done').updateSource, undefined)
})

// ---- the on-demand check

const keyOf = (v: View, kind: Item['kind'], name: string, project: string | null = null) => find(v, kind, name, project).key

test('skills: one GitHub tree call per repo, comparing the folder tree sha with the lock hash', async () => {
  const deps = setup()
  const http = fakeHttp({
    [TREE('mattpocock/skills')]: okJson({
      truncated: false,
      tree: [
        { path: 'skills/grill', type: 'tree', sha: 'tree-grill' },
        { path: 'skills/grill/SKILL.md', type: 'blob', sha: 'blob1' },
        { path: 'skills/eng/tdd', type: 'tree', sha: 'tree-tdd-new' }
      ]
    })
  })
  const answer = await checkUpdates({ ...deps, http })
  const v = await view(deps)
  assert.equal(http.urls.filter((url) => url === TREE('mattpocock/skills')).length, 1)
  assert.deepEqual(answer.statuses[keyOf(v, 'skills', 'grill-me')], { status: 'current', latest: 'tree-grill' })
  assert.deepEqual(answer.statuses[keyOf(v, 'skills', 'tdd')], { status: 'available', latest: 'tree-tdd-new' })
})

test('skills: a rate limit or failure makes them unknown and adds an error line', async () => {
  const deps = setup()
  const http = fakeHttp({
    [TREE('mattpocock/skills')]: { ok: false, status: 403, error: 'HTTP 403', rateLimited: true }
  })
  const answer = await checkUpdates({ ...deps, http })
  const v = await view(deps)
  const grill = answer.statuses[keyOf(v, 'skills', 'grill-me')]
  assert.equal(grill.status, 'unknown')
  assert.match(grill.note ?? '', /rate limit/)
  assert.ok(answer.errors.some((line) => /mattpocock\/skills/.test(line) && /rate limit/.test(line)), answer.errors.join('\n'))
  // greensock/gsap-skills answered 404 (not found) in this fake: unknown too, with its own line.
  assert.ok(answer.errors.some((line) => /greensock\/gsap-skills/.test(line) && /404/.test(line)), answer.errors.join('\n'))
})

test('npm: compares with the registry latest by semver, not by string', async () => {
  const deps = setup()
  const http = fakeHttp({
    [NPM('@upstash/context7-mcp')]: okJson({ version: '2.10.0' }),
    [NPM('mem-mcp')]: okJson({ version: '1.4.0' }),
    [NPM('team-mcp')]: okJson({ version: '2.9.9' })
  })
  const answer = await checkUpdates({ ...deps, http })
  const v = await view(deps)
  assert.deepEqual(answer.statuses[keyOf(v, 'mcp', 'context7')], { status: 'available', latest: '2.10.0' })
  assert.deepEqual(answer.statuses[keyOf(v, 'mcp', 'mem')], { status: 'current', latest: '1.4.0' })
  assert.deepEqual(answer.statuses[keyOf(v, 'mcp', 'team', SHOP)], { status: 'current', latest: '2.9.9' })
  const db = answer.statuses[keyOf(v, 'mcp', 'db', SHOP)]
  assert.equal(db.status, 'unknown')
  assert.ok(answer.errors.some((line) => line.includes('@scope/db-mcp')), answer.errors.join('\n'))
})

test('plugins: a marketplace version is compared with the installed one', async () => {
  const deps = setup()
  const answer = await checkUpdates({ ...deps, http: fakeHttp({}) })
  const v = await view(deps)
  assert.deepEqual(answer.statuses[keyOf(v, 'plugins', 'a')], { status: 'available', latest: '1.10.0' })
  assert.deepEqual(answer.statuses[keyOf(v, 'plugins', 'p', SHOP)], { status: 'current', latest: '1.0.0' })
})

test('plugins: without a version, the installed commit is compared with the git checkout for that plugin path', async () => {
  const head = 'f'.repeat(40)
  const trees: Record<string, string> = { [`b0b0b0b0b0b0b0b0:plugins/b`]: 'tree-old', [`HEAD:plugins/b`]: 'tree-new' }
  const git = (args: string[]): CliResult => ({ ok: true, output: [head, ...args.slice(2).map((rev) => trees[rev])].join('\n') })
  const deps = setup({ git })
  const answer = await checkUpdates({ ...deps, http: fakeHttp({}) })
  const v = await view(deps)
  assert.deepEqual(deps.cli.calls, [`git rev-parse HEAD b0b0b0b0b0b0b0b0:plugins/b HEAD:plugins/b @ ${MARKET}`])
  assert.deepEqual(answer.statuses[keyOf(v, 'plugins', 'b')], { status: 'available', latest: head.slice(0, 12) })

  trees['HEAD:plugins/b'] = 'tree-old'
  const same = await checkUpdates({ ...setup({ git }), http: fakeHttp({}) })
  assert.deepEqual(same.statuses[keyOf(v, 'plugins', 'b')], { status: 'current', latest: head.slice(0, 12) })
})

test('plugins: otherwise unknown, "checked when you update"', async () => {
  // git fails (the fake default), ext is not a git marketplace, and "gone" has no manifest.
  const deps = setup()
  const answer = await checkUpdates({ ...deps, http: fakeHttp({}) })
  const v = await view(deps)
  for (const name of ['b', 'c', 'x']) {
    assert.deepEqual(answer.statuses[keyOf(v, 'plugins', name)], { status: 'unknown', latest: null, note: 'checked when you update' }, name)
  }
  assert.ok(!deps.cli.calls.some((call) => call.includes('/marketplaces/ext')), 'no git in a directory marketplace')
})

test('manual sources are unknown with their note; items without a source get no status and no network call', async () => {
  const deps = setup()
  const http = fakeHttp({})
  const answer: UpdatesAnswer = await checkUpdates({ ...deps, http })
  const v = await view(deps)
  assert.deepEqual(answer.statuses[keyOf(v, 'mcp', 'engram')], {
    status: 'unknown',
    latest: null,
    note: 'Managed by Homebrew: run `brew upgrade engram`.'
  })
  for (const item of v.items.filter((i) => i.updateSource === undefined)) assert.equal(answer.statuses[item.key], undefined, item.key)
  assert.ok(http.urls.every((url) => url.startsWith('https://api.github.com/') || url.startsWith('https://registry.npmjs.org/')))
  assert.equal(answer.checkedAt, new Date('2026-11-24T10:00:00.000Z').getTime())
})

test('the real http port reads JSON, and reports rate limits and failures instead of throwing', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/ok') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"1.2.3"}')
    if (req.url === '/limited') return res.writeHead(403, { 'x-ratelimit-remaining': '0' }).end('{"message":"API rate limit exceeded"}')
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 500)
    res.writeHead(500).end('boom')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const http = fetchHttp(100)
    assert.deepEqual(await http.getJson(`${base}/ok`), { ok: true, status: 200, json: { version: '1.2.3' } })
    assert.deepEqual(await http.getJson(`${base}/limited`), { ok: false, status: 403, error: 'HTTP 403: rate limit reached', rateLimited: true })
    assert.deepEqual(await http.getJson(`${base}/fail`), { ok: false, status: 500, error: 'HTTP 500', rateLimited: false })
    const slow = await http.getJson(`${base}/slow`)
    assert.equal(slow.ok, false)
    assert.equal((slow as { status: number | null }).status, null)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

// ---- update actions

test('plugin update: runs claude plugin update without -y in the install folder, and reports the version change', async () => {
  const deps = setup({
    pluginUpdate: (id) => {
      const next = structuredClone(installed)
      if (id === 'p@m') next.plugins['p@m'][0].version = '1.1.0'
      deps.fs.files[INSTALLED] = JSON.stringify(next)
      return { ok: true, output: '{"ok":true}' }
    }
  })
  const v = await view(deps)
  const result = okResult(await run(deps, { type: 'update', key: keyOf(v, 'plugins', 'p', SHOP) }))
  assert.deepEqual(deps.cli.calls, [`plugin update p@m --scope project --json @ ${SHOP}`])
  assert.match(result.message, /Updated plugin "p" from 1\.0\.0 to 1\.1\.0\./)
  assert.match(result.message, /Restart Claude Code/)
})

test('plugin update: a command that needs approval is never accepted on its own; the panel gets it to confirm', async () => {
  const shown = { ok: false, error: 'needs-confirmation', shownCommand: { command: 'curl -s https://x.example/key', sha256: 'abc123' } }
  const deps = setup({ pluginUpdate: () => ({ ok: false, output: `${JSON.stringify(shown)}\n` }) })
  const v = await view(deps)
  const key = keyOf(v, 'plugins', 'a')
  const result = failed(await run(deps, { type: 'update', key }))
  assert.equal(result.reason, 'needs-confirmation')
  assert.deepEqual(result.confirm, { command: 'curl -s https://x.example/key', action: { type: 'update', key, acceptCommand: 'abc123' } })
  assert.ok(deps.cli.calls.every((call) => !/ -y\b|--accept-command/.test(call)), deps.cli.calls.join('\n'))
})

test('plugin update: with acceptCommand, passes --accept-command with that sha', async () => {
  const deps = setup()
  const v = await view(deps)
  const result = okResult(await run(deps, { type: 'update', key: keyOf(v, 'plugins', 'a'), acceptCommand: 'abc123' }))
  assert.deepEqual(deps.cli.calls, ['plugin update a@m --scope user --json --accept-command abc123 @ -'])
  assert.match(result.message, /plugin "a" is already at 1\.0\.0/i)
})

test('plugin update: a CLI failure is reported with its output', async () => {
  const deps = setup({ pluginUpdate: () => ({ ok: false, output: 'network down' }) })
  const v = await view(deps)
  const result = failed(await run(deps, { type: 'update', key: keyOf(v, 'plugins', 'a') }))
  assert.equal(result.reason, 'cli-failed')
  assert.match(result.message, /network down/)
})

test('skill update: runs npx skills update globally and reports the new content hash', async () => {
  const deps = setup({
    skillsUpdate: () => {
      const next = structuredClone(lock)
      next.skills.tdd.skillFolderHash = 'tree-tdd-new'
      deps.fs.files[LOCK] = JSON.stringify(next)
      return { ok: true, output: 'Updated 1 skill' }
    }
  })
  const v = await view(deps)
  const result = okResult(await run(deps, { type: 'update', key: keyOf(v, 'skills', 'tdd') }))
  assert.deepEqual(deps.cli.calls, ['npx -y skills update tdd -g -y'])
  assert.match(result.message, /Updated skill "tdd" from mattpocock\/skills/)
})

test('npm MCP update: backs up, then removes and re-adds the server with the latest pinned version in its scope', async () => {
  const deps = { ...setup(), http: fakeHttp({ [NPM('team-mcp')]: okJson({ version: '3.1.0' }) }) }
  const v = await view(deps)
  const mcp = deps.fs.files[`${SHOP}/.mcp.json`]
  const result = okResult(await run(deps, { type: 'update', key: keyOf(v, 'mcp', 'team', SHOP) }))
  assert.deepEqual(deps.cli.calls, [
    `mcp remove team --scope project @ ${SHOP}`,
    `mcp add-json team {"command":"npx","args":["--package","team-mcp@3.1.0","team"]} --scope project @ ${SHOP}`
  ])
  assert.equal(deps.fs.files[`${BACKUPS}/${encodeURIComponent(`${SHOP}/.mcp.json`)}.${STAMP}.json`], mcp)
  assert.match(result.message, /Updated MCP server "team" from team-mcp@3\.0\.0 to 3\.1\.0/)
})

test('npm MCP update: the --package= form keeps its shape; a failed re-add is reported as partial', async () => {
  const deps = { ...setup(), http: fakeHttp({ [NPM('@upstash/context7-mcp')]: okJson({ version: '2.3.0' }) }) }
  deps.cli = fakeCli(['mcp-add:user'])
  const v = await view(deps)
  const result = failed(await run(deps, { type: 'update', key: keyOf(v, 'mcp', 'context7') }))
  assert.deepEqual(deps.cli.calls, [
    'mcp remove context7 --scope user @ -',
    'mcp add-json context7 {"command":"npx","args":["-y","--package=@upstash/context7-mcp@2.3.0","--","context7-mcp"]} --scope user @ -'
  ])
  assert.equal(result.reason, 'partial')
  assert.match(result.message, /Removed MCP server "context7".*but adding it back.*failed/s)
  assert.equal(deps.fs.files[`${BACKUPS}/${encodeURIComponent('/home/.claude.json')}.${STAMP}.json`], JSON.stringify(userConfig))
})

test('npm MCP update: already at the latest version changes nothing', async () => {
  const deps = { ...setup(), http: fakeHttp({ [NPM('mem-mcp')]: okJson({ version: '1.4.0' }) }) }
  const v = await view(deps)
  const result = okResult(await run(deps, { type: 'update', key: keyOf(v, 'mcp', 'mem') }))
  assert.deepEqual(deps.cli.calls, [])
  assert.match(result.message, /already at the latest version \(1\.4\.0\)/)
})

test('manual sources and items without a source are refused as unsupported', async () => {
  const deps = setup()
  const v = await view(deps)
  const brew = failed(await run(deps, { type: 'update', key: keyOf(v, 'mcp', 'engram') }))
  assert.equal(brew.reason, 'unsupported')
  assert.match(brew.message, /brew upgrade engram/)
  const agent = failed(await run(deps, { type: 'update', key: keyOf(v, 'agents', 'helper') }))
  assert.equal(agent.reason, 'unsupported')
  assert.deepEqual(deps.cli.calls, [])
})

test('update all: updates each key in turn, skips the ones that need confirmation, and lists every outcome', async () => {
  const shown = { shownCommand: { command: 'run-me', sha256: 'feed' } }
  const deps = setup({ pluginUpdate: (id) => (id === 'b@m' ? { ok: false, output: JSON.stringify(shown) } : { ok: true, output: '' }) })
  const v = await view(deps)
  const keys = [keyOf(v, 'plugins', 'a'), keyOf(v, 'plugins', 'b'), keyOf(v, 'plugins', 'c')]
  const result = failed(await run(deps, { type: 'updateAll', kind: 'plugins', keys }))
  assert.deepEqual(deps.cli.calls, [
    'plugin update a@m --scope user --json @ -',
    'plugin update b@m --scope user --json @ -',
    'plugin update c@ext --scope user --json @ -'
  ])
  assert.equal(result.reason, 'partial')
  assert.equal(result.confirm, undefined)
  assert.match(result.message, /^Updated 2 of 3:/)
  assert.match(result.message, /plugin "a" is already at 1\.0\.0/i)
  assert.match(result.message, /plugin "b".*needs your approval.*skipped/is)
  assert.match(result.message, /plugin "c" is already at 2\.0\.0/i)
})

test('refresh marketplaces runs claude plugin marketplace update', async () => {
  const deps = setup()
  const result = okResult(await run(deps, { type: 'refreshMarketplaces' }))
  assert.deepEqual(deps.cli.calls, ['plugin marketplace update'])
  assert.match(result.message, /marketplaces/i)
})
