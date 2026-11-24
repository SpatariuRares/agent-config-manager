// The backend of the panel contract in ./view.ts. It composes the core; transports (the Orca worker,
// a localhost server) only pass requests in and answers out.
import { isTrashName, listAllBackups, restoreTrash, snapshot, trashEntry } from '../core/backups.ts'
import { moveEntry } from '../core/entries.ts'
import { moveHook, removeHook, type HookRef } from '../core/hooks.ts'
import { effectiveState, isObject, projectSettingsFile, settingsFile, type ProjectScope } from '../core/inventory.ts'
import { moveMcp, removeMcp, type McpRef } from '../core/mcp.ts'
import { movePlugin } from '../core/plugin-move.ts'
import type { ClaudePaths, FileSystem, PluginCli } from '../core/ports.ts'
import { placeFile, readSetup, type Entry, type Place, type ScopedHook, type ScopedMcp, type Setup } from '../core/setup.ts'
import {
  backupDir,
  backupTarget,
  restoreBackup,
  setPluginEnabled,
  setProjectPluginState,
  type Clock
} from '../core/toggle.ts'
import { uninstallPlugin } from '../core/uninstall.ts'
import type { Action, ActionAnswer, ActionRequest, ActionResult, Item, Kind, Target, View, ViewAnswer } from './view.ts'

export interface BackendDeps {
  fs: FileSystem
  cli: PluginCli
  paths: ClaudePaths
  clock?: Clock
}

/** What an item key points at in the setup. */
type Ref =
  | { kind: 'plugins'; id: string; project: string | null; scope: 'user' | 'project' | 'local'; enabled: boolean }
  | { kind: 'entry'; entry: Entry }
  | { kind: 'mcp'; server: ScopedMcp }
  | { kind: 'hooks'; hook: ScopedHook }

interface Read {
  setup: Setup
  view: View
  refs: Map<string, Ref>
}

