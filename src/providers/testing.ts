// The provider test kit: in-memory doubles for the shared ports, and the contract every provider must pass.
// In a provider's test file: `providerContract(myProvider, { home, files, write })`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isObject } from '../core/json.ts'
import type { CommandRunner } from '../core/ports.ts'
import { fakeExec, fakeFs } from '../core/test-support.ts'
import type { Action, ActionResult, ActionType, AgentInfo, Kind, View } from '../adapters/view.ts'
import { admitMcp } from './mcp-policy.ts'
import { routeAction, routeView } from './router.ts'
import { ACTION_TYPES, BACKUP_ACTIONS, KINDS, PORTABLE_KINDS, type AgentProvider, type PortableMcp, type ProviderDeps, type ProviderView } from './types.ts'

export { fakeExec, fakeFs }

export interface ContractFixture {
  /** The fake home folder; the provider finds its config under it. */
  home: string
  /** An installed agent with at least one item: absolute path -> text. */
  files: Record<string, string>
  links?: Record<string, string>
  /** Commands `exec.find` knows (name -> path); none by default. */
  commands?: Record<string, string>
  /**
   * One file write the provider supports, to prove it refuses a stale view and backs up first. Required as soon
   * as `info().supports` lists any action; a read-only provider leaves it out.
   */
  write?: {
    /** The action, built from the view (e.g. `setEnabled` on its first plugin). */
    action: (view: ProviderView) => Action
    /** The file that action changes. */
    file: string
  }
}

/**
 * What is wrong with `info.projectScopes`: it must exist, list only classes whose `supports` include 'move' or
 * which the agent `imports`, and name each of 'local' and 'project' at most once. Empty when it is right.
 */
export function projectScopeProblems(info: AgentInfo): string[] {
  if (info.projectScopes === null || typeof info.projectScopes !== 'object') return ['projectScopes is missing']
  const problems: string[] = []
  for (const [kind, scopes] of Object.entries(info.projectScopes)) {
    const list: string[] = scopes ?? []
    if (list.length > 0 && !(info.supports[kind as Kind] ?? []).includes('move') && !(info.imports ?? []).includes(kind as Kind)) {
      problems.push(`projectScopes lists ${kind}, whose supports do not include move and which it does not import`)
    }
    list.forEach((scope, i) => {
      if (list.indexOf(scope) !== i) problems.push(`projectScopes.${kind} lists ${JSON.stringify(scope)} twice`)
      else if (scope !== 'local' && scope !== 'project') problems.push(`projectScopes.${kind} lists ${JSON.stringify(scope)}, which is not local or project`)
    })
  }
  return problems
}

const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')

/** One action of each type, aimed at `key` (an item of `kind`). */
function probe(type: ActionType, kind: Kind, key: string): Action {
  switch (type) {
    case 'move':
      return { type, key, to: { project: null }, copy: false }
    case 'setEnabled':
      return { type, key, enabled: true }
    case 'updateAll':
      return { type, kind, keys: [key] }
    case 'restore':
      return { type, name: 'contract-probe.json' }
    case 'snapshot':
    case 'refreshMarketplaces':
      return { type }
    default:
      return { type, key } as Action
  }
}

/** A literal secret the MCP probes carry: a token followed by `$x`, which a whole-word token check would miss. */
const MCP_SECRET = 'sk-live-0123456789abcdef$x'
/** What must never reach a command line or a team file: the token itself, whatever follows it. */
const MCP_LEAK = 'sk-live-0123456789abcdef'

/** A command runner that finds every command and lets every run succeed, recording each one as `fakeExec` does. */
function everyCommand(): CommandRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    find: async (name) => `/usr/bin/${name}`,
    run: async (command, argv, cwd) => {
      calls.push(`${[command, ...argv].join(' ')} @ ${cwd ?? '-'}`)
      return { ok: true, output: '' }
    }
  }
}

