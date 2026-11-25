// Codex against the provider contract, plus one test per rule of its reads and writes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, ActionResult, Item, View } from '../../adapters/view.ts'
import { routeAction, routeView } from '../router.ts'
import { fakeExec, fakeFs, providerContract } from '../testing.ts'
import { itemKey, type ProviderDeps } from '../types.ts'
import { CODEX_PROJECT_SCOPES, CODEX_SUPPORTS, codexProvider } from './index.ts'

const HOME = '/home'
const CONFIG = '/home/.codex/config.toml'
const HOOKS = '/home/.codex/hooks.json'
const SHOP = '/work/shop'
const BACKUPS = '/home/.config/agent-config-manager/backups/codex'
const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')

// Shaped like a real ~/.codex/config.toml (codex-cli 0.171.0), with comments added by hand.
const CONFIG_TOML = `# Codex user config. Comments must survive: this app never rewrites this file.
model = "gpt-6.1-terra" # inline comment
model_reasoning_effort = "medium"

[marketplaces.engram]
source_type = "git"
source = "https://github.com/Gentleman-Programming/engram.git" # a # inside a comment
ref = "main"

[plugins."engram@engram"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = false

[agents]
max_depth = 2
max_threads = 4
enabled = true

# A role whose settings live in a file next to this config.
[agents.reviewer]
description = "Reviews diffs # not a comment"
config_file = "agents/reviewer.toml"

[mcp_servers.codegraph]
command = "codegraph"
args = ["serve", "--mcp"]

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.context7.http_headers]
Authorization = "Bearer secret-value"

[mcp_servers.off]
command = "npx"
args = ["-y", "off-mcp"]
enabled = false

[projects."/work/shop"]
trust_level = "trusted"

[projects."/home"]
trust_level = "trusted"

[projects."/gone/project"]
trust_level = "trusted"

[hooks.state."/home/.codex/hooks.json:session_start:0:0"]
enabled = false
trusted_hash = "sha256:abc"
`

const HOOKS_JSON =
  JSON.stringify(
    {
      hooks: {
        SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'gentle-ai refresh', timeout: 30, statusMessage: 'Refreshing' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'notify-done', async: true }] }]
      }
    },
    null,
    2
  ) + '\n'

const FILES: Record<string, string> = {
  [CONFIG]: CONFIG_TOML,
  [HOOKS]: HOOKS_JSON,
  '/home/.codex/skills/review/SKILL.md': '---\nname: review\ndescription: Reviews code\n---\n',
  '/home/.codex/skills/.system/imagegen/SKILL.md': '---\nname: imagegen\n---\n',
  '/home/.codex/skills/_shared/README.md': 'not a skill',
  '/home/.agents/skills/notes/SKILL.md': '---\nname: notes\ndescription: Takes notes\n---\n',
  '/home/.codex/agents/reviewer.toml': 'name = "reviewer"\ndescription = "Role file"\ndeveloper_instructions = "Review."\n',
  '/home/.codex/agents/explorer.toml': '# a custom agent\nname = "pr_explorer"\ndescription = "Read-only explorer"\ndeveloper_instructions = """\nExplore.\n"""\n',
  '/home/.codex/plugins/cache/engram/engram/0.1.5/.codex-plugin/plugin.json': JSON.stringify({
    name: 'engram',
    displayName: 'Engram Persistent Memory',
    version: '0.1.5',
    description: 'Persistent memory.',
    hooks: './hooks/hooks.json',
    skills: './skills/'
  }),
  '/home/.codex/plugins/cache/engram/engram/0.1.5/hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [], Stop: [] } }),
  '/home/.codex/plugins/cache/engram/engram/0.1.5/skills/memory/SKILL.md': '---\nname: memory\n---\n',
  '/home/.codex/plugins/cache/engram/engram/0.1.0/.codex-plugin/plugin.json': JSON.stringify({ name: 'engram', version: '0.1.0' }),
  // A project Codex knows: its own skills, agents, MCP servers and hooks.
  [`${SHOP}/README.md`]: 'shop',
  [`${SHOP}/.agents/skills/deploy/SKILL.md`]: '---\nname: deploy\ndescription: Ships it\n---\n',
  [`${SHOP}/.codex/skills/lint/SKILL.md`]: '---\nname: lint\n---\n',
  [`${SHOP}/.codex/agents/tester.toml`]: 'name = "tester"\ndescription = "Runs tests"\ndeveloper_instructions = "Test."\n',
  [`${SHOP}/.codex/config.toml`]: '# project config\n[mcp_servers.shop-db]\ncommand = "shop-db"\nargs = ["--readonly"]\n\n[mcp_servers.shop-env]\ncommand = "x"\nenv = { TOKEN = "t" }\n',
  [`${SHOP}/.codex/hooks.json`]: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] } })
}

