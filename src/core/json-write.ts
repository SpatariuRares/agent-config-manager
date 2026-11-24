// The versioned JSON write every provider uses: refuse a file that changed since the view read it, back it up,
// then replace it in one step. Which files an agent may write is the provider's check, made before calling this.
import { backUp, type BackupStore } from './backups.ts'
import { parseObject, versionOf, type Json } from './json.ts'
import type { Clock, FileSystem } from './ports.ts'

export type WriteResult =
  /** `backup` is null when nothing needed writing. */
  | { ok: true; backup: string | null }
  | { ok: false; reason: string; message: string }

export const CHANGED = { ok: false, reason: 'changed', message: 'The settings file changed since it was read. Refresh and try again.' } as const

export function unreadable(file: string): WriteResult {
  return { ok: false, reason: 'unreadable', message: `${file} is not a valid JSON object; it was left untouched.` }
}

/** Backs up `previous` (the file's current text), then writes `next` as 2-space JSON with a trailing newline. */
export async function replaceJson(fs: FileSystem, store: BackupStore, file: string, previous: string, next: Json, clock: Clock) {
  const backup = await backUp(fs, store, file, previous, clock)
  await fs.writeText(file, JSON.stringify(next, null, 2) + '\n')
  return { ok: true, backup } as const
}

export interface JsonEdit {
  file: string
  /** The view's version of the file ('' = it was missing). */
  version: string
  /** Changes the parsed file in place; returns a refusal message to write nothing. */
  edit: (json: Json) => string | void
}

/** Read, version check, edit, backup, write. A missing file is created from {}. */
export async function editJsonFile(fs: FileSystem, store: BackupStore, change: JsonEdit, clock: Clock): Promise<WriteResult> {
  const { file } = change
  const text = await fs.readText(file)
  if (versionOf(text) !== change.version) return CHANGED
  const json = text === null ? {} : parseObject(text)
  if (json === null) return unreadable(file)
  const refusal = change.edit(json)
  if (typeof refusal === 'string') return { ok: false, reason: 'refused', message: refusal }
  return replaceJson(fs, store, file, text ?? '{}\n', json, clock)
}
