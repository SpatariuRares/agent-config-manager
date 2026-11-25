// Claude Code's view and actions, behind the Claude provider (./index.ts). Composes the Claude modules here
// with the shared core; the router (../router.ts) has already checked the agent and that the action is supported.
import { createHash } from 'node:crypto'
import type { Action, ActionRequest, ActionResult, Item, Kind, Target } from '../../adapters/view.ts'
import {
  isObject,
  itemIndex,
  itemKey,
  listAllBackups,
  moveEntry,
  redactCommand,
  restoreOf,
  trashEntry,
  versionRefusal,
  type Clock,
  type EntryPlaces,
  type FileSystem,
  type ItemIndex,
  type ProviderDeps,
  type ProviderView
} from '../toolkit.ts'
import { marketplaceUpdate } from './cli.ts'
import { moveHook, removeHook, type HookRef } from './hooks.ts'
import { claudeBackups, claudePaths, effectiveState, knownProjects, projectSettingsFile, settingsFile, type ClaudePaths, type ProjectScope } from './inventory.ts'
import { mcpPlaceFile, moveMcp, removeMcp, replaceMcp, type McpRef } from './mcp.ts'
import { movePlugin, setPluginEnabled, setProjectPluginState } from './plugin-writes.ts'
import { entryDir, placeFile, readSetup, type Entry, type Place, type ScopedHook, type ScopedMcp, type Setup } from './setup.ts'
import { uninstallPlugin } from './uninstall.ts'
import { updatePlugin, updateSkill } from './update-run.ts'
import {
  compareVersions,
  latestNpmVersion,
  mcpTarget,
  pluginTarget,
  readInstalls,
  readSkillLock,
  skillTarget,
  withPinnedVersion,
  type UpdateTarget
} from './update-sources.ts'

export const CLAUDE = 'claude'

/** What an item key points at in the setup. */
export type Ref =
  | { kind: 'plugins'; id: string; project: string | null; scope: 'user' | 'project' | 'local'; enabled: boolean }
  | { kind: 'entry'; entry: Entry }
  | { kind: 'mcp'; server: ScopedMcp }
  | { kind: 'hooks'; hook: ScopedHook }

export interface Read {
  setup: Setup
  view: ProviderView
  /** The view's items, and the way back from a key to the item and its ref. */
  index: ItemIndex<Ref>
  /** Update sources by item key, with what checking and updating them needs. */
  targets: Map<string, UpdateTarget>
}

/** The Claude Code view, without the cross-agent fields the router adds. Throws when the setup cannot be read. */
export async function claudeView(deps: ProviderDeps): Promise<ProviderView> {
  return (await read(deps)).view
}

/** The items and their update sources, for the update check. */
export async function readUpdateTargets(deps: ProviderDeps): Promise<{ items: Item[]; targets: Map<string, UpdateTarget> }> {
  const { view, targets } = await read(deps)
  return { items: view.items, targets }
}

/**
 * Runs one action the router already checked (agent, detection, a well-formed request, a declared action). May throw;
 * the router reports it. A team-file plugin write hidden by the only-me file comes back with a warning.
 */
export async function claudeAction(deps: ProviderDeps, request: ActionRequest): Promise<ActionResult> {
  const outcome = await perform(deps, request)
  if (outcome.result.ok && outcome.check) {
    const paths = claudePaths(deps.home)
    try {
      const warning = hiddenWarning(paths, await readSetup(deps.fs, paths), outcome.check)
      if (warning !== null) outcome.result = { ...outcome.result, warning }
    } catch {
      // The router reads the view next and reports what cannot be read.
    }
  }
  return outcome.result
}

export const NOTE = 'Changes apply to new Claude Code sessions, or after /reload-plugins.'
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