const COMMANDS = { codex: '/usr/local/bin/codex' }

providerContract(codexProvider(), {
  home: HOME,
  files: FILES,
  commands: COMMANDS,
  write: {
    // Removing an agent file: version check, then the file goes to the restorable trash.
    action: (view) => ({ type: 'remove', key: view.items.find((item) => item.source === '/home/.codex/agents/explorer.toml')!.key }),
    file: '/home/.codex/agents/explorer.toml'
  }
})

/** A machine over FILES; `reply` plays the codex CLI (it may change files, as the real one would). */
function machine(options: { files?: Record<string, string>; reply?: NonNullable<Parameters<typeof fakeExec>[0]>['reply'] } = {}) {
  const fs = fakeFs(structuredClone(options.files ?? FILES))
  const writes: string[] = []
  const writeText = fs.writeText.bind(fs)
  fs.writeText = async (path, text) => {
    writes.push(path)
    await writeText(path, text)
  }
  const exec = fakeExec({ commands: COMMANDS, reply: options.reply })
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: CLOCK }
  return { fs, exec, deps, writes }
}

const provider = codexProvider()

async function viewOf(deps: ProviderDeps): Promise<View> {
  const answer = await routeView(deps, [provider], { agent: 'codex' })
  assert.ok(answer.ok, answer.ok ? '' : answer.error)
  return answer.view
}

const named = (view: View, kind: Item['kind'], name: string, project: string | null = null) => {
  const item = view.items.find((candidate) => candidate.kind === kind && candidate.name === name && candidate.project === project)
  assert.ok(item, `${kind} ${name} in ${project ?? 'global'}`)
  return item
}

async function act(deps: ProviderDeps, view: View, action: Action) {
  return routeAction(deps, [provider], { agent: 'codex', action, versions: view.versions })
}

test('Codex info: id, name, config home, all five classes, what works, and a note on what does not', async () => {
  const info = await provider.info(machine().deps)
  assert.deepEqual(
    { ...info, note: undefined },
    { id: 'codex', name: 'Codex', detected: true, kinds: ['plugins', 'skills', 'agents', 'mcp', 'hooks'], supports: CODEX_SUPPORTS, projectScopes: CODEX_PROJECT_SCOPES, configHome: '~/.codex', note: undefined }
  )
  assert.match(info.note ?? '', /Plugins and hooks are read-only/)
  assert.equal(info.supports.plugins, undefined)
  assert.equal(info.supports.hooks, undefined)
})

test('Codex is detected from its binary on PATH alone, or from ~/.codex alone', async () => {
  const onPath = await provider.info({ fs: fakeFs({}), exec: fakeExec({ commands: COMMANDS }), home: HOME })
  assert.equal(onPath.detected, true)
  const folder = await provider.info({ fs: fakeFs({ [CONFIG]: '' }), exec: fakeExec(), home: HOME })
  assert.equal(folder.detected, true)
})

test('Codex plugins: [plugins."id@market"] with enabled, the active cached version and what it contributes', async () => {
  const view = await viewOf(machine().deps)
  const engram = view.items.find((item) => item.key === itemKey('plugins', 'engram@engram'))!
  assert.equal(engram.name, 'Engram Persistent Memory')
  assert.equal(engram.description, 'Persistent memory.')
  assert.deepEqual(engram.plugin, {
    id: 'engram@engram',
    enabled: true,
    version: '0.1.5',
    contributes: { skills: ['memory'], agents: [], commands: [], hooks: ['SessionStart', 'Stop'], mcpServers: [] },
    sharesNameWith: [],
    installed: true,
    installs: [{ scope: 'user', project: null }]
  })
  const browser = view.items.find((item) => item.key === itemKey('plugins', 'browser@openai-bundled'))!
  assert.equal(browser.plugin?.enabled, false)
  assert.equal(browser.plugin?.installed, false)
  assert.equal(view.items.filter((item) => item.kind === 'plugins').length, 2, 'marketplaces are not plugins')
})

