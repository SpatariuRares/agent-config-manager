// Moves, copies and removes single hook commands between settings files, keeping event and matcher.
// Every write goes through updateJsonFile: version check, backup, then the write.
import { hookEntries, isObject, versionOf, type Json } from './inventory.ts'
import type { ClaudePaths, FileSystem } from './ports.ts'
import { updateJsonFile, type Clock } from './toggle.ts'

export interface HookRef {
  /** null for the user settings file. */
  project: string | null
  file: string
  event: string
  rawMatcher: string
  command: string
  n: number
}

export interface HookTarget {
  project: string | null
  file: string
}

export type HookResult =
  | { ok: true; backups: string[] }
  | { ok: false; reason: string; message: string; backups: string[]; partial: boolean }

export async function moveHook(
  fs: FileSystem,
  paths: ClaudePaths,
  ref: HookRef,
  to: HookTarget,
  versions: Record<string, string>,
  copy: boolean,
  clock: Clock
): Promise<HookResult> {
  const refuse = (reason: string, message: string): HookResult => ({ ok: false, reason, message, backups: [], partial: false })
  if (to.file === ref.file) return refuse('same-place', `"${ref.command}" is already in ${to.file}.`)
  // Check both files before writing either, so a stale view changes nothing.
  for (const file of [ref.file, to.file]) {
    if (versionOf(await fs.readText(file)) !== (versions[file] ?? '')) {
      return refuse('changed', 'The settings file changed since it was read. Refresh and try again.')
    }
  }
  let hook: Json | undefined
  try {
    hook = find(JSON.parse((await fs.readText(ref.file)) ?? '{}'), ref)?.hook
  } catch {
    hook = undefined
  }
  if (hook === undefined) return refuse('changed', `"${ref.command}" is no longer in ${ref.file}.`)

  const added = await updateJsonFile(
    fs,
    paths,
    { project: to.project, file: to.file, version: versions[to.file] ?? '', edit: (json) => insert(json, ref, structuredClone(hook)) },
    clock
  )
  if (!added.ok) return { ok: false, reason: added.reason, message: added.message, backups: [], partial: false }
  const backups = added.backup === null ? [] : [added.backup]
  if (copy) return { ok: true, backups }
  const removed = await removeHook(fs, paths, ref, versions, clock)
  if (!removed.ok) return { ...removed, backups, partial: true }
  return { ok: true, backups: [...backups, ...removed.backups] }
}

export async function removeHook(
  fs: FileSystem,
  paths: ClaudePaths,
  ref: HookRef,
  versions: Record<string, string>,
  clock: Clock
): Promise<HookResult> {
  const result = await updateJsonFile(
    fs,
    paths,
    { project: ref.project, file: ref.file, version: versions[ref.file] ?? '', edit: (json) => remove(json, ref) },
    clock
  )
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message, backups: [], partial: false }
  return { ok: true, backups: result.backup === null ? [] : [result.backup] }
}

function find(json: Json, ref: HookRef) {
  return hookEntries(isObject(json) ? json : {}).find(
    (e) => e.event === ref.event && e.rawMatcher === ref.rawMatcher && e.command === ref.command && e.n === ref.n
  )
}

/** Adds the hook under its event, in the group with the same matcher (a new group when none). */
function insert(json: Json, ref: HookRef, hook: Json): string | void {
  if (hookEntries(json).some((e) => e.event === ref.event && e.rawMatcher === ref.rawMatcher && e.command === ref.command)) {
    return `"${ref.command}" is already there for ${ref.event}.`
  }
  json.hooks ??= {}
  if (!isObject(json.hooks)) return 'Its "hooks" is not an object; it was left untouched.'
  const groups = (json.hooks[ref.event] ??= [])
  if (!Array.isArray(groups)) return `Its "hooks.${ref.event}" is not a list; it was left untouched.`
  const group = groups.find(
    (g) => isObject(g) && Array.isArray(g.hooks) && (typeof g.matcher === 'string' ? g.matcher : '') === ref.rawMatcher
  )
  if (group) group.hooks.push(hook)
  else groups.push(ref.rawMatcher === '' ? { hooks: [hook] } : { matcher: ref.rawMatcher, hooks: [hook] })
}

/** Takes the hook out; an emptied group and an emptied event go too. */
function remove(json: Json, ref: HookRef): string | void {
  const entry = find(json, ref)
  if (entry === undefined) return `"${ref.command}" is no longer there.`
  const groups = json.hooks[ref.event]
  groups[entry.group].hooks.splice(entry.index, 1)
  if (groups[entry.group].hooks.length === 0) groups.splice(entry.group, 1)
  if (groups.length === 0) delete json.hooks[ref.event]
}
