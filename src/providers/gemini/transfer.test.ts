// Gemini CLI as the source and the target of 'copyToAgent': MCP servers and skills.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult } from '../../adapters/view.ts'
import type { CliResult } from '../../core/ports.ts'
import { itemKey, type PortableMcp, type PortableSkill, type ProviderDeps } from '../types.ts'
import { geminiProvider } from './index.ts'
import { BACKUPS, files, GEMINI, HOME, json, machine, SHOP, SHOP_SETTINGS, userSettingsText, USER_SETTINGS } from './test-support.ts'

type Machine = ReturnType<typeof machine>
const provider = geminiProvider()
const refused = (result: ActionResult) => result as ActionResult & { ok: false }

/** A machine whose gemini double writes what `gemini mcp add` would, into the settings file of its scope. */
function withCli(fixture = files(), reply?: (m: Machine, argv: readonly string[], cwd: string | null) => CliResult | void) {
  const box: { m?: Machine } = {}
  box.m = machine({
    files: fixture,
    reply: (_command, argv, cwd) => {
      const m = box.m!
      const answer = reply?.(m, argv, cwd)
      if (answer) return answer
      if (argv[0] === 'mcp' && argv[1] === 'add') {
        const file = argv[3] === 'user' ? USER_SETTINGS : `${cwd}/.gemini/settings.json`
        const text = m.fs.files[file] ?? '{}'
        const settings = JSON.parse(text.replace(/^\/\/.*$/gm, ''))
        const name = argv.find((word, i) => i > 5 && !word.startsWith('-') && !['-e', '-H'].includes(argv[i - 1]))!
        settings.mcpServers = { ...(settings.mcpServers ?? {}), [name]: { command: 'added' } }
        m.fs.files[file] = json(settings)
      }
      return { ok: true, output: 'done' }
    }
  })
  return box.m
}

const versionsOf = async (deps: ProviderDeps) => (await provider.buildView(deps)).versions
const importInto = async (m: Machine, item: PortableMcp | PortableSkill, project: string | null = null) =>
  provider.importItem!(m.deps, item, project === null ? { project: null } : { project, scope: 'project' }, await versionsOf(m.deps))

const STDIO: PortableMcp = { kind: 'mcp', name: 'docs', transport: 'stdio', command: 'docs-mcp', args: ['--port', '1'], env: { DOCS_TOKEN: '${DOCS_TOKEN}' } }

test('Gemini CLI declares that it exports and imports skills and MCP servers, and skills may go into a project', async () => {
  const info = await provider.info(machine().deps)
  assert.deepEqual(info.exports, ['skills', 'mcp'])
  assert.deepEqual(info.imports, ['skills', 'mcp'])
  assert.deepEqual(info.projectScopes.skills, ['project'])
})

test('Gemini export: a stdio server, and a url server with its headers (url alone is http)', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', null, 'context7')), {
    ok: true,
    item: { kind: 'mcp', name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@2.2.5'] }
  })
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', null, 'remote')), {
    ok: true,
    item: { kind: 'mcp', name: 'remote', transport: 'http', url: 'https://user:hunter2@example.com/sse', headers: { Authorization: 'Bearer xyz' } }
  })
})

test('Gemini export refuses settings another agent cannot take (timeout, trust, includeTools), naming them', async () => {
  const fixture = files()
  fixture[USER_SETTINGS] = json({ mcpServers: { tuned: { command: 'x', timeout: 5000, trust: true, includeTools: ['a'] } } })
  const { deps } = machine({ files: fixture })
  const result = (await provider.exportItem!(deps, itemKey('mcp', null, 'tuned'))) as ActionResult
  assert.equal(refused(result).reason, 'not-portable')
  assert.match(result.message, /timeout, trust, includeTools/)
})

test('Gemini export: a skill as its folder', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('skills', `${GEMINI}/skills/review`)), {
    ok: true,
    item: { kind: 'skills', name: 'review', dir: `${GEMINI}/skills/review`, link: null }
  })
})

test('Gemini import: `gemini mcp add --scope user` with ${VAR} env values, after a backup, read back, with an undo that removes it', async () => {
  const m = withCli()
  const result = await importInto(m, STDIO)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(m.exec.calls, ['gemini mcp add --scope user --transport stdio -e DOCS_TOKEN=${DOCS_TOKEN} docs docs-mcp -- --port 1 @ -'])
  assert.ok(Object.entries(m.fs.files).some(([path, text]) => path.startsWith(`${BACKUPS}/`) && text === userSettingsText), 'settings were backed up')
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('mcp', null, 'docs') })
})