test('Codex skills: both user folders, SKILL.md only, not .system or _shared', async () => {
  const view = await viewOf(machine().deps)
  const global = view.items.filter((item) => item.kind === 'skills' && item.project === null)
  assert.deepEqual(global.map((item) => [item.name, item.source]).sort(), [
    ['notes', '/home/.agents/skills/notes/SKILL.md'],
    ['review', '/home/.codex/skills/review/SKILL.md']
  ])
  assert.equal(named(view, 'skills', 'review').description, 'Reviews code')
  assert.equal(named(view, 'skills', 'review').key, itemKey('skills', '/home/.codex/skills/review'))
})

test('Codex agents: TOML files by their name field, and [agents.<role>] tables, not scalar settings', async () => {
  const view = await viewOf(machine().deps)
  const explorer = named(view, 'agents', 'pr_explorer')
  assert.equal(explorer.description, 'Read-only explorer')
  assert.equal(explorer.movable && explorer.removable, true)
  // reviewer.toml is the config_file of [agents.reviewer]: moving it would break the role.
  const file = view.items.find((item) => item.source === '/home/.codex/agents/reviewer.toml')!
  assert.equal(file.movable, false)
  assert.equal(file.removable, false)
  assert.match(file.notMovableReason ?? '', /\[agents\.reviewer\]/)
  const role = view.items.find((item) => item.key === itemKey('agents', CONFIG, 'reviewer'))!
  assert.equal(role.description, 'Reviews diffs # not a comment Settings: agents/reviewer.toml.')
  assert.equal(role.movable || role.removable, false)
  assert.ok(!view.items.some((item) => item.kind === 'agents' && ['max_depth', 'max_threads', 'enabled'].includes(item.name)))
})

test('Codex MCP servers: stdio and http from [mcp_servers.*], never their headers or env', async () => {
  const view = await viewOf(machine().deps)
  const codegraph = named(view, 'mcp', 'codegraph')
  assert.deepEqual(codegraph.mcp, { transport: 'stdio', target: 'codegraph serve --mcp' })
  assert.equal(codegraph.key, itemKey('mcp', CONFIG, 'codegraph'))
  assert.equal(codegraph.removable, true)
  assert.equal(codegraph.movable, false)
  assert.deepEqual(named(view, 'mcp', 'context7').mcp, { transport: 'http', target: 'https://mcp.context7.com/mcp' })
  assert.match(named(view, 'mcp', 'off').description, /enabled = false/)
  assert.ok(!JSON.stringify(view.items).includes('secret-value'), 'a header value reached the view')
})

test('Codex hooks: every handler of hooks.json with event, matcher and command, read-only', async () => {
  const view = await viewOf(machine().deps)
  const hooks = view.items.filter((item) => item.kind === 'hooks' && item.project === null)
  assert.deepEqual(
    hooks.map((item) => item.hook),
    [
      { event: 'SessionStart', matcher: 'startup|resume', command: 'gentle-ai refresh' },
      { event: 'Stop', matcher: '', command: 'notify-done' }
    ]
  )
  assert.equal(hooks[0].key, itemKey('hooks', HOOKS, 'SessionStart', 0, 0))
  assert.match(hooks[0].description, /turned off in \/hooks/)
  assert.ok(hooks.every((item) => !item.movable && !item.removable))
  assert.ok(!view.items.some((item) => item.kind === 'hooks' && item.name === 'state'), '[hooks.state] is not a hook')
})

test('Codex project scope: projects from config.toml that exist, minus home; their skills, agents, MCP and hooks', async () => {
  const view = await viewOf(machine().deps)
  assert.deepEqual(view.projects, [SHOP])
  const inShop = view.items.filter((item) => item.project === SHOP)
  assert.deepEqual(inShop.map((item) => `${item.kind}:${item.name}`).sort(), [
    'agents:tester',
    'hooks:guard.sh',
    'mcp:shop-db',
    'mcp:shop-env',
    'skills:deploy',
    'skills:lint'
  ])
  assert.ok(inShop.every((item) => item.scope === 'project'))
  assert.equal(named(view, 'mcp', 'shop-db', SHOP).movable, true)
  assert.equal(named(view, 'mcp', 'shop-db', SHOP).removable, false)
  assert.equal(named(view, 'mcp', 'shop-env', SHOP).movable, false)
  assert.match(named(view, 'mcp', 'shop-env', SHOP).notMovableReason ?? '', /env/)
})

