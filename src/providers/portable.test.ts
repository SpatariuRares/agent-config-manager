// Copies between the real providers (the MCP server policy itself is tested in ./mcp-policy.test.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, ActionResult } from '../adapters/view.ts'
import { PROVIDERS } from './registry.ts'
import { routeAction, routeView } from './router.ts'
import { fakeExec, fakeFs } from './testing.ts'
import type { ProviderDeps } from './types.ts'

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

  assert.deepEqual(result.undoVersions, await versionsOf(deps, 'codex'), "the undo carries the target's versions read right after the copy")
  const undone = await routeAction(deps, PROVIDERS, { agent: result.undoAgent!, action: result.undo as Action, versions: result.undoVersions! })
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

// ---------- A secret inside a longer value never reaches a command line

const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

test('copyToAgent: a Copilot CLI server with a token inside its --header arg is refused by Claude Code, Gemini CLI and Codex; nothing runs', async () => {
  const server = { type: 'local', command: 'npx', args: ['mcp-remote', 'https://api.example/mcp', `--header=Authorization: Bearer ${GHP}`], tools: ['*'] }
  const fs = fakeFs({
    [`${HOME}/.claude.json`]: JSON.stringify({ mcpServers: {} }),
    [`${HOME}/.claude/settings.json`]: json({}),
    [`${HOME}/.copilot/config.json`]: json({}),
    [`${HOME}/.copilot/mcp-config.json`]: json({ mcpServers: { remote: server } }),
    [`${HOME}/.codex/config.toml`]: '',
    [`${HOME}/.gemini/settings.json`]: json({})
  })
  const exec = fakeExec({ commands: { claude: '/usr/bin/claude', copilot: '/usr/bin/copilot', codex: '/usr/bin/codex', gemini: '/usr/bin/gemini' } })
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: () => new Date('2026-11-24T10:00:00.000Z') }
  const view = await routeView(deps, PROVIDERS, { agent: 'copilot' })
  assert.ok(view.ok)
  const shown = view.view.items.find((item) => item.kind === 'mcp' && item.name === 'remote')
  assert.ok(shown, 'Copilot CLI shows the server')
  assert.doesNotMatch(JSON.stringify(view.view.items), /ghp_/, 'the view never shows the token')
  for (const toAgent of ['claude', 'gemini', 'codex']) {
    const answer = await routeAction(deps, PROVIDERS, { agent: 'copilot', action: { type: 'copyToAgent', key: shown.key, toAgent, to: { project: null } }, versions: view.view.versions })
    assert.equal(answer.result.ok === false && answer.result.reason, 'secret', `${toAgent}: ${answer.result.message}`)
    assert.doesNotMatch(answer.result.message, /ghp_/)
  }
  assert.deepEqual(exec.calls.filter((call) => /ghp_/.test(call)), [], 'the token reached no argv')
})

test('copyToAgent undo: sent with undoVersions, it is refused as changed when the target file was edited after the copy', async () => {
  const { fs, deps } = machine()
  const file = `${HOME}/.copilot/mcp-config.json`
  const answer = await routeAction(deps, PROVIDERS, {
    agent: 'claude',
    action: { type: 'copyToAgent', key: `mcp:${JSON.stringify([null, 'user', 'docs'])}`, toAgent: 'copilot', to: { project: null } },
    versions: {}
  })
  const result = answer.result as ActionResult & { ok: true }
  assert.equal(result.ok, true, result.message)
  assert.equal(result.undoAgent, 'copilot')
  assert.ok(result.undoVersions && Object.keys(result.undoVersions).length > 0)
  // The user edits the copied server after the copy.
  const edited = JSON.parse(fs.files[file])
  edited.mcpServers.docs.args = ['--port', '2']
  fs.files[file] = json(edited)
  const undone = await routeAction(deps, PROVIDERS, { agent: 'copilot', action: result.undo as Action, versions: result.undoVersions! })
  assert.equal(undone.result.ok === false && undone.result.reason, 'changed', undone.result.message)
  assert.deepEqual(JSON.parse(fs.files[file]).mcpServers.docs.args, ['--port', '2'], 'the edited server is kept')
})

test('copyToAgent still refuses a server the target already has, whatever versions the request carries', async () => {
  const { fs, deps } = machine()
  fs.files[`${HOME}/.copilot/mcp-config.json`] = json({ mcpServers: { docs: { type: 'local', command: 'other', tools: ['*'] } } })
  const before = fs.files[`${HOME}/.copilot/mcp-config.json`]
  const answer = await routeAction(deps, PROVIDERS, {
    agent: 'claude',
    action: { type: 'copyToAgent', key: `mcp:${JSON.stringify([null, 'user', 'docs'])}`, toAgent: 'copilot', to: { project: null } },
    versions: { [`${HOME}/.copilot/mcp-config.json`]: 'stale' }
  })
  assert.equal(answer.result.ok, false)
  assert.match(answer.result.message, /already in/)
  assert.equal(fs.files[`${HOME}/.copilot/mcp-config.json`], before)
})
