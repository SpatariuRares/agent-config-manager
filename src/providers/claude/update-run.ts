// Runs plugin and skill updates through their official CLIs and reports what changed, read back from the
// files those CLIs own. Nothing here accepts a marketplace-declared command on the user's behalf.
import { isObject, type Json } from './inventory.ts'
import type { FileSystem } from '../../core/ports.ts'
import type { ClaudePaths, PluginCli } from './ports.ts'
import { readInstalls, readSkillLock } from './update-sources.ts'

export interface VersionChange {
  scope: string
  project: string | null
  before: string | null
  after: string | null
}

export type PluginUpdateResult =
  | { ok: true; changes: VersionChange[] }
  | { ok: false; reason: 'needs-confirmation'; command: string; sha256: string }
  | { ok: false; reason: 'unknown-plugin' | 'cli-failed'; message: string; changes: VersionChange[] }

/**
 * Updates every install of a plugin (`claude plugin update`, in the install's project folder). `acceptCommand`
 * is passed only when the user confirmed exactly that command; when the CLI shows one to approve, the update
 * stops there and returns it.
 */
export async function updatePlugin(
  fs: FileSystem,
  cli: PluginCli,
  paths: ClaudePaths,
  id: string,
  acceptCommand?: string
): Promise<PluginUpdateResult> {
  const records = (await readInstalls(fs, paths)).get(id) ?? []
  if (records.length === 0) return { ok: false, reason: 'unknown-plugin', message: `${id} is not installed.`, changes: [] }
  const failures: string[] = []
  const ran: typeof records = []
  for (const record of records) {
    if (record.scope !== 'user' && record.project === null) {
      failures.push(`${record.scope}: no project folder recorded, skipped`)
      continue
    }
    const { ok, output } = await cli.pluginUpdate(id, record.scope, record.project, acceptCommand)
    const shown = shownCommand(output)
    if (shown !== null) return { ok: false, reason: 'needs-confirmation', ...shown }
    if (ok) ran.push(record)
    else failures.push(`${record.scope}${record.project ? ` (${record.project})` : ''}: ${output.trim()}`)
  }
  const after = (await readInstalls(fs, paths)).get(id) ?? []
  const changes = ran.map((record) => {
    const now = after.find((r) => r.scope === record.scope && r.project === record.project)
    return { scope: record.scope, project: record.project, before: record.version ?? record.commit, after: now ? (now.version ?? now.commit) : null }
  })
  if (failures.length > 0) return { ok: false, reason: 'cli-failed', message: failures.join('\n'), changes }
  return { ok: true, changes }
}

/**
 * The command `claude plugin update --json` asks the user to approve: a `shownCommand` carrying a `sha256`,
 * anywhere in the output's JSON. Read leniently: the output may hold other lines, and the command text may be
 * the `shownCommand` string itself or a field of it.
 */
export function shownCommand(output: string): { command: string; sha256: string } | null {
  const candidates = [output, ...output.split('\n')]
  const first = output.indexOf('{')
  const last = output.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(output.slice(first, last + 1))
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch {
      continue
    }
    const found = findShown(value, 0)
    if (found !== null) return found
  }
  return null
}

function findShown(value: unknown, depth: number): { command: string; sha256: string } | null {
  if (depth > 8 || (typeof value !== 'object' || value === null)) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findShown(item, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const node = value as Json
  const shown = node.shownCommand
  if (typeof shown === 'string' && typeof node.sha256 === 'string') return { command: shown, sha256: node.sha256 }
  if (isObject(shown) && typeof shown.sha256 === 'string') {
    const text = ['command', 'text', 'display', 'shown', 'value'].map((key) => shown[key]).find((v) => typeof v === 'string')
    const { sha256, ...rest } = shown
    return { command: typeof text === 'string' ? text : JSON.stringify(rest), sha256 }
  }
  for (const child of Object.values(node)) {
    const found = findShown(child, depth + 1)
    if (found !== null) return found
  }
  return null
}

export type SkillUpdateResult =
  | { ok: true; before: string | null; after: string | null }
  | { ok: false; reason: 'cli-failed'; message: string }

/** Updates a skill installed by the `skills` CLI, and reads its content hash from the lock before and after. */
export async function updateSkill(fs: FileSystem, cli: PluginCli, paths: ClaudePaths, name: string): Promise<SkillUpdateResult> {
  const hashOf = async () => (await readSkillLock(fs, paths)).find((skill) => skill.name === name)?.hash ?? null
  const before = await hashOf()
  const { ok, output } = await cli.skillsUpdate(name)
  if (!ok) return { ok: false, reason: 'cli-failed', message: output.trim() }
  return { ok: true, before, after: await hashOf() }
}