export async function buildView(deps: BackendDeps): Promise<ViewAnswer> {
  try {
    return { ok: true, view: (await read(deps)).view }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** Runs one action, then reads the setup again so the answer never carries stale data. Never throws. */
export async function runAction(deps: BackendDeps, request: ActionRequest): Promise<ActionAnswer> {
  let outcome: Outcome
  try {
    outcome = await perform(deps, request)
  } catch (error) {
    outcome = { result: { ok: false, reason: 'error', message: String(error) } }
  }
  let view: ViewAnswer
  try {
    const after = await read(deps)
    view = { ok: true, view: after.view }
    const warning = outcome.result.ok && outcome.check ? hiddenWarning(deps.paths, after.setup, outcome.check) : null
    if (warning !== null && outcome.result.ok) outcome.result = { ...outcome.result, warning }
  } catch (error) {
    view = { ok: false, error: String(error) }
  }
  return { result: outcome.result, view }
}

/**
 * Runs tasks one at a time, in the order they arrive: each action reads files, checks their versions, then
 * writes, so two must never interleave. A failed task does not block the ones after it.
 */
export function actionQueue() {
  let last: Promise<unknown> = Promise.resolve()
  return <R>(task: () => Promise<R>): Promise<R> => {
    const next = last.then(task)
    last = next.catch(() => undefined)
    return next
  }
}

const NOTE = 'Changes apply to new Claude Code sessions, or after /reload-plugins.'
const NOUN: Record<Kind, string> = { plugins: 'plugin', skills: 'skill', agents: 'agent', mcp: 'MCP server', hooks: 'hook' }

interface Outcome {
  result: ActionResult
  /** A plugin value just written in a project file, to warn when a higher-precedence file hides it. */
  check?: { id: string; project: string; scope: ProjectScope; enabled: boolean }
}

const refuse = (reason: string, message: string): Outcome => ({ result: { ok: false, reason, message } })
const done = (message: string, undo?: Action, note = true): Outcome => ({
  result: { ok: true, message: note ? `${message} ${NOTE}` : message, ...(undo ? { undo } : {}) }
})
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const restoreOf = (backup: string | null | undefined): Action | undefined =>
  backup ? { type: 'restore', name: fileName(backup) } : undefined

async function perform(deps: BackendDeps, request: ActionRequest): Promise<Outcome> {
  const { fs, cli, paths } = deps
  const clock = deps.clock ?? (() => new Date())
  const action = isObject(request) && isObject(request.action) ? (request.action as Action) : null
  const versions: Record<string, string> = isObject(request) && isObject(request.versions) ? request.versions : {}
  const label = labels(paths)
  if (action === null || typeof action.type !== 'string') return refuse('unsupported', 'That request is not an action.')

  if (action.type === 'snapshot') {
    const backups = await snapshot(fs, paths, clock)
    return done(`Backed up ${backups.length} settings files to ${label.path(backupDir(paths))}.`, undefined, false)
  }
  if (action.type === 'restore') {
    if (typeof action.name !== 'string') return refuse('unknown-backup', 'That backup has no name.')
    if (isTrashName(action.name)) {
      const restored = await restoreTrash(fs, paths, action.name)
      if (!restored.ok) return refuse(restored.reason, restored.message)
      const kind = restored.target.slice(0, restored.target.lastIndexOf('/')).endsWith('/skills') ? 'skills' : 'agents'
      return done(`Put back ${label.path(restored.target)}.`, { type: 'remove', key: entryKey(kind, restored.target) })
    }
    const target = backupTarget(paths, action.name) ?? ''
    const restored = await restoreBackup(fs, paths, { name: action.name, settingsVersion: versions[target] ?? '' }, clock)
    if (!restored.ok) return refuse(restored.reason, restored.message)
    return done(`Restored ${label.path(target)} from its backup.`, restoreOf(restored.backup))
  }

  const before = await read(deps)
  const ref = typeof action.key === 'string' ? before.refs.get(action.key) : undefined
  const item = before.view.items.find((i) => i.key === action.key)
  if (ref === undefined || item === undefined) {
    return refuse('changed', 'That item is no longer there. The view was refreshed; try again.')
  }
  const named = `${NOUN[item.kind]} "${item.name}"`
  const from = label.place(item.kind, item.project, item.scope)

  switch (action.type) {
    case 'setEnabled': {
      if (ref.kind !== 'plugins') return refuse('unsupported', 'Only plugins have an on/off switch.')
      const enabled = action.enabled === true
      const written =
        ref.project === null
          ? await setPluginEnabled(fs, paths, { id: ref.id, enabled, settingsVersion: versions[settingsFile(paths)] ?? '' }, clock)
          : await setProjectPluginState(fs, paths, { id: ref.id, project: ref.project, scope: ref.scope as ProjectScope, enabled, version: versions[item.source] ?? '' }, clock)
      if (!written.ok) return refuse(written.reason, written.message)
      const where = ref.project === null ? 'globally' : `in ${from}`
      const undo: Action | undefined = written.backup ? { type: 'setEnabled', key: item.key, enabled: !enabled } : undefined
      const outcome = done(`Turned ${named} ${enabled ? 'on' : 'off'} ${where}.`, undo)
      return ref.project === null ? outcome : { ...outcome, check: { id: ref.id, project: ref.project, scope: ref.scope as ProjectScope, enabled } }
    }

    case 'clearOverride':
    case 'remove': {
      if (ref.kind === 'plugins') {
        if (ref.project === null) {
          return refuse(
            'unsupported',
            action.type === 'remove' ? `A global ${named} is removed with Uninstall.` : 'Only a project override can be cleared.'
          )
        }
        const cleared = await setProjectPluginState(
          fs,
          paths,
          { id: ref.id, project: ref.project, scope: ref.scope as ProjectScope, enabled: null, version: versions[item.source] ?? '' },
          clock
        )
        if (!cleared.ok) return refuse(cleared.reason, cleared.message)
        return done(`Cleared the override of ${named} in ${from}: it follows the global switch there now.`, restoreOf(cleared.backup))
      }
      if (action.type === 'clearOverride') return refuse('unsupported', 'Only a plugin override can be cleared.')
      if (ref.kind === 'entry') {
        const trashed = await trashEntry(fs, paths, ref.entry.entry, clock)
        if (!trashed.ok) return refuse(trashed.reason, trashed.message)
        return done(`Removed ${named} from ${from}. It is in the backups list if you need it back.`, { type: 'restore', name: trashed.name })
      }
      if (ref.kind === 'mcp') {
        const removed = await removeMcp(fs, cli, paths, mcpRef(ref.server), versions, clock)
        if (!removed.ok) return refuse(removed.reason, removed.message)
        // A backup of ~/.claude.json is not restored here (Claude Code owns that file), so it is no undo.
        const undo = removed.backups.find((backup) => backupTarget(paths, fileName(backup)) !== paths.userConfigFile)
        return done(`Removed ${named} from ${from}.`, restoreOf(undo))
      }
      const removed = await removeHook(fs, paths, hookRef(ref.hook), versions, clock)
      if (!removed.ok) return refuse(removed.reason, removed.message)
      return done(`Removed ${named} from ${from}.`, restoreOf(removed.backups[0]))
    }

    case 'uninstall': {
      if (ref.kind !== 'plugins') return refuse('unsupported', 'Only plugins can be uninstalled.')
      const result = await uninstallPlugin(fs, cli, paths, ref.id, clock)
      if (!result.ok) return refuse(result.reason, result.message)
      return done(`Uninstalled ${named}.`)
    }

    case 'move':
      return move(deps, clock, before, ref, item, action, versions)

    default:
      return refuse('unsupported', `Unknown action ${String((action as { type: unknown }).type)}.`)
  }
}

async function move(
  deps: BackendDeps,
  clock: Clock,
  before: Read,
  ref: Ref,
  item: Item,
  action: Extract<Action, { type: 'move' }>,
  versions: Record<string, string>
): Promise<Outcome> {
  const { fs, cli, paths } = deps
  const label = labels(paths)
  const target: Target = isObject(action.to) ? action.to : { project: null }
  if (target.project !== null && (typeof target.project !== 'string' || !before.view.projects.includes(target.project))) {
    return refuse('unknown-project', `${String(target.project)} is not a project Claude Code knows.`)
  }
  const copy = action.copy === true
  const to: Place = { project: target.project, scope: target.project === null ? 'user' : target.scope === 'project' ? 'project' : 'local' }
  const named = `${NOUN[item.kind]} "${item.name}"`
  const fromLabel = label.place(item.kind, item.project, item.scope)
  const toLabel = label.place(item.kind, to.project, to.scope)
  const verb = copy ? 'Copied' : 'Moved'
  const back: Target = item.project === null ? { project: null } : { project: item.project, scope: item.scope === 'project' ? 'project' : 'local' }
  const undoFor = (key: string): Action => (copy ? { type: 'remove', key } : { type: 'move', key, to: back, copy: false })
  const message = `${verb} ${named} from ${fromLabel} to ${toLabel}.`

  if (ref.kind === 'entry') {
    const moved = await moveEntry(fs, paths, ref.entry, to.project, copy)
    if (!moved.ok) return refuse(moved.reason, moved.message)
    const key = entryKey(ref.entry.kind, moved.path)
    return done(message, undoFor(key))
  }

  if (ref.kind === 'mcp') {
    const moved = await moveMcp(fs, cli, paths, mcpRef(ref.server), to, versions, copy, clock)
    if (moved.ok) return done(message, undoFor(mcpKey(to.project, to.scope, ref.server.name)))
    if (moved.reason === 'partial') {
      return refuse('partial', `Added ${named} to ${toLabel}, but removing it from ${fromLabel} failed: ${moved.message.trim()}`)
    }
    if (moved.reason === 'cli-failed') return refuse('cli-failed', `Could not add ${named} to ${toLabel}: ${moved.message.trim()}`)
    return refuse(moved.reason, moved.message)
  }

  if (ref.kind === 'hooks') {
    const { hook } = ref
    const file = placeFile(paths, to)
    const moved = await moveHook(fs, paths, hookRef(hook), { project: to.project, file }, versions, copy, clock)
    if (moved.ok) return done(message, undoFor(hookKey(file, hook.event, hook.rawMatcher, hook.command, 0)))
    if (moved.partial) {
      return refuse('partial', `Added ${named} to ${toLabel}, but removing it from ${fromLabel} failed: ${moved.message}`)
    }
    return refuse(moved.reason, moved.message)
  }

  // Plugins: to a project = on there; to global = on globally; between projects the value moves as is.
  const enabled = to.project === null || ref.project === null ? true : ref.enabled
  const moved = await movePlugin(
    fs,
    paths,
    { id: ref.id, from: { project: ref.project, scope: ref.scope }, to, enabled, copy, versions },
    clock
  )
  if (!moved.ok) {
    if (!moved.partial) return refuse(moved.reason, moved.message)
    const origin = ref.project === null ? 'turning it off globally' : `clearing it in ${fromLabel}`
    return refuse('partial', `Set ${named} ${enabled ? 'on' : 'off'} in ${toLabel}, but ${origin} failed: ${moved.message}`)
  }
  const newKey = pluginKey(to.project, to.scope, ref.id)
  const outcome = done(message, pluginUndo(before, ref, to, copy, newKey, back))
  return to.project === null ? outcome : { ...outcome, check: { id: ref.id, project: to.project, scope: to.scope as ProjectScope, enabled } }
}

/** An undo for a plugin move, only when sending it puts every file back exactly as it was. */
function pluginUndo(
  before: Read,
  ref: Extract<Ref, { kind: 'plugins' }>,
  to: Place,
  copy: boolean,
  newKey: string,
  back: Target
): Action | undefined {
  const prior = before.refs.get(pluginKey(to.project, to.scope, ref.id))
  const priorValue = prior?.kind === 'plugins' ? prior.enabled : undefined
  if (to.project !== null) {
    if (prior !== undefined) return undefined
    if (copy) return { type: 'clearOverride', key: newKey }
    // From global: undoing turns the global switch on, which is exact only if it was on.
    if (ref.project === null && !ref.enabled) return undefined
    return { type: 'move', key: newKey, to: back, copy: false }
  }
  // To global (switch on): exact only if it was off or unlisted before.
  if (priorValue === true) return undefined
  if (copy) return prior === undefined ? undefined : { type: 'setEnabled', key: newKey, enabled: false }
  return ref.enabled ? { type: 'move', key: newKey, to: back, copy: false } : undefined
}

/** A warning when a team-file plugin value is hidden for you by your only-me file (local beats project). */
function hiddenWarning(paths: ClaudePaths, setup: Setup, check: NonNullable<Outcome['check']>): string | null {
  if (check.scope !== 'project') return null
  const plugin = setup.inventory.plugins.find((p) => p.id === check.id)
  if (plugin === undefined) return null
  const state = effectiveState(plugin, check.project)
  if (state.from !== 'local' || state.enabled === check.enabled) return null
  return `Your only-me file ${labels(paths).path(projectSettingsFile(check.project, 'local'))} sets plugin "${plugin.name}" ${state.enabled ? 'on' : 'off'}, and it wins there, so this team change does not apply to you.`
}

const mcpRef = (server: ScopedMcp): McpRef => ({ name: server.name, project: server.project, scope: server.scope, config: server.config })
const hookRef = (hook: ScopedHook): HookRef => ({
  project: hook.project,
  file: hook.file,
  event: hook.event,
  rawMatcher: hook.rawMatcher,
  command: hook.command,
  n: hook.n
})

/** Plain-English places: "global", "~/code/shop (only me)", "~/code/shop (team)"; skills and agents have no scope. */
function labels(paths: ClaudePaths) {
  const home = paths.claudeDir.slice(0, paths.claudeDir.lastIndexOf('/'))
  const path = (p: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)
  return {
    path,
    place: (kind: Kind, project: string | null, scope: string) =>
      project === null
        ? 'global'
        : kind === 'skills' || kind === 'agents'
          ? path(project)
          : `${path(project)} (${scope === 'project' ? 'team' : 'only me'})`
  }
}

// ---- keys

export const pluginKey = (project: string | null, scope: string, id: string) => `plugins:${JSON.stringify([project, scope, id])}`
export const entryKey = (kind: 'skills' | 'agents', entry: string) => `${kind}:${kind === 'skills' ? `${entry}/SKILL.md` : entry}`
export const mcpKey = (project: string | null, scope: string, name: string) => `mcp:${JSON.stringify([project, scope, name])}`
export const hookKey = (file: string, event: string, rawMatcher: string, command: string, n: number) =>
  `hooks:${JSON.stringify([file, event, rawMatcher, command, n])}`

// ---- reading

async function read(deps: BackendDeps): Promise<Read> {
  const { fs, paths } = deps
  const setup = await readSetup(fs, paths)
  const refs = new Map<string, Ref>()
  const items: Item[] = []
  const add = (item: Item, ref: Ref) => {
    items.push(item)
    refs.set(item.key, ref)
  }
  const base = { movable: true, description: '' }

  for (const plugin of setup.inventory.plugins) {
    const info = {
      id: plugin.id,
      version: plugin.version,
      contributes: plugin.contributes,
      sharesNameWith: plugin.sharesNameWith,
      installs: plugin.installs
    }
    const description = plugin.marketplace ? `from ${plugin.marketplace}` : ''
    if (setup.globalPlugins.includes(plugin.id)) {
      add(
        {
          ...base,
          key: pluginKey(null, 'user', plugin.id),
          kind: 'plugins',
          name: plugin.name,
          description,
          project: null,
          scope: 'user',
          source: settingsFile(paths),
          removable: false,
          plugin: { ...info, enabled: plugin.enabled, installed: plugin.installs.length > 0 }
        },
        { kind: 'plugins', id: plugin.id, project: null, scope: 'user', enabled: plugin.enabled }
      )
    }
    for (const override of plugin.overrides) {
      add(
        {
          ...base,
          key: pluginKey(override.project, override.scope, plugin.id),
          kind: 'plugins',
          name: plugin.name,
          description,
          project: override.project,
          scope: override.scope,
          source: projectSettingsFile(override.project, override.scope),
          removable: true,
          plugin: { ...info, enabled: override.enabled, installed: false }
        },
        { kind: 'plugins', id: plugin.id, project: override.project, scope: override.scope, enabled: override.enabled }
      )
    }
  }

  for (const entry of setup.entries) {
    // A relative link points somewhere else once the link sits in another folder.
    const relative = entry.link !== null && !entry.link.startsWith('/')
    add(
      {
        key: entryKey(entry.kind, entry.entry),
        kind: entry.kind,
        name: entry.name,
        description: entry.description,
        project: entry.project,
        scope: entry.scope,
        source: entry.entry,
        movable: !relative,
        ...(relative ? { notMovableReason: `It is a relative link (${entry.link}); moving it would break it.` } : {}),
        removable: true
      },
      { kind: 'entry', entry }
    )
  }

  for (const server of setup.mcpServers) {
    add(
      {
        ...base,
        key: mcpKey(server.project, server.scope, server.name),
        kind: 'mcp',
        name: server.name,
        description: server.target,
        project: server.project,
        scope: server.scope,
        source: server.file,
        removable: true,
        mcp: { transport: server.transport, target: server.target }
      },
      { kind: 'mcp', server }
    )
  }

  for (const hook of setup.hooks) {
    add(
      {
        ...base,
        key: hookKey(hook.file, hook.event, hook.rawMatcher, hook.command, hook.n),
        kind: 'hooks',
        name: hook.command,
        description: `${hook.event} · ${hook.matcher}`,
        project: hook.project,
        scope: hook.scope,
        source: hook.file,
        removable: true,
        hook: { event: hook.event, matcher: hook.matcher, command: hook.command }
      },
      { kind: 'hooks', hook }
    )
  }

  const backups = (await listAllBackups(fs, paths)).map(({ name, target, at }) => ({ name, target, at }))
  const view: View = {
    items: items.sort(byPlace),
    projects: setup.inventory.projects,
    versions: setup.versions,
    backups,
    problems: setup.problems
  }
  return { setup, view, refs }
}

const KINDS: Kind[] = ['plugins', 'skills', 'agents', 'mcp', 'hooks']
const SCOPES = ['user', 'project', 'local']

/** By class, then global before projects (sorted), team before only-me; stable within. */
function byPlace(a: Item, b: Item): number {
  return (
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    (a.project === null ? 0 : 1) - (b.project === null ? 0 : 1) ||
    (a.project ?? '').localeCompare(b.project ?? '') ||
    SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope)
  )
}