test('Gemini import: an http server with a ${VAR} header, into a project, runs in that project', async () => {
  const m = withCli()
  const result = await importInto(m, { kind: 'mcp', name: 'web', transport: 'http', url: 'https://web.example/mcp', headers: { Authorization: 'Bearer ${WEB_TOKEN}' } }, SHOP)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(m.exec.calls, [`gemini mcp add --scope project --transport http -H Authorization: Bearer \${WEB_TOKEN} web https://web.example/mcp @ ${SHOP}`])
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('mcp', SHOP, 'web') })
})

test('Gemini import refuses secrets: literal values into the shared project file, secret-looking values on the command line', async () => {
  const m = withCli()
  const before = structuredClone(m.fs.files)
  const team = await importInto(m, { ...STDIO, env: { LOG: 'info' } }, SHOP)
  assert.equal(refused(team).reason, 'secret')
  const global = await importInto(m, { ...STDIO, env: { API_KEY: 'sk-live-0123456789abcdef' } })
  assert.equal(refused(global).reason, 'secret')
  assert.doesNotMatch(global.message, /sk-live/)
  const args = await importInto(m, { ...STDIO, env: undefined, args: ['--token', 'abcdefghijklmnopqrstuvwxyz0123456789'] })
  assert.equal(refused(args).reason, 'secret')
  assert.deepEqual(m.exec.calls, [])
  assert.deepEqual(m.fs.files, before)
  // A plain value that is not a secret may go to the user's own settings.
  const plain = await importInto(m, { ...STDIO, env: { LOG: 'info' } })
  assert.equal(plain.ok, true, plain.message)
})

test('Gemini import refuses what `gemini mcp add` would change: an env value with "=", a header with spaces around it', async () => {
  const m = withCli()
  const eq = await importInto(m, { ...STDIO, env: { OPTS: 'a=b' } })
  assert.equal(refused(eq).reason, 'not-portable')
  const spaced = await importInto(m, { kind: 'mcp', name: 'w', transport: 'sse', url: 'https://w.example/sse', headers: { 'X-Mode': ' fast ' } })
  assert.equal(refused(spaced).reason, 'not-portable')
  assert.deepEqual(m.exec.calls, [])
})

test('Gemini import refuses a name already there, and reports a CLI that did not add it', async () => {
  const taken = withCli()
  assert.equal(refused(await importInto(taken, { ...STDIO, name: 'context7' })).reason, 'exists')
  assert.deepEqual(taken.exec.calls, [])
  const silent = withCli(files(), () => ({ ok: true, output: 'MCP server added' }))
  assert.equal(refused(await importInto(silent, STDIO)).reason, 'cli')
})

test('Gemini import: a skill folder is copied into ~/.gemini/skills (Gemini CLI has no remove here, so no undo)', async () => {
  const fixture = { ...files(), '/src/pdf/SKILL.md': '---\nname: pdf\n---\n' }
  const m = withCli(fixture)
  const result = await importInto(m, { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null })
  assert.equal(result.ok, true, result.message)
  assert.equal(m.fs.files[`${GEMINI}/skills/pdf/SKILL.md`], '---\nname: pdf\n---\n')
  assert.equal((result as { undo?: unknown }).undo, undefined)
  assert.match(result.message, /gemini skills uninstall pdf/)
  const project = await importInto(m, { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null }, SHOP)
  assert.equal(project.ok, true, project.message)
  assert.ok(m.fs.files[`${SHOP}/.gemini/skills/pdf/SKILL.md`])
  assert.equal(refused(await importInto(m, { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null })).reason, 'exists')
  assert.deepEqual(m.exec.calls, [], 'no CLI ran for a skill')
  assert.ok(HOME && SHOP_SETTINGS)
})

test('Gemini import: the remove hint of a copied skill names the folder it was copied to, shell-quoted', async () => {
  const fixture = { ...files(), '/src/pdf tools;x/SKILL.md': '---\nname: pdf\n---\n' }
  const m = withCli(fixture)
  const result = await importInto(m, { kind: 'skills', name: 'pdf', dir: '/src/pdf tools;x', link: null })
  assert.equal(result.ok, true, result.message)
  assert.ok(m.fs.files[`${GEMINI}/skills/pdf tools;x/SKILL.md`])
  assert.ok(result.message.endsWith(`To remove it: gemini skills uninstall 'pdf tools;x'`), result.message)
})
