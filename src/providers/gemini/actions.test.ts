// What the Gemini CLI provider writes: through the gemini CLI by argv, after a version check and a backup.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult } from '../../adapters/view.ts'
import type { CliResult } from '../../core/ports.ts'
import {
  act,
  BACKUPS,
  ENABLEMENT,
  files,
  GEMINI,
  HOME,
  itemOf,
  json,
  machine,
  MCP_ENABLEMENT,
  SHOP,
  SHOP_SETTINGS,
  USER_SETTINGS,
  viewOf
} from './test-support.ts'

type Machine = ReturnType<typeof machine>
type Effect = (m: Machine, argv: readonly string[], cwd: string | null) => CliResult | void

/** A machine whose gemini double applies `effect` to the files, as the real CLI would. */
function withCli(effect: Effect, fixture = files()) {
  const box: { m?: Machine } = {}
  box.m = machine({ files: fixture, reply: (_command, argv, cwd) => effect(box.m!, argv, cwd) ?? { ok: true, output: 'done' } })
  return box.m
}

const parse = (m: Machine, file: string) => JSON.parse(m.fs.files[file])
const write = (m: Machine, file: string, value: unknown) => {
  m.fs.files[file] = json(value)
}
const backupsHolding = (m: Machine, text: string) => Object.keys(m.fs.files).filter((path) => path.startsWith(`${BACKUPS}/`) && m.fs.files[path] === text)
const refused = (result: ActionResult) => result as ActionResult & { ok: false }

test('turning an extension off globally runs `gemini extensions disable --scope user`, after backing up its enablement file', async () => {
  const before = files()[ENABLEMENT]
  let backedUp = 0
  const m = withCli((m) => {
    backedUp = backupsHolding(m, before).length
    write(m, ENABLEMENT, { ...parse(m, ENABLEMENT), obsidian: { overrides: [`!${HOME}/*`] } })
  })
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'plugins', 'obsidian').key, enabled: false }, view.versions)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, ['gemini extensions disable --scope user obsidian @ -'])
  assert.equal(backedUp, 1, 'the backup existed before the CLI ran')
  assert.deepEqual((answer.result as { undo?: unknown }).undo, { type: 'setEnabled', key: itemOf(view, 'plugins', 'obsidian').key, enabled: true })
  assert.match((answer.result as { warning?: string }).warning ?? '', /\/work\/shop/, 'the cleared project override is named')
})

test('turning an extension on in a project runs `gemini extensions enable --scope workspace` in that project', async () => {
  const m = withCli((m) => write(m, ENABLEMENT, { ...parse(m, ENABLEMENT), obsidian: { overrides: [`${HOME}/*`, `${SHOP}/*`] } }))
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'plugins', 'obsidian', SHOP).key, enabled: true }, view.versions)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, [`gemini extensions enable --scope workspace obsidian @ ${SHOP}`])
})

test('a CLI that exits 0 without changing anything is reported as a failure with its output', async () => {
  const m = withCli(() => ({ ok: true, output: 'Extension with name obsidian does not exist.' }))
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'plugins', 'obsidian').key, enabled: false }, view.versions)
  assert.equal(answer.result.ok, false)
  assert.equal(refused(answer.result).reason, 'cli')
  assert.match(answer.result.message, /does not exist/)
})

test('a stale view is refused before the CLI runs, and nothing changes', async () => {
  const m = withCli(() => undefined)
  const view = await viewOf(m.deps)
  const before = structuredClone(m.fs.files)
  const versions = { ...view.versions, [ENABLEMENT]: 'stale', [USER_SETTINGS]: 'stale', [MCP_ENABLEMENT]: 'stale', [SHOP_SETTINGS]: 'stale' }
  for (const action of [
    { type: 'setEnabled', key: itemOf(view, 'plugins', 'obsidian').key, enabled: false },
    { type: 'uninstall', key: itemOf(view, 'plugins', 'obsidian').key },
    { type: 'remove', key: itemOf(view, 'mcp', 'vercel').key },
    { type: 'setEnabled', key: itemOf(view, 'mcp', 'vercel').key, enabled: false },
    { type: 'move', key: itemOf(view, 'mcp', 'db', SHOP).key, to: { project: null }, copy: false }
  ] as const) {
    const answer = await act(m.deps, action, versions)
    assert.equal(refused(answer.result).reason, 'changed', `${action.type}: ${answer.result.message}`)
  }
  assert.deepEqual(m.exec.calls, [])
  assert.deepEqual(m.fs.files, before)
})