test('TOML with comments is read correctly: values, and # inside strings', async () => {
  const view = await viewOf(machine().deps)
  assert.deepEqual(view.problems, [])
  const role = view.items.find((item) => item.key === itemKey('agents', CONFIG, 'reviewer'))!
  assert.equal(role.description, 'Reviews diffs # not a comment Settings: agents/reviewer.toml.')
  assert.deepEqual(named(view, 'mcp', 'codegraph').mcp, { transport: 'stdio', target: 'codegraph serve --mcp' })
  assert.equal(named(view, 'agents', 'pr_explorer').description, 'Read-only explorer')
})

test('malformed TOML is reported in problems and does not crash; the other files still show', async () => {
  const files = { ...FILES, [CONFIG]: '[mcp_servers.broken\ncommand = "x"\n', '/home/.codex/agents/explorer.toml': 'name = \n' }
  const view = await viewOf(machine({ files }).deps)
  assert.equal(view.problems.length, 2, view.problems.join('\n'))
  assert.match(view.problems[0], /^~\/\.codex\/config\.toml is not valid TOML/)
  assert.match(view.problems[1], /explorer\.toml is not valid TOML/)
  assert.ok(view.items.some((item) => item.kind === 'skills'), 'skills still show')
  assert.ok(view.items.some((item) => item.kind === 'hooks'), 'hooks.json still shows')
  assert.ok(view.items.some((item) => item.source === '/home/.codex/agents/explorer.toml'), 'the broken agent file is still listed')
})

test('MCP remove runs `codex mcp remove NAME` by argv, after backing up config.toml', async () => {
  const seen: string[][] = []
  const m = machine({
    reply: (_command, argv) => {
      // The backup must exist before the CLI touches config.toml.
      seen.push(Object.keys(m.fs.files).filter((path) => path.startsWith(`${BACKUPS}/config.`)))
      m.fs.files[CONFIG] = m.fs.files[CONFIG].replace('[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n', '')
      return { ok: true, output: `Removed global MCP server '${argv[2]}'.` }
    }
  })
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, view, { type: 'remove', key: named(view, 'mcp', 'codegraph').key })
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, ['codex mcp remove codegraph @ -'])
  assert.deepEqual(seen, [[`${BACKUPS}/config.2026-11-24T10-00-00-000Z.json`]])
  assert.equal(m.fs.files[`${BACKUPS}/config.2026-11-24T10-00-00-000Z.json`], CONFIG_TOML)
  assert.ok(answer.view.ok && !answer.view.view.items.some((item) => item.name === 'codegraph'))
})

test('MCP remove returns an undo that adds the same server back with `codex mcp add`, from the backed-up config.toml', async () => {
  const entry = '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n'
  const m = machine({
    reply: (_command, argv) => {
      if (argv[1] === 'remove') m.fs.files[CONFIG] = m.fs.files[CONFIG].replace(entry, '')
      else m.fs.files[CONFIG] += `\n${entry}`
      return { ok: true, output: '' }
    }
  })
  const view = await viewOf(m.deps)
  const removed = await act(m.deps, view, { type: 'remove', key: named(view, 'mcp', 'codegraph').key })
  assert.equal(removed.result.ok, true, removed.result.message)
  const backup = `${BACKUPS}/config.2026-11-24T10-00-00-000Z.json`
  const undo = (removed.result as ActionResult & { ok: true }).undo
  assert.deepEqual(undo, { type: 'move', key: itemKey('mcp', backup, 'codegraph'), to: { project: null }, copy: true })
  assert.ok(removed.view.ok)

  const again = await act(m.deps, removed.view.view, undo!)
  assert.equal(again.result.ok, true, again.result.message)
  assert.deepEqual(m.exec.calls, ['codex mcp remove codegraph @ -', 'codex mcp add codegraph -- codegraph serve --mcp @ -'])
  assert.match(again.result.message, /Added MCP server "codegraph" back to ~\/\.codex\/config\.toml with codex mcp add/)
  assert.deepEqual((again.result as ActionResult & { ok: true }).undo, { type: 'remove', key: itemKey('mcp', CONFIG, 'codegraph') })
  assert.ok(again.view.ok && again.view.view.items.some((item) => item.name === 'codegraph' && item.project === null))
})