async function perform(deps: ProviderDeps, request: ActionRequest): Promise<Outcome> {
  const { fs } = deps
  const paths = claudePaths(deps.home)
  const clock = deps.clock ?? (() => new Date())
  const { action, versions } = request

  if (action.type === 'refreshMarketplaces') {
    const refreshed = await marketplaceUpdate(deps.exec)
    if (!refreshed.ok) return refuse('cli-failed', `Could not refresh the plugin marketplaces: ${refreshed.output.trim()}`)
    return done('Refreshed the plugin marketplaces. Check for updates again to see what is new.', undefined, false)
  }
  if (action.type === 'updateAll') return updateAll(deps, clock, action, versions)

  const before = await read(deps)
  const found = before.index.lookup((action as { key?: unknown }).key)
  if (!found.ok) return { result: found }
  const { item, ref } = found
  const named = `${NOUN[item.kind]} "${item.name}"`
  const from = labels(paths).place(item.kind, item.project, item.scope)

  switch (action.type) {
    case 'setEnabled': {
      if (ref.kind !== 'plugins') return refuse('unsupported', 'Only plugins have an on/off switch.')
      const enabled = action.enabled === true
      const written =
        ref.project === null
          ? await setPluginEnabled(fs, paths, ref.id, enabled, versions[settingsFile(paths)] ?? '', clock)
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
        const stale = await versionRefusal({ fs }, [ref.entry.path], versions)
        if (stale !== null) return refuse(stale.reason, stale.message)
        const trashed = await trashEntry(fs, claudeBackups(paths), ref.entry.entry, clock)
        if (!trashed.ok) return refuse(trashed.reason, trashed.message)
        return done(`Removed ${named} from ${from}. It is in the backups list if you need it back.`, { type: 'restore', name: trashed.name })
      }
      if (ref.kind === 'mcp') {
        const removed = await removeMcp(deps, mcpRef(ref.server), versions, clock)
        if (!removed.ok) return refuse(removed.reason, removed.message)
        return done(`Removed ${named} from ${from}.`, mcpUndo(paths, removed, ref.server))
      }
      const removed = await removeHook(fs, paths, hookRef(ref.hook), versions, clock)
      if (!removed.ok) return refuse(removed.reason, removed.message)
      return done(`Removed ${named} from ${from}.`, removed.restore(ref.hook.file))
    }

    case 'uninstall': {
      if (ref.kind !== 'plugins') return refuse('unsupported', 'Only plugins can be uninstalled.')
      const result = await uninstallPlugin(deps, ref.id)
      if (!result.ok) return refuse(result.reason, result.message)
      return done(`Uninstalled ${named}.`)
    }

    case 'move':
      return move(deps, clock, before, ref, item, action, versions)

    case 'update':
      return update(deps, clock, before, ref, item, typeof action.acceptCommand === 'string' ? action.acceptCommand : undefined, versions)

    default:
      return refuse('unsupported', `Unknown action ${String((action as { type: unknown }).type)}.`)
  }
}

async function move(
  deps: ProviderDeps,
  clock: Clock,
  before: Read,
  ref: Ref,
  item: Item,
  action: Extract<Action, { type: 'move' }>,
  versions: Record<string, string>
): Promise<Outcome> {
  const { fs } = deps
  const paths = claudePaths(deps.home)
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
    // Like Codex: the SKILL.md or agent file must still be what the view showed.
    const stale = await versionRefusal({ fs }, [ref.entry.path], versions)
    if (stale !== null) return refuse(stale.reason, stale.message)
    const moved = await moveEntry(fs, entryPlaces(fs, paths), ref.entry, to.project, copy)
    if (!moved.ok) return refuse(moved.reason, moved.message)
    const key = entryKey(ref.entry.kind, moved.path)
    return done(message, undoFor(key))
  }

  if (ref.kind === 'mcp') {
    const moved = await moveMcp(deps, mcpRef(ref.server), to, versions, copy, clock)
    if (moved.ok) return done(message, undoFor(mcpKey(to.project, to.scope, ref.server.name)))
    return refuse(moved.reason, moved.message)
  }

  if (ref.kind === 'hooks') {
    const { hook } = ref
    const file = placeFile(paths, to)
    const moved = await moveHook(fs, paths, hookRef(hook), { project: to.project, file }, versions, copy, clock)
    if (moved.ok) return done(message, undoFor(hookKey(file, hook.event, hook.rawMatcher, hook.command, 0)))
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
  // A partial move's message already says which write worked, which failed, and the backups that put them back.
  if (!moved.ok) return refuse(moved.reason, moved.message)
  const newKey = pluginKey(to.project, to.scope, ref.id)
  const outcome = done(message, pluginUndo(before, ref, to, copy, newKey, back))
  return to.project === null ? outcome : { ...outcome, check: { id: ref.id, project: to.project, scope: to.scope as ProjectScope, enabled } }
}