test('uninstalling an extension runs `gemini extensions uninstall <name>` after backing up the enablement file', async () => {
  const before = files()[ENABLEMENT]
  let backedUp = 0
  const m = withCli((m) => {
    backedUp = backupsHolding(m, before).length
    for (const path of Object.keys(m.fs.files)) if (path.startsWith(`${GEMINI}/extensions/obsidian/`)) delete m.fs.files[path]
  })
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'uninstall', key: itemOf(view, 'plugins', 'obsidian').key }, view.versions)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, ['gemini extensions uninstall obsidian @ -'])
  assert.equal(backedUp, 1)
  assert.match(answer.result.message, /gemini extensions install https:\/\/github\.com\/someone\/gemini-obsidian/)
})

test('updating an extension runs `gemini extensions update <name>`; a local one has nothing to update from', async () => {
  const manifest = `${GEMINI}/extensions/obsidian/gemini-extension.json`
  const m = withCli((m) => write(m, manifest, { ...parse(m, manifest), version: '1.2.0' }))
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'update', key: itemOf(view, 'plugins', 'obsidian').key }, view.versions)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(m.exec.calls, ['gemini extensions update obsidian @ -'])
  assert.match(answer.result.message, /1\.1\.0 to 1\.2\.0/)
  const local = await act(m.deps, { type: 'update', key: itemOf(view, 'plugins', 'local-ext').key }, view.versions)
  assert.equal(local.result.ok, false)
  assert.deepEqual(m.exec.calls.length, 1)
})

test('an extension update that asks to approve new permissions fails at once with the command to run, and never accepts them', async () => {
  const prompt = 'The extension wants new permissions.\nDo you want to continue? [Y/n]: '
  for (const ok of [true, false]) {
    // stdin is closed, so the real CLI exits at its consent prompt (with or without an error code).
    const m = withCli(() => ({ ok, output: prompt }))
    const options: unknown[] = []
    const run = m.deps.exec.run.bind(m.deps.exec)
    m.deps.exec.run = (command, argv, cwd, opts) => {
      options.push(opts)
      return run(command, argv, cwd, opts)
    }
    const view = await viewOf(m.deps)
    const answer = await act(m.deps, { type: 'update', key: itemOf(view, 'plugins', 'obsidian').key }, view.versions)
    assert.equal(refused(answer.result).reason, 'needs-consent', answer.result.message)
    assert.match(answer.result.message, /new permissions/)
    assert.match(answer.result.message, /in a terminal: gemini extensions update obsidian$/)
    assert.deepEqual(m.exec.calls, ['gemini extensions update obsidian @ -'])
    assert.deepEqual(options, [{ timeoutMs: 120_000, closeStdin: true }])
    assert.equal(refused(answer.result).confirm, undefined)
  }
})

test('removing an MCP server runs `gemini mcp remove --scope user|project` in the right folder, after a backup', async () => {
  let backedUp = 0
  const m = withCli((m, argv, cwd) => {
    const file = cwd === SHOP ? SHOP_SETTINGS : USER_SETTINGS
    backedUp += backupsHolding(m, files()[file]).length
    const name = argv.at(-1)!
    const settings = JSON.parse(m.fs.files[file].replace(/^\/\/.*\n/, ''))
    delete settings.mcpServers[name]
    write(m, file, settings)
  })
  const view = await viewOf(m.deps)
  const user = await act(m.deps, { type: 'remove', key: itemOf(view, 'mcp', 'vercel').key }, view.versions)
  assert.equal(user.result.ok, true, user.result.message)
  assert.deepEqual((user.result as { undo?: { type: string } }).undo?.type, 'restore')
  const project = await act(m.deps, { type: 'remove', key: itemOf(view, 'mcp', 'db', SHOP).key }, view.versions)
  assert.equal(project.result.ok, true, project.result.message)
  assert.deepEqual(m.exec.calls, ['gemini mcp remove --scope user vercel @ -', `gemini mcp remove --scope project db @ ${SHOP}`])
  assert.equal(backedUp, 2)
})

