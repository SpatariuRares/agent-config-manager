// Codex as the source and the target of 'copyToAgent': MCP servers and skills.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult } from '../../adapters/view.ts'
import { fakeExec, fakeFs } from '../testing.ts'
import { itemKey, type PortableMcp, type PortableSkill, type ProviderDeps } from '../types.ts'
import { codexProvider } from './index.ts'

const HOME = '/home/me'
const CONFIG = `${HOME}/.codex/config.toml`
const SHOP = '/work/shop'
const BACKUPS = `${HOME}/.config/agent-config-manager/backups/codex`
const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')

const CONFIG_TOML = `# user config
[projects."/work/shop"]
trust_level = "trusted"

[mcp_servers.codegraph]
command = "codegraph"
args = ["serve", "--mcp"]
env = { LOG = "info" }

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
http_headers = { Authorization = "Bearer \${CTX_TOKEN}" }

[mcp_servers.timed]
command = "timed"
startup_timeout_sec = 20

[mcp_servers.off]
command = "off"
enabled = false
`

const FILES: Record<string, string> = {
  [CONFIG]: CONFIG_TOML,
  [`${HOME}/.codex/skills/review/SKILL.md`]: '---\nname: review\ndescription: Reviews code\n---\n',
  [`${HOME}/.agents/skills/notes/SKILL.md`]: '---\nname: notes\n---\n',
  [`${SHOP}/README.md`]: 'shop',
  ['/src/pdf/SKILL.md']: '---\nname: pdf\n---\n',
  ['/src/pdf/run.sh']: 'echo\n'
}

/** A machine whose codex double appends what `codex mcp add` would write. */
function machine(added = true) {
  const box: { fs?: ReturnType<typeof fakeFs> } = {}
  box.fs = fakeFs(structuredClone(FILES))
  const exec = fakeExec({
    commands: { codex: '/usr/local/bin/codex' },
    reply: (_command, argv) => {
      if (added && argv[1] === 'add') box.fs!.files[CONFIG] += `\n[mcp_servers.${argv[2]}]\ncommand = "${argv[4]}"\n`
      return { ok: true, output: '' }
    }
  })
  const deps: ProviderDeps = { fs: box.fs, exec, home: HOME, clock: CLOCK }
  return { fs: box.fs, exec, deps }
}

const provider = codexProvider()
const versionsOf = async (deps: ProviderDeps) => (await provider.buildView(deps)).versions
const importInto = async (deps: ProviderDeps, item: PortableMcp | PortableSkill, project: string | null = null) =>
  provider.importItem!(deps, item, project === null ? { project: null } : { project, scope: 'project' }, await versionsOf(deps))
const refused = (result: ActionResult) => result as ActionResult & { ok: false }

const STDIO: PortableMcp = { kind: 'mcp', name: 'docs', transport: 'stdio', command: 'docs-mcp', args: ['--port', '1'] }

test('Codex declares that it exports and imports skills and MCP servers; MCP servers stay out of projects', async () => {
  const info = await provider.info(machine().deps)
  assert.deepEqual(info.exports, ['skills', 'mcp'])
  assert.deepEqual(info.imports, ['skills', 'mcp'])
  assert.equal(info.projectScopes.mcp, undefined)
})

test('Codex export: a stdio server with env, and an http server whose http_headers are its headers', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', CONFIG, 'codegraph')), {
    ok: true,
    item: { kind: 'mcp', name: 'codegraph', transport: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], env: { LOG: 'info' } }
  })
  assert.deepEqual(await provider.exportItem!(deps, itemKey('mcp', CONFIG, 'context7')), {
    ok: true,
    item: { kind: 'mcp', name: 'context7', transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ${CTX_TOKEN}' } }
  })
})

