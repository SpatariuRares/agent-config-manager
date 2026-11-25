// Moves, copies and removes single hook commands between settings files, keeping event and matcher.
// Every write is a guarded change: version check of each file, backup, then the edit; a move is one change of two
// steps (add, then remove), so a stale view writes nothing and a failed remove is `partial`.
import { guardedChange, type ChangeResult } from '../../core/guarded-change.ts'
import { hookEntries, isObject, type Json } from './inventory.ts'
import type { FileSystem } from '../../core/ports.ts'
import type { ClaudePaths } from './ports.ts'
import { claudeBackups, writeRefusal, type Clock } from './toggle.ts'

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

export type HookResult = ChangeResult | { ok: false; reason: string; message: string }

const refuse = (reason: string, message: string): HookResult => ({ ok: false, reason, message })

export async function moveHook(
  fs: FileSystem,
  paths: ClaudePaths,
  ref: HookRef,
  to: HookTarget,
  versions: Record<string, string>,
  copy: boolean,
  clock: Clock
): Promise<HookResult> {
  if (to.file === ref.file) return refuse('same-place', `"${ref.command}" is already in ${to.file}.`)
  const writes: [string | null, string][] = copy ? [[to.project, to.file]] : [[to.project, to.file], [ref.project, ref.file]]
  for (const [project, file] of writes) {
    const refused = await writeRefusal(fs, paths, project, file)
    if (refused !== null) return refused
  }
  let hook: Json | undefined
  try {
    hook = find(JSON.parse((await fs.readText(ref.file)) ?? '{}'), ref)?.hook
  } catch {
    hook = undefined
  }
  if (hook === undefined) return refuse('changed', `"${ref.command}" is no longer in ${ref.file}.`)
  const add = { effect: { kind: 'json' as const, file: to.file, edit: (json: Json) => insert(json, ref, structuredClone(hook)) } }
  const remove = { effect: { kind: 'json' as const, file: ref.file, edit: (json: Json) => removeFrom(json, ref) } }
  return guardedChange(
    { fs, store: claudeBackups(paths), clock },
    { files: copy ? [to.file] : [to.file, ref.file], versions, steps: copy ? [add] : [add, remove] }
  )
}

export async function removeHook(
  fs: FileSystem,
  paths: ClaudePaths,
  ref: HookRef,
  versions: Record<string, string>,
  clock: Clock
): Promise<HookResult> {
  const refused = await writeRefusal(fs, paths, ref.project, ref.file)
  if (refused !== null) return refused
  return guardedChange(
    { fs, store: claudeBackups(paths), clock },
    { files: [ref.file], versions, steps: [{ effect: { kind: 'json', file: ref.file, edit: (json) => removeFrom(json, ref) } }] }
  )
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
function removeFrom(json: Json, ref: HookRef): string | void {
  const entry = find(json, ref)
  if (entry === undefined) return `"${ref.command}" is no longer there.`
  const groups = json.hooks[ref.event]
  groups[entry.group].hooks.splice(entry.index, 1)
  if (groups[entry.group].hooks.length === 0) groups.splice(entry.group, 1)
  if (groups.length === 0) delete json.hooks[ref.event]
}