test('turning an MCP server off or on runs `gemini mcp disable|enable <name>` in its folder, after backing up the enablement file', async () => {
  const m = withCli((m, argv) => {
    const [, verb, name] = argv
    const state = parse(m, MCP_ENABLEMENT)
    if (verb === 'disable') state[name] = { enabled: false }
    else delete state[name]
    write(m, MCP_ENABLEMENT, state)
  })
  let view = await viewOf(m.deps)
  const off = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'mcp', 'vercel').key, enabled: false }, view.versions)
  assert.equal(off.result.ok, true, off.result.message)
  view = await viewOf(m.deps)
  const on = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'mcp', 'context7').key, enabled: true }, view.versions)
  assert.equal(on.result.ok, true, on.result.message)
  view = await viewOf(m.deps)
  const db = await act(m.deps, { type: 'setEnabled', key: itemOf(view, 'mcp', 'db', SHOP).key, enabled: false }, view.versions)
  assert.equal(db.result.ok, true, db.result.message)
  assert.deepEqual(m.exec.calls, ['gemini mcp disable vercel @ -', 'gemini mcp enable context7 @ -', `gemini mcp disable db @ ${SHOP}`])
  assert.ok(backupsHolding(m, files()[MCP_ENABLEMENT]).length === 1)
})

test('moving an MCP server runs `gemini mcp add` at the destination, then `gemini mcp remove` at the source', async () => {
  const m = withCli((m, argv, cwd) => {
    const file = cwd === SHOP ? SHOP_SETTINGS : USER_SETTINGS
    const settings = JSON.parse(m.fs.files[file].replace(/^\/\/.*\n/, ''))
    if (argv[1] === 'add') settings.mcpServers[argv[6]] = { command: argv[7], args: argv.slice(9) }
    else delete settings.mcpServers[argv.at(-1)!]
    write(m, file, settings)
  })
  let view = await viewOf(m.deps)
  const moved = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'db', SHOP).key, to: { project: null }, copy: false }, view.versions)
  assert.equal(moved.result.ok, true, moved.result.message)
  view = await viewOf(m.deps)
  const copied = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'context7').key, to: { project: SHOP, scope: 'project' }, copy: true }, view.versions)
  assert.equal(copied.result.ok, true, copied.result.message)
  assert.deepEqual(m.exec.calls, [
    'gemini mcp add --scope user --transport stdio db pg-mcp -- --readonly @ -',
    `gemini mcp remove --scope project db @ ${SHOP}`,
    `gemini mcp add --scope project --transport stdio context7 npx -- -y @upstash/context7-mcp@2.2.5 @ ${SHOP}`
  ])
})

test('an MCP server with env values or headers is not movable: the CLI would put them on its command line', async () => {
  const m = withCli(() => undefined)
  const view = await viewOf(m.deps)
  const secretive = itemOf(view, 'mcp', 'secretive')
  assert.equal(secretive.movable, false)
  assert.match(secretive.notMovableReason ?? '', /env/)
  const answer = await act(m.deps, { type: 'move', key: secretive.key, to: { project: SHOP, scope: 'project' }, copy: true }, view.versions)
  assert.equal(refused(answer.result).reason, 'not-movable')
  const local = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'context7').key, to: { project: SHOP, scope: 'local' }, copy: true }, view.versions)
  assert.equal(local.result.ok, false, 'Gemini CLI has no only-me project settings')
  const same = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'context7').key, to: { project: null }, copy: false }, view.versions)
  assert.equal(refused(same.result).reason, 'same-place')
  assert.deepEqual(m.exec.calls, [])
})

