// The guarded change: the one module every provider changes an agent's files through, by its own write or by
// running the agent's CLI. Its interface is one call, guardedChange(deps, change), and behind it the whole safety
// sequence lives in one place:
//   1. every file the change touches must still be at the version the view read (else `changed`);
//   2. each one that exists is backed up into the agent's store;
//   3. the effect runs: a JSON edit of one file, a text replace of one file (a restore), or a CLI argv run through
//      the CommandRunner port (never a shell);
//   4. the optional post-condition reads the files again and says whether the intended change is there, which
//      catches a CLI that exits 0 and did nothing (`did-not-change`);
//   5. a second step (a move: add, then remove) runs only after the first worked; if it fails the change is
//      `partial`, and the message names the backups that put the files back.
// Its only dependencies are the FileSystem and CommandRunner ports, so it is tested through this interface with
// fakeFs and fakeExec. Each refusal has one wording, here.
import { backUp, type BackupStore } from './backups.ts'
import { parseObject, versionOf, type Json } from './json.ts'
import type { Clock, CommandRunner, FileSystem } from './ports.ts'
import { redactCommand } from './redact.ts'

export interface ChangeDeps {
  fs: FileSystem
  /** Required for a CLI effect; a change of JSON or text effects alone runs nothing. */
  exec?: CommandRunner
  /** The agent's backup store. */
  store: BackupStore
  clock: Clock
  /** How a message names a path (e.g. `~/.gemini/settings.json`); the path as is by default. */
  say?: (path: string) => string
}

export type Effect =
  /** Edits one file of the change as JSON, in place; returning a message refuses. A missing file starts as {}. */
  | { kind: 'json'; file: string; edit: (json: Json) => string | void }
  /** Replaces one file of the change with this text, as is (a restore keeps comments and format). */
  | { kind: 'text'; file: string; text: string }
  /** Runs the agent's CLI by argv through the CommandRunner. */
  | { kind: 'cli'; command: string; argv: readonly string[]; cwd: string | null; options?: { timeoutMs?: number; closeStdin?: boolean } }

export interface Step {
  effect: Effect
  /** What a CLI run acts on, for messages: `gemini mcp add for context7`. Messages never show the whole argv. */
  about?: string
  /**
   * The post-condition: reads the files again after the effect (`output` is the CLI's, '' for a file edit);
   * false when the intended change is not there. `file` is what a did-not-change message names.
   */
  check?: { file: string; holds: (fs: FileSystem, output: string) => Promise<boolean> }
  /** Added to a cli-failed or did-not-change message, e.g. the command to run in a terminal to see why. */
  hint?: string
}

export interface Change {
  /** Every file the change touches: version checked, and backed up when it exists. */
  files: readonly string[]
  /** The view's versions (versionOf of each file it read; missing or '' = the file was missing). */
  versions: Readonly<Record<string, string>>
  /**
   * Files backed up but never version checked. Only for a file the agent itself rewrites all the time, so a
   * version from the view is always stale and the check would refuse every change (Claude Code's ~/.claude.json,
   * which only its CLI writes here).
   */
  unversioned?: readonly string[]
  /** One effect, or two: the second runs only after the first worked. */
  steps: readonly [Step] | readonly [Step, Step]
}

export type ChangeRefusal =
  | { ok: false; reason: 'changed' | 'unreadable' | 'refused' | 'did-not-change' | 'partial'; message: string }
  /**
   * `output` is the CLI's whole output, redacted, for the caller to read (a consent question, say). It is not
   * enumerable, so a refusal passed on as an ActionResult never carries it to the panel: the message has its tail.
   */
  | { ok: false; reason: 'cli-failed'; message: string; readonly output: string }

export type ChangeResult =
  | {
      ok: true
      /** File -> its backup path. Empty when nothing needed writing. */
      backups: ReadonlyMap<string, string>
      /** The last CLI step's output ('' without one). */
      output: string
      /** The undo that puts `file` back from the backup made first, or undefined when none was made. */
      restore: (file: string) => RestoreUndo | undefined
    }
  | ChangeRefusal

export interface RestoreUndo {
  type: 'restore'
  name: string
}

/** The undo that puts a backup back: a restore of it by name. */
export const restoreOf = (backup: string | null | undefined): RestoreUndo | undefined =>
  backup ? { type: 'restore', name: backup.slice(backup.lastIndexOf('/') + 1) } : undefined

/** `changed` when any of `files` is no longer at the view's version, else null. For effects that are no file edit. */
export async function versionRefusal(deps: Pick<ChangeDeps, 'fs' | 'say'>, files: readonly string[], versions: Readonly<Record<string, string>>): Promise<ChangeRefusal | null> {
  for (const file of files) {
    if (versionOf(await deps.fs.readText(file)) !== (versions[file] ?? '')) return changed(deps, file)
  }
  return null
}