/** Adds MCP_SECRET to the env (TOKEN) and the args of every stdio server under an `mcpServers` key, at any depth. */
function addSecret(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) return value.forEach((entry) => addSecret(entry, names))
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'mcpServers' || !isObject(child)) {
      addSecret(child, names)
      continue
    }
    for (const [name, server] of Object.entries(child)) {
      if (!isObject(server) || typeof server.command !== 'string') continue
      server.args = [...(Array.isArray(server.args) ? server.args : []), MCP_SECRET]
      server.env = { ...(isObject(server.env) ? server.env : {}), TOKEN: MCP_SECRET }
      names.add(name)
    }
  }
}

/**
 * The fixture's files with MCP_SECRET in every stdio server: JSON (comment lines dropped) through addSecret, and a
 * TOML file with `[mcp_servers.` sections gets a `contract-probe` server. Returns the files and the names of the
 * servers that carry the secret.
 */
function withMcpSecret(files: Record<string, string>): { files: Record<string, string>; names: Set<string> } {
  const names = new Set<string>()
  const out = structuredClone(files)
  for (const [path, text] of Object.entries(out)) {
    if (path.endsWith('.toml') && text.includes('[mcp_servers.')) {
      out[path] = `${text}\n[mcp_servers.contract-probe]\ncommand = "npx"\nargs = ["${MCP_SECRET}"]\nenv = { TOKEN = "${MCP_SECRET}" }\n`
      names.add('contract-probe')
      continue
    }
    if (!path.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
    } catch {
      continue
    }
    const before = names.size
    addSecret(parsed, names)
    if (names.size > before) out[path] = `${JSON.stringify(parsed, null, 2)}\n`
  }
  return { files: out, names }
}