test('MCP remove keeps no undo, and says why, when `codex mcp add` cannot recreate the server', async () => {
  const blocks: Record<string, string> = {
    context7: '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n\n[mcp_servers.context7.http_headers]\nAuthorization = "Bearer secret-value"\n\n',
    off: '[mcp_servers.off]\ncommand = "npx"\nargs = ["-y", "off-mcp"]\nenabled = false\n\n'
  }
  const m = machine({
    reply: (_command, argv) => {
      m.fs.files[CONFIG] = m.fs.files[CONFIG].replace(blocks[argv[2]], '')
      return { ok: true, output: '' }
    }
  })
  let view = await viewOf(m.deps)
  for (const [name, why] of [['context7', /only stdio servers/], ['off', /enabled/]] as const) {
    const answer = await act(m.deps, view, { type: 'remove', key: named(view, 'mcp', name).key })
    assert.equal(answer.result.ok, true, answer.result.message)
    assert.equal((answer.result as ActionResult & { ok: true }).undo, undefined, name)
    assert.match(answer.result.message, /No undo:/, name)
    assert.match(answer.result.message, why, name)
    assert.ok(answer.view.ok)
    view = answer.view.view
  }
})

test('an undo key that names something other than a Codex config.toml backup runs nothing', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  for (const file of [`${BACKUPS}/config.2026-11-24T10-00-00-000Z.json`, '/home/elsewhere/config.toml', `${BACKUPS}/../config.toml`]) {
    const answer = await act(m.deps, view, { type: 'move', key: itemKey('mcp', file, 'codegraph'), to: { project: null }, copy: true })
    assert.equal(answer.result.ok, false, file)
  }
  assert.deepEqual(m.exec.calls, [])
})

test('MCP copy from a project to global runs `codex mcp add NAME -- COMMAND ARGS` after the backup', async () => {
  let backedUp = false
  const m = machine({
    reply: () => {
      backedUp = `${BACKUPS}/config.2026-11-24T10-00-00-000Z.json` in m.fs.files
      m.fs.files[CONFIG] += '\n[mcp_servers.shop-db]\ncommand = "shop-db"\nargs = ["--readonly"]\n'
      return { ok: true, output: "Added global MCP server 'shop-db'." }
    }
  })
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, view, { type: 'move', key: named(view, 'mcp', 'shop-db', SHOP).key, to: { project: null }, copy: true })
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, ['codex mcp add shop-db -- shop-db --readonly @ -'])
  assert.equal(backedUp, true)
  assert.deepEqual((answer.result as ActionResult & { ok: true }).undo, { type: 'remove', key: itemKey('mcp', CONFIG, 'shop-db') })
})

test('MCP: a move that is not a copy, an uncopyable server and a user server never run the CLI', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  const moved = await act(m.deps, view, { type: 'move', key: named(view, 'mcp', 'shop-db', SHOP).key, to: { project: null }, copy: false })
  assert.equal((moved.result as ActionResult & { ok: false }).reason, 'not-movable')
  const env = await act(m.deps, view, { type: 'move', key: named(view, 'mcp', 'shop-env', SHOP).key, to: { project: null }, copy: true })
  assert.equal((env.result as ActionResult & { ok: false }).reason, 'not-movable')
  const project = await act(m.deps, view, { type: 'remove', key: named(view, 'mcp', 'shop-db', SHOP).key })
  assert.equal((project.result as ActionResult & { ok: false }).reason, 'not-removable')
  assert.deepEqual(m.exec.calls, [])
  assert.deepEqual(m.writes, [])
})

test('MCP remove refuses a stale view: no backup, no CLI', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  m.fs.files[CONFIG] += '\n# edited by Codex meanwhile\n'
  const answer = await act(m.deps, view, { type: 'remove', key: named(view, 'mcp', 'codegraph').key })
  assert.equal((answer.result as ActionResult & { ok: false }).reason, 'changed')
  assert.deepEqual(m.exec.calls, [])
  assert.deepEqual(m.writes, [])
})

