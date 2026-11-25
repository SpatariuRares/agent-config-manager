// The Portable shapes and the secret rules every import applies, plus copies between the real providers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, ActionResult } from '../adapters/view.ts'
import { isReference, literalValues, portableMcp, secretRefusal } from './portable.ts'
import { PROVIDERS } from './registry.ts'
import { routeAction, routeView } from './router.ts'
import { fakeExec, fakeFs } from './testing.ts'
import type { PortableMcp, ProviderDeps } from './types.ts'

test('a ${VAR} reference is not a secret; a literal next to one still is', () => {
  assert.equal(isReference('${API_KEY}'), true)
  assert.equal(isReference('Bearer ${TOKEN}'), true)
  assert.equal(isReference('plain'), false)
  assert.equal(isReference('$API_KEY'), false)
  assert.equal(isReference('${A} sk-live-0123456789abcdef'), false)
})

test('portableMcp refuses settings it cannot carry, and fields of the other transport, rather than dropping them', () => {
  const cwd = portableMcp('x', { transport: 'stdio', command: 'x' }, ['cwd'])
  assert.equal(cwd.ok === false && cwd.reason, 'not-portable')
  const mixed = portableMcp('x', { transport: 'http', url: 'https://x.example', env: { A: 'b' } }, [])
  assert.match(mixed.ok ? '' : mixed.message, /\(env\)/)
  const websocket = portableMcp('x', { transport: 'websocket' }, [])
  assert.equal(websocket.ok, false)
  assert.deepEqual(portableMcp('x', { transport: 'stdio', command: 'x', args: [], env: {} }, []), { ok: true, item: { kind: 'mcp', name: 'x', transport: 'stdio', command: 'x' } })
})

test('secretRefusal names fields, never values; a reference passes a command line and a team file', () => {
  const item: PortableMcp = { kind: 'mcp', name: 's', transport: 'stdio', command: 'x', env: { API_KEY: 'sk-live-0123456789abcdef', LOG: 'info' } }
  assert.deepEqual(literalValues(item), ['env API_KEY', 'env LOG'])
  const onCli = secretRefusal(item, { commandLine: 'some-cli', teamFile: false })
  assert.match(onCli?.message ?? '', /env API_KEY/)
  assert.doesNotMatch(onCli?.message ?? '', /sk-live|env LOG/)
  assert.equal(secretRefusal({ ...item, env: { API_KEY: '${API_KEY}' } }, { commandLine: 'some-cli', teamFile: true }), null)
  assert.equal(secretRefusal(item, { commandLine: null, teamFile: false }), null, 'a user file outside any command line keeps literal values')
})

// ---------- Between the real providers, in one fake home

const HOME = '/home/me'
const SHOP = '/work/shop'
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

function machine() {
  const fs = fakeFs({
    [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: { docs: { type: 'stdio', command: 'docs-mcp', args: ['--port', '1'] } }, projects: { [SHOP]: {} } }),
    [`${HOME}/.claude/settings.json`]: json({}),
    [`${HOME}/.claude/skills/review/SKILL.md`]: '---\nname: review\ndescription: Reviews code\n---\n',
    [`${HOME}/.copilot/config.json`]: json({ trustedFolders: [SHOP] }),
    [`${HOME}/.codex/config.toml`]: `[projects."${SHOP}"]\ntrust_level = "trusted"\n`,
    [`${SHOP}/README.md`]: 'shop'
  })
  // Neither gemini nor any other CLI is installed: Gemini CLI is not detected.
  const exec = fakeExec({ commands: { claude: '/usr/bin/claude' } })
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: () => new Date('2026-11-24T10:00:00.000Z') }
  return { fs, exec, deps }
}

const versionsOf = async (deps: ProviderDeps, agent: string) => {
  const answer = await routeView(deps, PROVIDERS, { agent })
  assert.ok(answer.ok, answer.ok ? '' : answer.error)
  return answer.view.versions
}

test('copyToAgent between real providers: a Claude Code skill to Codex, then its undo sent to Codex removes the copy', async () => {
  const { fs, deps } = machine()
  const key = `skills:${HOME}/.claude/skills/review/SKILL.md`
  const answer = await routeAction(deps, PROVIDERS, {
    agent: 'claude',
    action: { type: 'copyToAgent', key, toAgent: 'codex', to: { project: SHOP, scope: 'project' } },
    versions: await versionsOf(deps, 'claude')
  })
  assert.equal(answer.result.ok, true, answer.result.message)
  const result = answer.result as ActionResult & { ok: true }
  assert.match(result.message, /^Codex: Copied skill "review"/)
  assert.equal(result.undoAgent, 'codex')
  assert.ok(fs.files[`${SHOP}/.codex/skills/review/SKILL.md`])
  assert.ok(answer.view.ok && answer.view.view.agent === 'claude', 'the view is the source agent')

  const undone = await routeAction(deps, PROVIDERS, { agent: result.undoAgent!, action: result.undo as Action, versions: await versionsOf(deps, 'codex') })
  assert.equal(undone.result.ok, true, undone.result.message)
  assert.equal(fs.files[`${SHOP}/.codex/skills/review/SKILL.md`], undefined)
  assert.ok(fs.files[`${HOME}/.claude/skills/review/SKILL.md`], 'the source is untouched')
})

test('copyToAgent between real providers: a Claude Code MCP server to Copilot CLI lands in its mcp-config.json', async () => {
  const { fs, deps } = machine()
  const answer = await routeAction(deps, PROVIDERS, {
    agent: 'claude',
    action: { type: 'copyToAgent', key: `mcp:${JSON.stringify([null, 'user', 'docs'])}`, toAgent: 'copilot', to: { project: null } },
    versions: {}
  })
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.deepEqual(JSON.parse(fs.files[`${HOME}/.copilot/mcp-config.json`]).mcpServers.docs, { type: 'local', command: 'docs-mcp', args: ['--port', '1'], tools: ['*'] })
})

test('copyToAgent between real providers: an agent that is not installed is refused before anything runs', async () => {
  const { fs, exec, deps } = machine()
  const before = structuredClone(fs.files)
  const answer = await routeAction(deps, PROVIDERS, {
    agent: 'claude',
    action: { type: 'copyToAgent', key: `skills:${HOME}/.claude/skills/review/SKILL.md`, toAgent: 'gemini', to: { project: null } },
    versions: {}
  })
  assert.equal(answer.result.ok === false && answer.result.reason, 'not-detected')
  assert.deepEqual(fs.files, before)
  assert.deepEqual(exec.calls, [])
})