test('moving an MCP server onto a name the destination already has is refused', async () => {
  const fixture = { ...files(), [SHOP_SETTINGS]: json({ mcpServers: { db: { command: 'pg-mcp' }, context7: { command: 'other' } } }) }
  const m = withCli(() => undefined, fixture)
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'context7').key, to: { project: SHOP, scope: 'project' }, copy: true }, view.versions)
  assert.equal(refused(answer.result).reason, 'exists')
  assert.deepEqual(m.exec.calls, [])
})

test('a server name that looks like an option is refused before the CLI runs', async () => {
  const fixture = { ...files(), [SHOP_SETTINGS]: json({ mcpServers: { '-h': { command: 'x' } } }) }
  const m = withCli(() => undefined, fixture)
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'remove', key: itemOf(view, 'mcp', '-h', SHOP).key }, view.versions)
  assert.equal(answer.result.ok, false)
  assert.deepEqual(m.exec.calls, [])
})

test('snapshot backs up every file this app may change; restore refuses a backup of any other file', async () => {
  const m = withCli(() => undefined)
  const view = await viewOf(m.deps)
  const snap = await act(m.deps, { type: 'snapshot' }, view.versions)
  assert.equal(snap.result.ok, true, snap.result.message)
  for (const file of [USER_SETTINGS, SHOP_SETTINGS, ENABLEMENT, MCP_ENABLEMENT]) {
    assert.equal(backupsHolding(m, files()[file]).length, 1, file)
  }
  m.fs.files[`${BACKUPS}/%2Fetc%2Fpasswd.2026-11-20T10-00-00-000Z.json`] = 'root'
  const evil = await act(m.deps, { type: 'restore', name: '%2Fetc%2Fpasswd.2026-11-20T10-00-00-000Z.json' })
  assert.equal(evil.result.ok, false)
  assert.equal(m.fs.files['/etc/passwd'], undefined)
})

test('B4: a server with a secret in its args or url is never put on a gemini command line, nor copied into a project', async () => {
  const fixture = {
    ...files(),
    [SHOP_SETTINGS]: json({ mcpServers: { leaky: { command: 'srv', args: ['--api-key', 'sk-live-SECRET1234567890'] } } })
  }
  const m = withCli(() => undefined, fixture)
  const view = await viewOf(m.deps)
  const leaky = itemOf(view, 'mcp', 'leaky', SHOP)
  const vercel = itemOf(view, 'mcp', 'vercel')
  for (const item of [leaky, vercel]) {
    assert.equal(item.movable, false, item.name)
    assert.match(item.notMovableReason ?? '', /secret/)
  }
  const toGlobal = await act(m.deps, { type: 'move', key: leaky.key, to: { project: null }, copy: true }, view.versions)
  const toProject = await act(m.deps, { type: 'move', key: vercel.key, to: { project: SHOP, scope: 'project' }, copy: true }, view.versions)
  for (const answer of [toGlobal, toProject]) {
    assert.equal(refused(answer.result).reason, 'not-movable')
    assert.doesNotMatch(answer.result.message, /sk-live|abc123token/)
  }
  assert.deepEqual(m.exec.calls, [])
})

test('B4: a failing gemini command is named with its server and outcome, never its argv values or a token it prints', async () => {
  const m = withCli(() => ({ ok: false, output: 'Error: rejected --api-key sk-live-SECRET1234567890' }))
  const view = await viewOf(m.deps)
  const answer = await act(m.deps, { type: 'move', key: itemOf(view, 'mcp', 'context7').key, to: { project: SHOP, scope: 'project' }, copy: true }, view.versions)
  assert.equal(refused(answer.result).reason, 'cli')
  assert.match(answer.result.message, /gemini mcp add/)
  assert.match(answer.result.message, /context7/)
  assert.doesNotMatch(answer.result.message, /sk-live|--transport|--scope|@upstash/)
  assert.equal(m.exec.calls.length, 1)
})