test('config.toml is never written by the app, whatever it runs', async () => {
  const m = machine({ reply: () => ({ ok: true, output: '' }) })
  let view = await viewOf(m.deps)
  const run = async (action: Action) => {
    const answer = await act(m.deps, view, action)
    if (answer.view.ok) view = answer.view.view
    return answer.result
  }
  await run({ type: 'snapshot' })
  await run({ type: 'remove', key: named(view, 'mcp', 'codegraph').key })
  await run({ type: 'move', key: named(view, 'mcp', 'shop-db', SHOP).key, to: { project: null }, copy: true })
  await run({ type: 'move', key: named(view, 'skills', 'review').key, to: { project: SHOP }, copy: true })
  await run({ type: 'move', key: named(view, 'agents', 'pr_explorer').key, to: { project: SHOP }, copy: false })
  const backup = view.backups.find((entry) => entry.target === CONFIG)
  assert.ok(backup, 'a config.toml backup is listed')
  const restored = await run({ type: 'restore', name: backup.name })
  assert.equal((restored as ActionResult & { ok: false }).reason, 'read-only')
  assert.match(restored.message, /cp "/)
  assert.deepEqual(m.writes.filter((path) => path.endsWith('config.toml')), [])
  assert.equal(m.fs.files[CONFIG], CONFIG_TOML)
  assert.equal(m.fs.files[`${SHOP}/.codex/config.toml`], FILES[`${SHOP}/.codex/config.toml`])
})

test('a skill moves to a project .codex/skills and back; a removed one is restored from the trash', async () => {
  const m = machine()
  let view = await viewOf(m.deps)
  const moved = await act(m.deps, view, { type: 'move', key: named(view, 'skills', 'review').key, to: { project: SHOP }, copy: false })
  assert.equal(moved.result.ok, true, moved.result.message)
  assert.ok(`${SHOP}/.codex/skills/review/SKILL.md` in m.fs.files)
  assert.ok(!('/home/.codex/skills/review/SKILL.md' in m.fs.files))
  view = (moved.view as { ok: true; view: View }).view
  const back = await act(m.deps, view, (moved.result as ActionResult & { ok: true }).undo!)
  assert.equal(back.result.ok, true, back.result.message)
  assert.ok('/home/.codex/skills/review/SKILL.md' in m.fs.files)

  view = (back.view as { ok: true; view: View }).view
  const removed = await act(m.deps, view, { type: 'remove', key: named(view, 'skills', 'review').key })
  assert.equal(removed.result.ok, true, removed.result.message)
  assert.ok(!('/home/.codex/skills/review/SKILL.md' in m.fs.files))
  view = (removed.view as { ok: true; view: View }).view
  const restored = await act(m.deps, view, (removed.result as ActionResult & { ok: true }).undo!)
  assert.equal(restored.result.ok, true, restored.result.message)
  assert.equal(m.fs.files['/home/.codex/skills/review/SKILL.md'], FILES['/home/.codex/skills/review/SKILL.md'])
})

test('an agent file named by an [agents.<role>] config_file is neither moved nor removed', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  const key = view.items.find((item) => item.source === '/home/.codex/agents/reviewer.toml')!.key
  const removed = await act(m.deps, view, { type: 'remove', key })
  assert.equal((removed.result as ActionResult & { ok: false }).reason, 'not-removable')
  const moved = await act(m.deps, view, { type: 'move', key, to: { project: SHOP }, copy: false })
  assert.equal((moved.result as ActionResult & { ok: false }).reason, 'not-movable')
  assert.deepEqual(m.writes, [])
})

// ---- Regressions from the T3 verifier (B2, B3, A4, A5) and the command-line secret rule.

const PROBE_TOML = `${CONFIG_TOML}
[mcp_servers.probe]
command = "npx"
args = ["srv", "--api-key", "sk-live-SECRET1234567890"]

[mcp_servers.probe-url]
url = "https://x.io/mcp?token=abc123tok"
`
const PROBE_HOOKS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "curl -H 'Authorization: Bearer hunter2' https://x.io/done" }] }] } })

