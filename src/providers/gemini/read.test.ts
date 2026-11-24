// What the Gemini CLI provider reads: each class, globally and per project, without secrets or Antigravity files.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ENABLEMENT,
  files,
  GEMINI,
  HOME,
  itemOf,
  machine,
  MCP_ENABLEMENT,
  SECRETS,
  SHOP,
  SHOP_SETTINGS,
  USER_SETTINGS,
  viewOf
} from './test-support.ts'

const names = (items: { name: string }[]) => items.map((item) => item.name).sort()

test('extensions are plugins: name, version, what they contribute, enabled from extension-enablement.json', async () => {
  const view = await viewOf(machine().deps)
  const obsidian = itemOf(view, 'plugins', 'obsidian')
  assert.equal(obsidian.agent, 'gemini')
  assert.equal(obsidian.scope, 'user')
  assert.equal(obsidian.description, 'Obsidian vault tools')
  assert.equal(obsidian.source, `${GEMINI}/extensions/obsidian`)
  assert.deepEqual(obsidian.plugin, {
    id: 'obsidian',
    enabled: true,
    version: '1.1.0',
    contributes: {
      skills: ['obsidian-companion'],
      agents: ['librarian'],
      commands: ['daily', 'obsidian:search'],
      hooks: ['SessionStart'],
      mcpServers: ['obsidian-mcp']
    },
    sharesNameWith: [],
    installed: true,
    installs: [{ scope: 'user', project: null }]
  })
  assert.deepEqual(obsidian.updateSource, { type: 'plugin', label: 'https://github.com/someone/gemini-obsidian', current: '1.1.0' })
  const local = itemOf(view, 'plugins', 'local-ext')
  assert.equal(local.plugin?.enabled, false, '!~/* turns it off for the user scope')
  assert.equal(local.updateSource, undefined, 'a local extension has no update source')
})

test('an extension rule for a known project shows as that project’s override', async () => {
  const view = await viewOf(machine().deps)
  const shop = itemOf(view, 'plugins', 'obsidian', SHOP)
  assert.equal(shop.scope, 'project')
  assert.equal(shop.source, ENABLEMENT)
  assert.equal(shop.plugin?.enabled, false)
  assert.equal(shop.plugin?.installed, false)
  assert.equal(view.items.filter((item) => item.kind === 'plugins' && item.project !== null).length, 1)
})

test('skills come from ~/.gemini/skills and ~/.agents/skills, per project too; skills.disabled marks them off', async () => {
  const view = await viewOf(machine().deps)
  const skills = view.items.filter((item) => item.kind === 'skills')
  assert.deepEqual(names(skills.filter((item) => item.project === null)), ['review', 'shared'])
  assert.deepEqual(names(skills.filter((item) => item.project === SHOP)), ['deploy'])
  assert.match(itemOf(view, 'skills', 'review').description, /^Reviews code · Off/, 'names match without case')
  assert.equal(itemOf(view, 'skills', 'shared').description, 'Shared skill')
  assert.equal(itemOf(view, 'skills', 'shared').source, `${HOME}/.agents/skills/shared`)
  assert.match(itemOf(view, 'skills', 'deploy', SHOP).description, /Off/)
  assert.equal(itemOf(view, 'skills', 'deploy', SHOP).scope, 'project')
})

test('agents come from ~/.gemini/agents/*.md and the project’s .gemini/agents, skipping _files; overrides mark them off', async () => {
  const view = await viewOf(machine().deps)
  const agents = view.items.filter((item) => item.kind === 'agents')
  assert.deepEqual(names(agents), ['planner', 'reviewer'])
  assert.match(itemOf(view, 'agents', 'planner').description, /^Plans work · Off/)
  assert.equal(itemOf(view, 'agents', 'reviewer', SHOP).description, 'Reviews PRs')
})

test('MCP servers come from settings.json mcpServers, globally and per project, with their transport and off state', async () => {
  const view = await viewOf(machine().deps)
  const mcp = view.items.filter((item) => item.kind === 'mcp')
  assert.deepEqual(names(mcp.filter((item) => item.project === null)), ['blocked', 'context7', 'remote', 'secretive', 'vercel'])
  assert.deepEqual(names(mcp.filter((item) => item.project === SHOP)), ['db'])
  assert.deepEqual(itemOf(view, 'mcp', 'context7').mcp, { transport: 'stdio', target: 'npx -y @upstash/context7-mcp@2.2.5' })
  assert.match(itemOf(view, 'mcp', 'context7').description, /Off \(gemini mcp disable\)/)
  assert.match(itemOf(view, 'mcp', 'blocked').description, /Off \(mcp\.excluded\)/)
  assert.equal(itemOf(view, 'mcp', 'vercel').mcp?.transport, 'http')
  assert.equal(itemOf(view, 'mcp', 'remote').mcp?.transport, 'http', 'a url without a type is streamable HTTP')
  assert.equal(itemOf(view, 'mcp', 'db', SHOP).source, SHOP_SETTINGS)
  assert.equal(itemOf(view, 'mcp', 'db', SHOP).scope, 'project')
  assert.ok(!mcp.some((item) => item.name === 'obsidian-mcp'), 'an extension’s server is listed under the extension')
})