export async function guardedChange(deps: ChangeDeps, change: Change): Promise<ChangeResult> {
  const { fs } = deps
  const say = deps.say ?? ((path: string) => path)
  const texts = new Map<string, string | null>()
  for (const file of change.files) {
    const text = await fs.readText(file)
    if (!change.unversioned?.includes(file) && versionOf(text) !== (change.versions[file] ?? '')) return changed(deps, file)
    texts.set(file, text)
  }

  // A first JSON edit is made in memory before anything is backed up: a refusal or a no-op leaves no trace.
  const [first, second] = change.steps
  let prepared: Edited | null = null
  if (first.effect.kind === 'json') {
    const edited = editJson(texts.has(first.effect.file) ? texts.get(first.effect.file)! : await fs.readText(first.effect.file), first.effect.edit, say(first.effect.file))
    if (!edited.ok) return edited
    if (edited.text === null && second === undefined) return { ok: true, backups: new Map(), output: '', restore: () => undefined }
    prepared = edited
  }

  const backups = new Map<string, string>()
  for (const [file, text] of texts) {
    // A missing file a JSON edit creates is backed up as {}, so its undo can empty it again.
    const previous = text ?? (change.steps.some(({ effect }) => effect.kind === 'json' && effect.file === file) ? '{}\n' : null)
    if (previous !== null) backups.set(file, await backUp(fs, deps.store, file, previous, deps.clock))
  }

  const done = await apply(deps, first, prepared)
  if (!done.ok) return done.refusal
  let output = done.output
  if (second !== undefined) {
    const next = await apply(deps, second, null)
    if (!next.ok) {
      const names = [...backups.values()].map((path) => path.slice(path.lastIndexOf('/') + 1))
      const put = names.length > 0 ? ` The backups made first can put the files back: ${names.join(', ')}.` : ''
      return { ok: false, reason: 'partial', message: `${label(first, say)} worked; then ${next.why}.${put}` }
    }
    output = next.output
  }
  return { ok: true, backups, output, restore: (file) => restoreOf(backups.get(file)) }
}

type Applied = { ok: true; output: string } | { ok: false; refusal: ChangeRefusal; why: string }

/** Runs one step's effect, then its post-condition. `prepared` is the first JSON edit, already made. */
async function apply(deps: ChangeDeps, step: Step, prepared: Edited | null): Promise<Applied> {
  const { fs } = deps
  const say = deps.say ?? ((path: string) => path)
  const { effect } = step
  const name = label(step, say)
  const hint = step.hint ? ` ${step.hint}` : ''
  let output = ''
  if (effect.kind === 'cli') {
    if (deps.exec === undefined) throw new Error('A CLI effect needs a CommandRunner.')
    const result = await deps.exec.run(effect.command, effect.argv, effect.cwd, effect.options)
    output = result.output
    if (!result.ok) {
      const why = `${name} failed: ${tail(output)}`
      return { ok: false, refusal: cliFailed(`${why}.${hint}`, output), why }
    }
  } else if (effect.kind === 'text') {
    await fs.writeText(effect.file, effect.text)
  } else {
    const edited = prepared ?? editJson(await fs.readText(effect.file), effect.edit, say(effect.file))
    if (!edited.ok) return { ok: false, refusal: edited, why: `${name} was refused: ${edited.message.replace(/\.$/, '')}` }
    if (edited.text !== null) await fs.writeText(effect.file, edited.text)
  }
  if (step.check !== undefined && !(await step.check.holds(fs, output))) {
    const why = `${name} exited without an error, but ${say(step.check.file)} does not show the change: ${tail(output)}`
    return { ok: false, refusal: { ok: false, reason: 'did-not-change', message: `${why}.${hint}` }, why }
  }
  return { ok: true, output }
}

type Edited = { ok: true; text: string | null } | (ChangeRefusal & { reason: 'unreadable' | 'refused' })

/** The edited file's text, or null when the edit changed nothing; a refusal when the edit refuses or cannot parse. */
function editJson(text: string | null, edit: (json: Json) => string | void, shown: string): Edited {
  const json = text === null ? {} : parseObject(text)
  if (json === null) return unreadable(shown)
  const before = JSON.stringify(json)
  const refusal = edit(json)
  if (typeof refusal === 'string') return { ok: false, reason: 'refused', message: refusal }
  if (text !== null && JSON.stringify(json) === before) return { ok: true, text: null }
  return { ok: true, text: JSON.stringify(json, null, 2) + '\n' }
}

function cliFailed(message: string, output: string): ChangeRefusal {
  const refusal = { ok: false, reason: 'cli-failed', message } as const
  return Object.defineProperty(refusal, 'output', { value: redactCommand(output), enumerable: false }) as ChangeRefusal
}

/** The refusal for a file that is not a valid JSON object (or JSON with comments), named as `shown`. */
export const unreadable = (shown: string) => ({ ok: false, reason: 'unreadable', message: `${shown} is not a valid JSON object; it was left untouched.` }) as const

const changed = (deps: Pick<ChangeDeps, 'say'>, file: string): ChangeRefusal => ({
  ok: false,
  reason: 'changed',
  message: `${(deps.say ?? ((path: string) => path))(file)} changed since it was read. Refresh and try again.`
})

/** How a message names a step: `<command> <subcommand> for <about>`, or `the edit of <file>`. Never argv values. */
function label(step: Step, say: (path: string) => string): string {
  const { effect } = step
  if (effect.kind !== 'cli') return `the edit of ${say(effect.file)}`
  return `${[effect.command, ...effect.argv.slice(0, 2)].join(' ')}${step.about ? ` for ${step.about}` : ''}`
}

/** The last lines of a CLI's output, for a message, with anything secret-looking redacted. */
const tail = (output: string) => redactCommand(output.trim().split('\n').slice(-3).join(' ').slice(0, 400)) || 'no output'