test('Codex export refuses settings another agent cannot take (a timeout, a server turned off)', async () => {
  const { deps } = machine()
  for (const [name, field] of [['timed', 'startup_timeout_sec'], ['off', 'enabled']]) {
    const result = (await provider.exportItem!(deps, itemKey('mcp', CONFIG, name))) as ActionResult
    assert.equal(refused(result).reason, 'not-portable', name)
    assert.match(result.message, new RegExp(field))
  }
})

test('Codex export: a skill as its folder, also from the shared .agents/skills', async () => {
  const { deps } = machine()
  assert.deepEqual(await provider.exportItem!(deps, itemKey('skills', `${HOME}/.codex/skills/review`)), {
    ok: true,
    item: { kind: 'skills', name: 'review', dir: `${HOME}/.codex/skills/review`, link: null }
  })
  assert.equal((await provider.exportItem!(deps, itemKey('skills', `${HOME}/.agents/skills/notes`))).ok, true)
})

test('Codex import: a stdio server is added with `codex mcp add NAME -- COMMAND ARGS` after a backup, with an undo that removes it', async () => {
  const m = machine()
  const result = await importInto(m.deps, STDIO)
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(m.exec.calls, ['codex mcp add docs -- docs-mcp --port 1 @ -'])
  assert.equal(m.fs.files[`${BACKUPS}/config.2026-11-24T10-00-00-000Z.json`], CONFIG_TOML)
  assert.deepEqual((result as { undo?: unknown }).undo, { type: 'remove', key: itemKey('mcp', CONFIG, 'docs') })
  assert.match(result.message, /codex mcp add/)
})

test('Codex import refuses what `codex mcp add` cannot carry: env, an http server, a secret on the command line', async () => {
  const m = machine()
  const env = await importInto(m.deps, { ...STDIO, env: { DOCS_TOKEN: '${DOCS_TOKEN}' } })
  assert.equal(refused(env).reason, 'not-portable')
  assert.match(env.message, /cannot carry env/)
  const http = await importInto(m.deps, { kind: 'mcp', name: 'web', transport: 'http', url: 'https://web.example/mcp' })
  assert.equal(refused(http).reason, 'not-portable')
  const secret = await importInto(m.deps, { ...STDIO, args: ['--token', 'sk-live-0123456789abcdef'] })
  assert.equal(refused(secret).reason, 'secret')
  assert.doesNotMatch(secret.message, /sk-live/)
  const optionLike = await importInto(m.deps, { ...STDIO, name: '-x' })
  assert.equal(optionLike.ok, false)
  assert.deepEqual(m.exec.calls, [], 'nothing ran')
  assert.equal(m.fs.files[CONFIG], CONFIG_TOML)
})

test('Codex import refuses a server name already in config.toml, and reports a CLI that did not add it', async () => {
  const taken = machine()
  assert.equal(refused(await importInto(taken.deps, { ...STDIO, name: 'codegraph' })).reason, 'exists')
  assert.deepEqual(taken.exec.calls, [])
  const silent = machine(false)
  assert.equal(refused(await importInto(silent.deps, STDIO)).reason, 'cli-failed')
})

test('Codex import: a skill folder is copied into ~/.codex/skills or <project>/.codex/skills, with an undo that removes it', async () => {
  const { deps, fs } = machine()
  const skill: PortableSkill = { kind: 'skills', name: 'pdf', dir: '/src/pdf', link: null }
  const global = await importInto(deps, skill)
  assert.equal(global.ok, true, global.message)
  assert.equal(fs.files[`${HOME}/.codex/skills/pdf/run.sh`], 'echo\n')
  assert.deepEqual((global as { undo?: unknown }).undo, { type: 'remove', key: itemKey('skills', `${HOME}/.codex/skills/pdf`) })
  const project = await importInto(deps, skill, SHOP)
  assert.equal(project.ok, true, project.message)
  assert.equal(fs.files[`${SHOP}/.codex/skills/pdf/SKILL.md`], '---\nname: pdf\n---\n')
  assert.equal(refused(await importInto(deps, skill)).reason, 'exists')
})