test('hooks come from settings.json hooks, globally and per project; hooksConfig.disabled marks them off', async () => {
  const view = await viewOf(machine().deps)
  const hooks = view.items.filter((item) => item.kind === 'hooks')
  assert.equal(hooks.length, 3)
  const greeter = itemOf(view, 'hooks', 'greeter')
  assert.deepEqual(greeter.hook, { event: 'BeforeTool', matcher: 'run_shell_command', command: 'echo hi' })
  assert.match(greeter.description, /^BeforeTool · run_shell_command · Off/)
  const lint = hooks.find((item) => item.project === SHOP)!
  assert.deepEqual(lint.hook, { event: 'AfterTool', matcher: '*', command: 'npm run lint' })
})

test('projects are the folders in ~/.gemini/projects.json that still exist, without the home folder', async () => {
  const view = await viewOf(machine().deps)
  assert.deepEqual(view.projects, [SHOP])
  for (const file of [USER_SETTINGS, SHOP_SETTINGS, ENABLEMENT, MCP_ENABLEMENT]) assert.equal(typeof view.versions[file], 'string', file)
  assert.notEqual(view.versions[USER_SETTINGS], '')
})

test('no secret reaches an item: env values, headers, keys in args, tokens in URLs and commands are redacted', async () => {
  const view = await viewOf(machine().deps)
  const text = JSON.stringify(view.items)
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `"${secret}" shows in an item`)
  assert.equal(itemOf(view, 'mcp', 'secretive').mcp?.target, 'node server.js --api-key <redacted>')
  assert.equal(itemOf(view, 'mcp', 'vercel').mcp?.target, 'https://mcp.vercel.com/mcp?token=<redacted>')
  assert.equal(itemOf(view, 'mcp', 'remote').mcp?.target, 'https://example.com/sse')
  const notify = view.items.find((item) => item.kind === 'hooks' && item.hook?.event === 'SessionStart')!
  assert.equal(notify.hook?.command, 'GITHUB_TOKEN=<redacted> notify')
})

test('credential, history and log files are never read, and Antigravity’s ~/.gemini/config is ignored', async () => {
  const { deps, reads } = machine()
  const view = await viewOf(deps)
  const forbidden = [`${GEMINI}/.env`, `${GEMINI}/oauth_creds.json`, `${GEMINI}/google_accounts.json`, `${GEMINI}/history`, `${GEMINI}/logs`, `${GEMINI}/config`, '/.env']
  for (const path of reads) {
    for (const bad of forbidden) assert.ok(!path.startsWith(bad) && !path.endsWith('/.env'), `read ${path}`)
  }
  assert.ok(!view.items.some((item) => item.name === 'antigravity' || item.name === 'jd-judge'))
})

test('a malformed settings file is reported in problems, and everything else still reads', async () => {
  const broken = { ...files(), [`${GEMINI}/settings.json`]: '{ "mcpServers": ', [SHOP_SETTINGS]: '[]' }
  const view = await viewOf(machine({ files: broken }).deps)
  assert.ok(view.problems.some((problem) => problem.startsWith(`${GEMINI}/settings.json:`)), view.problems.join('\n'))
  assert.ok(view.problems.some((problem) => problem.startsWith(`${SHOP_SETTINGS}:`)), view.problems.join('\n'))
  assert.ok(!view.items.some((item) => item.kind === 'mcp'))
  assert.ok(view.items.some((item) => item.kind === 'plugins'))
  assert.ok(view.items.some((item) => item.kind === 'skills'))
})

test('a broken extension manifest or enablement file is a problem, not a failure', async () => {
  const broken = { ...files(), [`${GEMINI}/extensions/local-ext/gemini-extension.json`]: 'nope', [ENABLEMENT]: '{' }
  const view = await viewOf(machine({ files: broken }).deps)
  assert.ok(view.problems.some((problem) => problem.includes('local-ext/gemini-extension.json')), view.problems.join('\n'))
  assert.ok(view.problems.some((problem) => problem.startsWith(`${ENABLEMENT}:`)), view.problems.join('\n'))
  assert.equal(itemOf(view, 'plugins', 'obsidian').plugin?.enabled, true, 'no rules: enabled everywhere')
})

test('B1: a malformed settings, projects or MCP enablement file is reported without quoting its content', async () => {
  const leaky = '// a comment that shifts nothing\n{ "mcpServers": { "x": { "args": ["ghp_SECRETVALUE123"] '
  const broken = { ...files(), [USER_SETTINGS]: leaky, [`${GEMINI}/projects.json`]: '{"projects": ghp_SECRETVALUE123', [MCP_ENABLEMENT]: '{ SECRET' }
  const view = await viewOf(machine({ files: broken }).deps)
  for (const file of [USER_SETTINGS, `${GEMINI}/projects.json`, MCP_ENABLEMENT]) {
    const problem = view.problems.find((line) => line.startsWith(`${file}:`))
    assert.ok(problem, `${file} in ${view.problems.join('\n')}`)
    assert.match(problem, /not valid JSON/)
  }
  assert.doesNotMatch(view.problems.join('\n'), /ghp_|SECRET/)
})

test('A4: a project that is a link to the home folder is not a project, so global items are not listed twice', async () => {
  const fixture = { ...files(), [`${GEMINI}/projects.json`]: JSON.stringify({ projects: { [SHOP]: 'shop', '/link': 'me' } }) }
  const m = machine({ files: fixture })
  m.fs.links['/link'] = HOME
  const view = await viewOf(m.deps)
  assert.deepEqual(view.projects, [SHOP])
  assert.ok(!view.items.some((item) => item.project === '/link'))
})
