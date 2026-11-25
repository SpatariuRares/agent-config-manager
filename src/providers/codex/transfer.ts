// 'copyToAgent' for Codex: MCP servers and skills out to another agent, and in from one.
// Out: any skill or server the view shows, shared places and project config.toml files included (an export only
// reads). In: through the same write paths as a move (./actions.ts). An MCP server is added with
// `codex mcp add NAME -- COMMAND ARGS` (config.toml is never written here), which carries a stdio command line and
// nothing else: no env, no url, no headers; a server that has them is refused rather than copied without them.
// A skill folder is copied into Codex's own folder (~/.codex/skills, <project>/.codex/skills), never the shared one.
import type { ActionResult, Target } from '../../adapters/view.ts'
import { exportSkill, itemKey, moveEntry, portableMcp, secretRefusal, skillEntry, tilde, type Exported, type Portable, type ProviderDeps } from '../toolkit.ts'
import { addableServer, addServer, places } from './actions.ts'
import { codexPaths, readCodex, usableServerName } from './read.ts'

const GONE = { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' } as const
const refuse = (reason: string, message: string): ActionResult => ({ ok: false, reason, message })

export async function exportCodex(deps: ProviderDeps, key: string): Promise<Exported> {
  const ref = (await readCodex(deps)).refs.get(key)
  if (ref === undefined) return GONE
  if (ref.kind !== 'mcp') return ref.kind === 'skills' ? exportSkill(deps.fs, ref.entry.name, ref.entry.entry) : GONE
  const { command, args, env, url, http_headers, enabled, ...rest } = ref.server
  const extra = Object.keys(rest)
  // A server turned off would be on in the other agent.
  if (enabled !== undefined && enabled !== true) extra.push('enabled')
  return portableMcp(ref.name, { transport: typeof url === 'string' ? 'http' : 'stdio', command, args, url, env, headers: http_headers }, extra)
}

export async function importCodex(deps: ProviderDeps, item: Portable, to: Target, versions: Record<string, string>): Promise<ActionResult> {
  const read = await readCodex(deps)
  if (item.kind === 'skills') {
    const copied = await moveEntry(deps.fs, places(deps, read), skillEntry(item), to.project, true)
    if (!copied.ok) return copied
    return { ok: true, message: `Copied skill "${item.name}" to ${tilde(deps.home, copied.path)}.`, undo: { type: 'remove', key: itemKey('skills', copied.path) } }
  }

  const { name } = item
  if (to.project !== null) {
    return refuse('unsupported', '`codex mcp add` only writes ~/.codex/config.toml, and this app never rewrites a project .codex/config.toml.')
  }
  if (item.transport !== 'stdio') {
    return refuse('not-portable', `"${name}" is an ${item.transport} server: \`codex mcp add --url\` may start a browser login, so only stdio servers are copied to Codex.`)
  }
  if (item.env !== undefined) {
    return refuse('not-portable', `"${name}" has env values, and \`codex mcp add\` cannot carry env. Copy it by hand, or remove its env first.`)
  }
  const secret = secretRefusal(item, { commandLine: '`codex mcp add`', teamFile: false })
  if (secret !== null) return secret
  if (!usableServerName(name)) return refuse('not-portable', `\`codex mcp add\` refuses the name "${name}".`)
  const server = { command: item.command, ...(item.args ? { args: [...item.args] } : {}) }
  const why = addableServer(name, server)
  if (why !== null) return refuse('not-portable', why)
  const added = await addServer(deps, name, server, versions)
  if (!('saved' in added)) return added
  return {
    ok: true,
    message: `Copied MCP server "${name}" to ~/.codex/config.toml with codex mcp add.${added.saved}`,
    undo: { type: 'remove', key: itemKey('mcp', codexPaths(deps.home).config, name) }
  }
}