/** Registers the tests every provider must pass. Call it once, at the top level of the provider's test file. */
export function providerContract(provider: AgentProvider, fixture: ContractFixture): void {
  const name = `${provider.id} provider contract`
  const machine = () => {
    const fs = fakeFs(structuredClone(fixture.files), structuredClone(fixture.links ?? {}))
    const exec = fakeExec({ commands: fixture.commands })
    const deps: ProviderDeps = { fs, exec, home: fixture.home, clock: CLOCK }
    return { fs, exec, deps }
  }
  // Counts the calls that reach the provider's runAction.
  const spied = () => {
    const calls: Action[] = []
    const wrapped: AgentProvider = {
      id: provider.id,
      info: (deps) => provider.info(deps),
      buildView: (deps) => provider.buildView(deps),
      ...(provider.backups ? { backups: (deps: ProviderDeps) => provider.backups!(deps) } : {}),
      runAction: (deps, request) => {
        calls.push(request.action)
        return provider.runAction(deps, request)
      }
    }
    return { calls, wrapped }
  }
  const viewOf = async (deps: ProviderDeps, providers: AgentProvider[]): Promise<View> => {
    const answer = await routeView(deps, providers, { agent: provider.id })
    assert.equal(answer.ok, true, answer.ok ? '' : answer.error)
    return (answer as { ok: true; view: View }).view
  }

  test(`${name}: info has the contract shape, and the fixture is detected`, async () => {
    const { deps } = machine()
    const info = await provider.info(deps)
    assert.equal(info.id, provider.id)
    assert.ok(info.name.trim() !== '', 'a display name')
    assert.equal(info.detected, true, 'the fixture is an installed agent')
    assert.ok(info.kinds.length > 0 && info.kinds.every((kind) => KINDS.includes(kind)), `kinds among ${KINDS.join(', ')}`)
    assert.equal(new Set(info.kinds).size, info.kinds.length, 'no kind twice')
    for (const [kind, actions] of Object.entries(info.supports)) {
      assert.ok(info.kinds.includes(kind as Kind), `supports lists ${kind}, which is not in kinds`)
      for (const action of actions ?? []) assert.ok(ACTION_TYPES.includes(action), `unknown action ${action}`)
    }
    assert.deepEqual(projectScopeProblems(info), [], 'projectScopes')
    for (const side of ['exports', 'imports'] as const) {
      for (const kind of info[side] ?? []) {
        assert.ok(info.kinds.includes(kind) && PORTABLE_KINDS.includes(kind), `${side} lists ${kind}, which is not a kind it has that copyToAgent carries`)
      }
    }
    if ((info.exports ?? []).length > 0) assert.equal(typeof provider.exportItem, 'function', 'exports are listed, so exportItem must exist')
    if ((info.imports ?? []).length > 0) assert.equal(typeof provider.importItem, 'function', 'imports are listed, so importItem must exist')
    const backs = Object.values(info.supports).some((actions) => (actions ?? []).some((action) => BACKUP_ACTIONS.includes(action)))
    if (backs) assert.equal(typeof provider.backups, 'function', 'restore or snapshot is listed, so backups must be declared')
    assert.equal(typeof info.configHome, 'string')
    assert.ok(info.configHome !== '')
  })

  test(`${name}: detection only reads files and PATH, and is false on an empty machine`, async () => {
    const empty = { fs: fakeFs({}), exec: fakeExec(), home: fixture.home, clock: CLOCK }
    assert.equal((await provider.info(empty)).detected, false)
    const { deps, exec } = machine()
    await provider.info(deps)
    assert.deepEqual(empty.exec.calls, [], 'info() ran a command')
    assert.deepEqual(exec.calls, [], 'info() ran a command')
  })

  test(`${name}: the view is plain JSON (Orca refuses undefined, functions and class instances)`, async () => {
    const { deps } = machine()
    const view = await provider.buildView(deps)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(view)), view)
  })

  test(`${name}: view items carry the agent id, a declared kind and a unique key starting with the kind`, async () => {
    const { deps } = machine()
    const info = await provider.info(deps)
    const view = await viewOf(deps, [provider])
    assert.equal(view.agent, provider.id)
    assert.deepEqual(view.agents.map((agent) => agent.id), [provider.id])
    assert.ok(view.items.length > 0, 'the fixture shows at least one item')
    for (const item of view.items) {
      assert.equal(item.agent, provider.id, item.key)
      assert.ok(info.kinds.includes(item.kind), `${item.key}: kind ${item.kind} is not in kinds`)
      assert.ok(item.key.startsWith(`${item.kind}:`), `${item.key} must start with "${item.kind}:"`)
    }
    assert.equal(new Set(view.items.map((item) => item.key)).size, view.items.length, 'keys are unique')
    for (const [file, version] of Object.entries(view.versions)) assert.equal(typeof version, 'string', file)
  })

  test(`${name}: actions it did not declare are refused as unsupported and never reach it`, async () => {
    const { deps, fs } = machine()
    const info = await provider.info(deps)
    const view = await viewOf(deps, [provider])
    const before = structuredClone(fs.files)
    const { calls, wrapped } = spied()
    const declared = (kind: Kind, type: ActionType) => (info.supports[kind] ?? []).includes(type)
    const refused: string[] = []
    for (const kind of KINDS) {
      const key = view.items.find((item) => item.kind === kind)?.key ?? `${kind}:contract-probe`
      for (const type of ACTION_TYPES) {
        if (BACKUP_ACTIONS.includes(type) || (type === 'refreshMarketplaces' && kind !== 'plugins')) continue
        if (info.kinds.includes(kind) && declared(kind, type)) continue
        const answer = await routeAction(deps, [wrapped], { agent: provider.id, action: probe(type, kind, key), versions: view.versions })
        assert.equal(answer.result.ok, false, `${type} on ${kind} ran`)
        assert.equal((answer.result as ActionResult & { ok: false }).reason, 'unsupported', `${type} on ${kind}`)
        refused.push(`${type}:${kind}`)
      }
    }
    for (const type of BACKUP_ACTIONS) {
      if (info.kinds.some((kind) => declared(kind, type))) continue
      const answer = await routeAction(deps, [wrapped], { agent: provider.id, action: probe(type, 'plugins', ''), versions: view.versions })
      assert.equal((answer.result as ActionResult & { ok: false }).reason, 'unsupported', type)
    }
    assert.deepEqual(calls, [], 'an undeclared action reached runAction')
    assert.deepEqual(fs.files, before, 'a refused action changed a file')
  })

  test(`${name}: an unknown agent and an undetected one are refused before anything runs`, async () => {
    const { deps } = machine()
    const { calls, wrapped } = spied()
    const unknown = await routeAction(deps, [wrapped], { agent: `${provider.id}-nope`, action: { type: 'snapshot' }, versions: {} })
    assert.equal((unknown.result as ActionResult & { ok: false }).reason, 'unknown-agent')
    const empty = { fs: fakeFs({}), exec: fakeExec(), home: fixture.home, clock: CLOCK }
    const absent = await routeAction(empty, [wrapped], { agent: provider.id, action: { type: 'snapshot' }, versions: {} })
    assert.equal((absent.result as ActionResult & { ok: false }).reason, 'not-detected')
    assert.deepEqual(calls, [])
  })

  test(`${name}: every MCP destination that is a command line or a team file refuses a literal secret`, async (t) => {
    const { deps } = machine()
    const info = await provider.info(deps)
    if (!(info.imports ?? []).includes('mcp') && !(info.supports.mcp ?? []).includes('move')) return t.skip('writes no MCP servers')
    const destinations = provider.mcpDestinations ?? []
    assert.ok(destinations.length > 0, 'it writes MCP servers, so it must expose mcpDestinations')
    const secret = 'sk-live-0123456789abcdef$x'
    for (const to of destinations.filter((destination) => destination.team || destination.argv !== null)) {
      const admitted = admitMcp({ name: 'probe', transport: 'stdio', command: 'npx', env: { TOKEN: secret } }, to)
      assert.equal(admitted.ok, false, `${to.label} (team: ${to.team}) admitted a literal secret in env`)
      assert.ok(!admitted.ok && !admitted.message.includes(secret), `${to.label}: the message shows the value`)
    }
  })

  test(`${name}: every MCP write path keeps a literal secret off command lines and out of team files`, async (t) => {
    const { deps: plain } = machine()
    const info = await provider.info(plain)
    const moves = (info.supports.mcp ?? []).includes('move')
    const imports = (info.imports ?? []).includes('mcp')
    if (!moves && !imports) return t.skip('writes no MCP servers')
    const { projects } = await viewOf(plain, [provider])
    const probe = withMcpSecret(fixture.files)
    const scopes = info.projectScopes.mcp ?? []
    const targets = [{ project: null }, ...projects.flatMap((project) => (scopes.length > 0 ? scopes.map((scope) => ({ project, scope })) : [{ project }]))]
    // One fresh machine per write, so an earlier write never makes a later one stale.
    const attempt = async (label: string, write: (deps: ProviderDeps, view: View) => Promise<ActionResult>) => {
      const fs = fakeFs(structuredClone(probe.files), structuredClone(fixture.links ?? {}))
      const exec = everyCommand()
      const deps: ProviderDeps = { fs, exec, home: fixture.home, clock: CLOCK }
      const view = await viewOf(deps, [provider])
      const before = structuredClone(fs.files)
      const result = await write(deps, view)
      // A team file leaks when it holds the secret more often than before (a probe server may already be there).
      const count = (text: string | undefined) => (text ?? '').split(MCP_LEAK).length - 1
      const teamFiles = Object.keys(fs.files).filter((path) => projects.some((project) => path.startsWith(`${project}/`)))
      const leaks = [
        ...exec.calls.filter((call) => call.includes(MCP_LEAK)).map((call) => `argv: ${call}`),
        ...teamFiles.filter((path) => count(fs.files[path]) > count(before[path])).map((path) => `team file: ${path}`)
      ]
      assert.deepEqual(leaks, [], `${label}: ${result.ok ? 'written' : `refused (${result.reason})`}`)
      assert.ok(!result.message.includes(MCP_LEAK), `${label}: the message shows the secret`)
      return result
    }
    const results: ActionResult[] = []
    if (moves) {
      const fs = fakeFs(structuredClone(probe.files), structuredClone(fixture.links ?? {}))
      const view = await viewOf({ fs, exec: everyCommand(), home: fixture.home, clock: CLOCK }, [provider])
      const items = view.items.filter((item) => item.kind === 'mcp' && probe.names.has(item.name))
      assert.ok(items.length > 0, 'it moves MCP servers, so the fixture must hold a stdio MCP server')
      for (const item of items) {
        for (const to of targets) {
          const label = `move ${item.key} to ${to.project ?? 'global'}${'scope' in to ? ` (${to.scope})` : ''}`
          const action: Action = { type: 'move', key: item.key, to, copy: true }
          results.push(await attempt(label, async (deps, fresh) => (await routeAction(deps, [provider], { agent: provider.id, action, versions: fresh.versions })).result))
        }
      }
    }
    if (imports) {
      assert.equal(typeof provider.importItem, 'function', 'imports are listed, so importItem must exist')
      // With env and an arg, and with the arg alone, so an agent that cannot carry env still meets the secret.
      const servers: PortableMcp[] = [
        { kind: 'mcp', name: 'contract-probe-import', transport: 'stdio', command: 'npx', args: [MCP_SECRET], env: { TOKEN: MCP_SECRET } },
        { kind: 'mcp', name: 'contract-probe-import', transport: 'stdio', command: 'npx', args: [MCP_SECRET] }
      ]
      for (const server of servers) {
        for (const to of targets) {
          const label = `copyToAgent ${server.env ? 'with env ' : ''}into ${to.project ?? 'global'}${'scope' in to ? ` (${to.scope})` : ''}`
          results.push(await attempt(label, (deps, view) => provider.importItem!(deps, structuredClone(server), to, view.versions)))
        }
      }
    }
    assert.ok(results.some((result) => !result.ok && result.reason === 'secret'), 'no write path refused the secret: the probe never reached the MCP policy')
  })

  test(`${name}: a write refuses a stale view, then backs the file up before changing it`, async (t) => {
    const { deps, fs } = machine()
    const info = await provider.info(deps)
    if (Object.values(info.supports).every((actions) => (actions ?? []).length === 0)) return t.skip('read-only provider')
    assert.ok(fixture.write, 'info().supports lists actions, so the fixture must declare a write')
    const { action, file } = fixture.write
    const view = await viewOf(deps, [provider])
    const previous = fs.files[file]
    assert.equal(typeof previous, 'string', `${file} is in the fixture`)

    const before = structuredClone(fs.files)
    const stale = Object.fromEntries([...Object.keys(view.versions), file].map((path) => [path, 'stale-version']))
    const refused = await routeAction(deps, [provider], { agent: provider.id, action: action(view), versions: stale })
    assert.equal(refused.result.ok, false, 'a stale view was written')
    assert.equal((refused.result as ActionResult & { ok: false }).reason, 'changed')
    assert.deepEqual(fs.files, before, 'a refused write changed a file')

    const written = await routeAction(deps, [provider], { agent: provider.id, action: action(view), versions: view.versions })
    assert.equal(written.result.ok, true, written.result.message)
    assert.notEqual(fs.files[file], previous, `${file} did not change`)
    const backups = Object.keys(fs.files).filter((path) => !(path in before) && fs.files[path] === previous)
    assert.ok(backups.length > 0, `no backup holds the previous ${file}`)
    assert.ok(written.view.ok, 'the fresh view reads')
    const listed = (written.view as { ok: true; view: View }).view.backups
    assert.ok(listed.some((backup) => backup.target === file), 'the backup is listed in the view')
  })
}