const cap = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`
const RESTART = 'Restart Claude Code to use the new version.'
const short = (value: string | null) => (value === null ? 'unknown' : /^[0-9a-f]{13,}$/.test(value) ? value.slice(0, 12) : value)

/** Updates one item from its update source. A command the marketplace asks to approve is returned, never accepted. */
async function update(
  deps: ProviderDeps,
  clock: Clock,
  before: Read,
  ref: Ref,
  item: Item,
  acceptCommand: string | undefined,
  versions: Record<string, string>
): Promise<Outcome> {
  const paths = claudePaths(deps.home)
  const target = before.targets.get(item.key)
  const named = `${NOUN[item.kind]} "${item.name}"`
  if (target === undefined) {
    if (ref.kind === 'plugins') {
      const owner = before.view.items.find((i) => i.plugin?.id === ref.id && before.targets.has(i.key))
      if (owner === undefined) return refuse('unsupported', `${cap(named)} is not installed, so there is nothing to update.`)
      return refuse('unsupported', `Update ${named} from its item in ${labels(paths).place(owner.kind, owner.project, owner.scope)}.`)
    }
    return refuse('unsupported', `${cap(named)} has no update source: it was not installed from a marketplace, the skills CLI or a pinned npm package.`)
  }

  if (target.type === 'manual') return refuse('unsupported', `This app does not update ${named}. ${target.source.note ?? ''}`.trim())

  if (target.type === 'plugin') {
    // The sha comes back from the panel: accept only what a sha can look like, never an option.
    if (acceptCommand !== undefined && !/^[0-9a-f]+$/i.test(acceptCommand)) {
      return refuse('refused', `The approval for ${named} is not a valid command hash, so nothing ran.`)
    }
    const result = await updatePlugin(deps, target.id, acceptCommand)
    if (!result.ok && result.reason === 'needs-confirmation') {
      return {
        result: {
          ok: false,
          reason: 'needs-confirmation',
          message: `Updating ${named} runs a command declared by its marketplace. Review it, then confirm to continue: ${result.command}`,
          confirm: { command: result.command, action: { type: 'update', key: item.key, acceptCommand: result.sha256 } }
        }
      }
    }
    const label = labels(paths)
    const changed = result.changes.filter((change) => change.before !== change.after)
    const describe = result.changes.map((change) => {
      const where = change.project === null ? 'global' : `${label.path(change.project)} (${change.scope})`
      return change.before === change.after
        ? `${where}: already at ${short(change.after)}`
        : `${where}: ${short(change.before)} to ${short(change.after)}`
    })
    if (!result.ok) {
      const soFar = describe.length > 0 ? ` Updated so far: ${describe.join('; ')}.` : ''
      return refuse(result.reason, `Could not update ${named}: ${result.message.trim()}${soFar}`)
    }
    if (changed.length === 0) {
      return done(`${cap(named)} is already at ${short(result.changes[0]?.after ?? null)}; nothing changed.`, undefined, false)
    }
    const message =
      result.changes.length === 1
        ? `Updated ${named} from ${short(changed[0].before)} to ${short(changed[0].after)}.`
        : `Updated ${named}: ${describe.join('; ')}.`
    return done(`${message} ${RESTART}`, undefined, false)
  }

  if (target.type === 'skills-cli') {
    const result = await updateSkill(deps, target.name)
    if (!result.ok) return refuse(result.reason, `Could not update ${named}: ${result.message}`)
    if (result.before === result.after) return done(`${cap(named)} from ${target.repo} is already up to date.`, undefined, false)
    return done(`Updated ${named} from ${target.repo} (${short(result.before)} to ${short(result.after)}).`)
  }

  // npm: rewrite the pinned version through the CLI, in the server's own scope.
  if (ref.kind !== 'mcp') return refuse('unsupported', `${named} has no npm package to update.`)
  if (deps.http === undefined) return refuse('unsupported', 'Updating an npm package needs the network, which is not available here.')
  const latest = await latestNpmVersion(deps.http, target.pkg)
  if (!latest.ok) return refuse('check-failed', `Could not get the latest version of ${target.pkg} from npm: ${latest.error}`)
  const order = compareVersions(latest.version, target.version)
  if (order === null) {
    return refuse('check-failed', `npm says the latest ${target.pkg} is "${latest.version}", which cannot be compared with ${target.version}; nothing changed.`)
  }
  if (order <= 0) {
    return done(`${cap(named)} is already at the latest version (${target.version}).`, undefined, false)
  }
  const server = ref.server
  const replaced = await replaceMcp(deps, mcpRef(server), withPinnedVersion(server.config, latest.version), versions, clock)
  const from = labels(paths).place(item.kind, item.project, item.scope)
  if (!replaced.ok) return refuse(replaced.reason, replaced.message)
  return done(`Updated ${named} from ${target.pkg}@${target.version} to ${latest.version} in ${from}.`, mcpUndo(paths, replaced, server))
}

/** Updates each key in turn and reports every outcome. A key that needs a command approved is skipped. */
async function updateAll(
  deps: ProviderDeps,
  clock: Clock,
  action: Extract<Action, { type: 'updateAll' }>,
  versions: Record<string, string>
): Promise<Outcome> {
  const keys = Array.isArray(action.keys) ? action.keys.filter((key): key is string => typeof key === 'string') : []
  if (keys.length === 0) return refuse('unsupported', 'There is nothing to update.')
  const lines: string[] = []
  let updated = 0
  for (const key of keys) {
    const current = await read(deps)
    const found = current.index.lookup(key)
    if (!found.ok) {
      lines.push(`${key}: no longer there, skipped.`)
      continue
    }
    const { item, ref } = found
    const named = `${NOUN[item.kind]} "${item.name}"`
    if (item.kind !== action.kind) {
      lines.push(`${named}: not in this tab, skipped.`)
      continue
    }
    // Files this run already changed have new versions; the rest are checked against the view the user acted on.
    const outcome = await update(deps, clock, current, ref, item, undefined, updated > 0 ? current.view.versions : versions)
    if (outcome.result.ok) updated++
    if (!outcome.result.ok && outcome.result.reason === 'needs-confirmation') {
      lines.push(`${named}: needs your approval of a command declared by its marketplace, so it was skipped. Update it on its own to review the command.`)
    } else {
      lines.push(outcome.result.message.replace(` ${NOTE}`, ''))
    }
  }
  const message = `Updated ${updated} of ${keys.length}:\n${lines.map((line) => `- ${line}`).join('\n')}`
  if (updated === keys.length) return done(message, undefined, false)
  return refuse(updated > 0 ? 'partial' : 'failed', message)
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
  const found = before.index.lookup(pluginKey(to.project, to.scope, ref.id))
  const prior = found.ok ? found.ref : undefined
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

/** The restore of an MCP change's backup, unless it is of ~/.claude.json, which Claude Code owns (no undo then). */
function mcpUndo(paths: ClaudePaths, result: { restore: (file: string) => Action | undefined }, place: Place): Action | undefined {
  const file = mcpPlaceFile(paths, place)
  return file === paths.userConfigFile ? undefined : result.restore(file)
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

/** Claude Code's skill and agent folders, for the toolkit's moveEntry. */
export const entryPlaces = (fs: FileSystem, paths: ClaudePaths): EntryPlaces => ({
  dirOf: (kind, project) => entryDir(paths, kind, project),
  projects: () => knownProjects(fs, paths),
  owner: 'Claude Code'
})

// ---- keys (itemKey): what each class's key names, in the same parts wherever a key is built

const pluginKey = (project: string | null, scope: string, id: string) => itemKey('plugins', project, scope, id)
/** A skill folder or an agent file. */
export const entryKey = (kind: 'skills' | 'agents', entry: string) => itemKey(kind, entry)
export const mcpKey = (project: string | null, scope: string, name: string) => itemKey('mcp', project, scope, name)
/** The command is hashed, so a secret in it never reaches the panel through the key. */
const hookKey = (file: string, event: string, rawMatcher: string, command: string, n: number) =>
  itemKey('hooks', file, event, rawMatcher, createHash('sha256').update(command).digest('hex').slice(0, 16), n)

// ---- reading

export async function read(deps: ProviderDeps): Promise<Read> {
  const { fs } = deps
  const paths = claudePaths(deps.home)
  const setup = await readSetup(fs, paths)
  const index = itemIndex<Ref>()
  const add = (item: Item, ref: Ref) => void index.add(item, ref)
  const base = { agent: CLAUDE, movable: true, description: '' }
  const targets = new Map<string, UpdateTarget>()
  const withSource = (item: Item, target: UpdateTarget | null): Item => {
    if (target === null) return item
    targets.set(item.key, target)
    return { ...item, updateSource: target.source }
  }
  const installs = await readInstalls(fs, paths)
  const lock = await readSkillLock(fs, paths)

  for (const plugin of setup.inventory.plugins) {
    const info = {
      id: plugin.id,
      version: plugin.version,
      contributes: plugin.contributes,
      sharesNameWith: plugin.sharesNameWith,
      installs: plugin.installs
    }
    const description = plugin.marketplace ? `from ${plugin.marketplace}` : ''
    // One item per plugin carries its update source: the global one, else the first project override.
    const target = pluginTarget(plugin.id, installs.get(plugin.id) ?? [])
    const global = setup.globalPlugins.includes(plugin.id)
    if (global) {
      add(
        withSource({
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
        }, target),
        { kind: 'plugins', id: plugin.id, project: null, scope: 'user', enabled: plugin.enabled }
      )
    }
    plugin.overrides.forEach((override, n) => {
      add(
        withSource({
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
        }, !global && n === 0 ? target : null),
        { kind: 'plugins', id: plugin.id, project: override.project, scope: override.scope, enabled: override.enabled }
      )
    })
  }

  for (const entry of setup.entries) {
    // A relative link points somewhere else once the link sits in another folder.
    const relative = entry.link !== null && !entry.link.startsWith('/')
    add(
      withSource({
        agent: CLAUDE,
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
      }, entry.kind === 'skills' ? await skillTarget(fs, paths, lock, entry) : null),
      { kind: 'entry', entry }
    )
  }

  for (const server of setup.mcpServers) {
    add(
      withSource({
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
      }, await mcpTarget(fs, server.config)),
      { kind: 'mcp', server }
    )
  }

  for (const hook of setup.hooks) {
    add(
      {
        ...base,
        key: hookKey(hook.file, hook.event, hook.rawMatcher, hook.command, hook.n),
        kind: 'hooks',
        name: redactCommand(hook.command),
        description: `${hook.event} · ${hook.matcher}`,
        project: hook.project,
        scope: hook.scope,
        source: hook.file,
        removable: true,
        hook: { event: hook.event, matcher: hook.matcher, command: redactCommand(hook.command) }
      },
      { kind: 'hooks', hook }
    )
  }

  const backups = (await listAllBackups(fs, claudeBackups(paths))).map(({ name, target, at }) => ({ name, target, at }))
  const built = index.build(byPlace)
  const view: ProviderView = {
    items: built.items,
    projects: setup.inventory.projects,
    versions: setup.versions,
    backups,
    problems: setup.problems
  }
  return { setup, view, index: built, targets }
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
