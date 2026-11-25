// restore, snapshot and trash return, for every agent. These actions belong to no class (BACKUP_ACTIONS): the
// router runs them here, from what the provider declares in its `backups` (a BackupPlan), and a provider's
// runAction never sees them. Only three things vary per agent: its backup store, the files this app writes for it,
// and its entry folders (where a trashed skill or agent may go back). A restore that is not a file write (Gemini
// CLI reinstalls an extension from its install record) is the plan's small `restoreOwn` hook.
import { backUp, backupTarget, isTrashName, listBackups, restoreTrash, type BackupStore } from '../core/backups.ts'
import { guardedChange } from '../core/guarded-change.ts'
import type { Action, ActionResult } from '../adapters/view.ts'
import type { ProviderDeps } from './types.ts'

/** A file a backup is made of but that restore never writes back: the agent (or its CLI) owns it. */
export interface OwnedFile {
  file: string
  /** The refusal's reason, e.g. 'claude-owned'. */
  reason: string
  /** Why this app never writes it, as the end of "which ..." (e.g. "this app never writes"). */
  why: string
}

/** What an agent declares about its backups; everything else about restore and snapshot is shared. */
export interface BackupPlan {
  /** Names the agent in messages, e.g. 'Codex'. */
  owner: string
  store: BackupStore
  /** The files this app writes for the agent: snapshot backs up each that exists, restore writes back only these. */
  files: readonly string[]
  /** Files snapshot also backs up, but restore refuses with a hint to copy the backup back by hand. */
  owned?: readonly OwnedFile[]
  /** The folders a trashed skill or agent may go back to: its skill and agent folders, globally and per known project. */
  entryFolders: readonly string[]
  /** How a message names a path (~ for the home folder). */
  say: (path: string) => string
  /** Added to every restore message, e.g. when the agent applies a change only in new sessions. */
  note?: string
  /** The item key of a skill or agent put back from the trash, for its undo (a remove); none without it. */
  entryKey?: (target: string) => string
  /** A restore the agent runs its own way, or null for the shared file restore. Runs before any other check. */
  restoreOwn?: (restore: RestoreRequest) => Promise<ActionResult> | null
}

export interface RestoreRequest {
  name: string
  target: string
  /** The backup's content. */
  text: string
  /** The sha256 of a command the user approved, when the answer asked for one. */
  acceptCommand?: string
  versions: Record<string, string>
}

type BackupAction = Extract<Action, { type: 'restore' | 'snapshot' }>

const refuse = (reason: string, message: string): ActionResult => ({ ok: false, reason, message })

export async function runBackupAction(deps: ProviderDeps, plan: BackupPlan, action: BackupAction, versions: Record<string, string>): Promise<ActionResult> {
  return action.type === 'snapshot' ? snapshot(deps, plan) : restore(deps, plan, action, versions)
}

async function snapshot(deps: ProviderDeps, plan: BackupPlan): Promise<ActionResult> {
  const clock = deps.clock ?? (() => new Date())
  let count = 0
  for (const file of [...plan.files, ...(plan.owned ?? []).map((owned) => owned.file)]) {
    const text = await deps.fs.readText(file)
    if (text === null) continue
    await backUp(deps.fs, plan.store, file, text, clock)
    count++
  }
  if (count === 0) return refuse('missing', `There is no ${plan.owner} settings file to back up.`)
  return { ok: true, message: `Backed up ${count} settings file${count === 1 ? '' : 's'} to ${plan.say(plan.store.dir)}.` }
}

async function restore(deps: ProviderDeps, plan: BackupPlan, action: Extract<BackupAction, { type: 'restore' }>, versions: Record<string, string>): Promise<ActionResult> {
  const { fs } = deps
  const { name } = action
  const note = plan.note ? ` ${plan.note}` : ''
  if (typeof name !== 'string') return refuse('unknown-backup', 'That backup has no name.')
  const unknown = refuse('unknown-backup', `${name} is not a known backup.`)

  if (isTrashName(name)) {
    if (plan.entryFolders.length === 0) return unknown
    const restored = await restoreTrash(fs, plan.store, name, [...plan.entryFolders], plan.owner)
    if (!restored.ok) return refuse(restored.reason, restored.message)
    const undo: Action | undefined = plan.entryKey ? { type: 'remove', key: plan.entryKey(restored.target) } : undefined
    return { ok: true, message: `Put back ${plan.say(restored.target)}.${note}`, ...(undo ? { undo } : {}) }
  }

  const target = backupTarget(plan.store, name)
  const text = target !== null && (await listBackups(fs, plan.store)).includes(name) ? await fs.readText(`${plan.store.dir}/${name}`) : null
  if (target === null || text === null) return unknown

  const own = plan.restoreOwn?.({ name, target, text, ...(action.acceptCommand === undefined ? {} : { acceptCommand: action.acceptCommand }), versions })
  if (own) return own
  const owned = plan.owned?.find((entry) => entry.file === target)
  if (owned !== undefined) {
    return refuse(owned.reason, `${name} is a copy of ${plan.say(target)}, which ${owned.why}. To put it back by hand: cp "${plan.store.dir}/${name}" "${target}"`)
  }
  if (!plan.files.includes(target)) return refuse('refused', `${plan.say(target)} is not a file this app writes for ${plan.owner}.`)

  const restored = await guardedChange(
    { fs, exec: deps.exec, store: plan.store, clock: deps.clock ?? (() => new Date()), say: plan.say },
    { files: [target], versions, steps: [{ effect: { kind: 'text', file: target, text } }] }
  )
  if (!restored.ok) return restored
  const undo = restored.restore(target)
  return { ok: true, message: `Restored ${plan.say(target)} from its backup.${note}`, ...(undo ? { undo } : {}) }
}