test('B2: MCP args, MCP URLs and hook commands are shown without their secrets', async () => {
  const view = await viewOf(machine({ files: { ...FILES, [CONFIG]: PROBE_TOML, [HOOKS]: PROBE_HOOKS } }).deps)
  assert.doesNotMatch(JSON.stringify(view.items), /sk-live|abc123tok|hunter2/)
  assert.equal(named(view, 'mcp', 'probe').mcp?.target, 'npx srv --api-key <redacted>')
  assert.equal(named(view, 'mcp', 'probe-url').mcp?.target, 'https://x.io/mcp?token=<redacted>')
  const hook = view.items.find((item) => item.kind === 'hooks' && item.hook?.event === 'Stop')!
  assert.equal(hook.hook?.command, "curl -H 'Authorization: <redacted>' https://x.io/done")
})

test('a project server with a secret in its args is never put on a codex command line', async () => {
  const project = `${FILES[`${SHOP}/.codex/config.toml`]}\n[mcp_servers.leaky]\ncommand = "srv"\nargs = ["--token", "sk-live-SECRET1234567890"]\n`
  const m = machine({ files: { ...FILES, [`${SHOP}/.codex/config.toml`]: project } })
  const view = await viewOf(m.deps)
  const leaky = named(view, 'mcp', 'leaky', SHOP)
  assert.equal(leaky.movable, false)
  const copied = await act(m.deps, view, { type: 'move', key: leaky.key, to: { project: null }, copy: true })
  assert.equal((copied.result as ActionResult & { ok: false }).reason, 'not-movable')
  assert.doesNotMatch(JSON.stringify(copied.result), /sk-live/)
  assert.deepEqual(m.exec.calls, [])
})

test('B3: skills in ~/.agents/skills and <project>/.agents/skills are read-only, other agents read them too', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  for (const item of [named(view, 'skills', 'notes'), named(view, 'skills', 'deploy', SHOP)]) {
    assert.equal(item.movable, false, item.name)
    assert.equal(item.removable, false, item.name)
    assert.match(item.notMovableReason ?? '', /other agents/)
    const removed = await act(m.deps, view, { type: 'remove', key: item.key })
    assert.equal((removed.result as ActionResult & { ok: false }).reason, 'not-removable')
    const moved = await act(m.deps, view, { type: 'move', key: item.key, to: { project: item.project === null ? SHOP : null }, copy: true })
    assert.equal((moved.result as ActionResult & { ok: false }).reason, 'not-movable')
  }
  assert.ok('/home/.agents/skills/notes/SKILL.md' in m.fs.files)
  assert.ok(`${SHOP}/.agents/skills/deploy/SKILL.md` in m.fs.files)
  assert.deepEqual(m.writes, [])
})

test('B3: a skill moved into a project lands in <project>/.codex/skills, never in .agents/skills', async () => {
  const m = machine()
  const view = await viewOf(m.deps)
  const moved = await act(m.deps, view, { type: 'move', key: named(view, 'skills', 'review').key, to: { project: SHOP }, copy: true })
  assert.equal(moved.result.ok, true, moved.result.message)
  assert.ok(`${SHOP}/.codex/skills/review/SKILL.md` in m.fs.files)
  assert.ok(!(`${SHOP}/.agents/skills/review/SKILL.md` in m.fs.files))
})

test('A4: a project that is a link to the home folder is not a project, so nothing is listed twice or copied into home', async () => {
  const config = `${CONFIG_TOML}\n[projects."/link"]\ntrust_level = "trusted"\n`.replace('[hooks.state', '[projects."/link2"]\ntrust_level = "trusted"\n\n[hooks.state')
  const fs = fakeFs({ ...structuredClone(FILES), [CONFIG]: config }, { '/link': HOME, '/link2': '/home/.codex' })
  const deps: ProviderDeps = { fs, exec: fakeExec({ commands: COMMANDS }), home: HOME, clock: CLOCK }
  const view = await viewOf(deps)
  assert.deepEqual(view.projects, [SHOP])
  assert.ok(!view.items.some((item) => item.project === '/link' || item.project === '/link2'))
})

test('A5: a server whose name looks like an option is shown as not removable, as the action refuses it', async () => {
  const m = machine({ files: { ...FILES, [CONFIG]: `${CONFIG_TOML}\n[mcp_servers."-x"]\ncommand = "x"\n` } })
  const view = await viewOf(m.deps)
  const item = named(view, 'mcp', '-x')
  assert.equal(item.removable, false)
  const removed = await act(m.deps, view, { type: 'remove', key: item.key })
  assert.equal(removed.result.ok, false)
  assert.deepEqual(m.exec.calls, [])
})
