// Where each item updates from, read from files only (no network): plugin installs, the `skills` CLI lock,
// and pinned npm packages or Homebrew binaries in MCP server commands. Read-only.
import { isObject, type Json } from './inventory.ts'
import type { ClaudePaths, FileSystem, Http } from './ports.ts'
import type { Entry } from './setup.ts'

/** The same shape as the panel's UpdateSource. */
export interface SourceInfo {
  type: 'plugin' | 'skills-cli' | 'npm' | 'manual'
  label: string
  current: string | null
  note?: string
}

/** A source plus what the check and the update need to act on it. */
export type UpdateTarget =
  | { type: 'plugin'; source: SourceInfo; id: string; name: string; marketplace: string; version: string | null; commit: string | null }
  | { type: 'skills-cli'; source: SourceInfo; name: string; repo: string; folder: string; hash: string }
  | { type: 'npm'; source: SourceInfo; pkg: string; version: string }
  | { type: 'manual'; source: SourceInfo }

export interface InstallRecord {
  scope: string
  project: string | null
  version: string | null
  commit: string | null
}

export interface LockedSkill {
  name: string
  /** owner/repo on GitHub. */
  repo: string
  /** The skill's folder inside the repo ('' for the root). */
  folder: string
  hash: string
}

/** The folder that holds ~/.claude, i.e. the home folder. */
export const homeOf = (paths: ClaudePaths) => paths.claudeDir.slice(0, paths.claudeDir.lastIndexOf('/'))
export const installedFile = (paths: ClaudePaths) => `${paths.claudeDir}/plugins/installed_plugins.json`
export const skillLockFile = (paths: ClaudePaths) => `${homeOf(paths)}/.agents/.skill-lock.json`

async function readJson(fs: FileSystem, path: string): Promise<Json> {
  try {
    const value = JSON.parse((await fs.readText(path)) ?? '{}')
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** Install records by plugin id, from installed_plugins.json. */
export async function readInstalls(fs: FileSystem, paths: ClaudePaths): Promise<Map<string, InstallRecord[]>> {
  const plugins = (await readJson(fs, installedFile(paths))).plugins
  const map = new Map<string, InstallRecord[]>()
  for (const [id, records] of Object.entries(isObject(plugins) ? plugins : {})) {
    if (!Array.isArray(records)) continue
    map.set(
      id,
      records.filter(isObject).map((record) => ({
        scope: String(record.scope ?? 'user'),
        project: text(record.projectPath),
        version: text(record.version),
        commit: text(record.gitCommitSha)
      }))
    )
  }
  return map
}

/** The source of an installed plugin: its marketplace, with its version (or commit when it has none). */
export function pluginTarget(id: string, records: InstallRecord[]): UpdateTarget | null {
  const install = records.find((record) => record.scope === 'user') ?? records[0]
  if (install === undefined) return null
  const at = id.lastIndexOf('@')
  const marketplace = at === -1 ? '' : id.slice(at + 1)
  const name = at === -1 ? id : id.slice(0, at)
  return {
    type: 'plugin',
    source: { type: 'plugin', label: marketplace, current: install.version ?? install.commit },
    id,
    name,
    marketplace,
    version: install.version,
    commit: install.commit
  }
}

/** Skills installed by the `skills` CLI, from ~/.agents/.skill-lock.json; only GitHub sources can be checked. */
export async function readSkillLock(fs: FileSystem, paths: ClaudePaths): Promise<LockedSkill[]> {
  const skills = (await readJson(fs, skillLockFile(paths))).skills
  const locked: LockedSkill[] = []
  for (const [name, entry] of Object.entries(isObject(skills) ? skills : {})) {
    if (!isObject(entry)) continue
    const repo = githubRepo(entry.source) ?? githubRepo(entry.sourceUrl)
    const path = text(entry.skillPath)
    const hash = text(entry.skillFolderHash)
    if (repo === null || path === null || hash === null) continue
    const folder = path.endsWith('/SKILL.md') ? path.slice(0, -'/SKILL.md'.length) : path === 'SKILL.md' ? '' : path
    locked.push({ name, repo, folder, hash })
  }
  return locked
}

function githubRepo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(value)
  return match ? match[1] : null
}

/**
 * The lock entry of a skill: the one whose installed folder (~/.agents/skills/<name>) is the skill's real
 * folder, or, for a global skill, the one with the skill's name or folder name.
 */
export async function skillTarget(fs: FileSystem, paths: ClaudePaths, lock: LockedSkill[], entry: Entry): Promise<UpdateTarget | null> {
  const real = await fs.realPath(entry.entry)
  const folderName = entry.entry.slice(entry.entry.lastIndexOf('/') + 1)
  const found =
    lock.find((skill) => real !== null && real === `${homeOf(paths)}/.agents/skills/${skill.name}`) ??
    (entry.project === null ? lock.find((skill) => skill.name === entry.name || skill.name === folderName) : undefined)
  if (found === undefined) return null
  return {
    type: 'skills-cli',
    source: { type: 'skills-cli', label: found.repo, current: found.hash },
    name: found.name,
    repo: found.repo,
    folder: found.folder,
    hash: found.hash
  }
}

const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn'])
/** `pkg@1.2.3` or `@scope/pkg@1.2.3`, pinned to an exact version. */
const PINNED = /^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

/** Where the package spec sits in an npx-style args list: `--package=<spec>`, `--package <spec>`, `-p <spec>`, or the first positional. */
function packageArg(args: string[]): { index: number; prefix: string } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (arg.startsWith('--package=')) return { index: i, prefix: '--package=' }
    if ((arg === '--package' || arg === '-p') && i + 1 < args.length) return { index: i + 1, prefix: '' }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return null
    if (!args[i].startsWith('-')) return { index: i, prefix: '' }
  }
  return null
}

/** The version-pinned npm package an MCP server is launched from (through npx and the like), or null. */
export function pinnedPackage(config: Json): { pkg: string; version: string } | null {
  const command = typeof config.command === 'string' ? config.command : ''
  const args: unknown[] = Array.isArray(config.args) ? config.args : []
  if (!RUNNERS.has(command.slice(command.lastIndexOf('/') + 1)) || !args.every((arg) => typeof arg === 'string')) return null
  const at = packageArg(args as string[])
  if (at === null) return null
  const match = PINNED.exec((args[at.index] as string).slice(at.prefix.length))
  return match ? { pkg: match[1], version: match[2] } : null
}

/** The config with the pinned version of its package replaced; every other field and argument unchanged. */
export function withPinnedVersion(config: Json, version: string): Json {
  const args = [...(config.args as string[])]
  const at = packageArg(args)
  const pinned = pinnedPackage(config)
  if (at === null || pinned === null) return config
  args[at.index] = `${at.prefix}${pinned.pkg}@${version}`
  return { ...config, args }
}

/** The source of an MCP server: a pinned npm package, a Homebrew binary (manual), or none. */
export async function mcpTarget(fs: FileSystem, config: Json): Promise<UpdateTarget | null> {
  const pinned = pinnedPackage(config)
  if (pinned !== null) {
    return { type: 'npm', source: { type: 'npm', label: pinned.pkg, current: pinned.version }, ...pinned }
  }
  const command = typeof config.command === 'string' ? config.command : ''
  if (!/^\/(opt\/homebrew|usr\/local\/Cellar)\//.test(command)) return null
  // /opt/homebrew/bin/x links to .../Cellar/<formula>/<version>/bin/x.
  const cellar = /\/Cellar\/([^/]+)\/([^/]+)\//.exec((await fs.realPath(command)) ?? command)
  const formula = cellar?.[1] ?? command.slice(command.lastIndexOf('/') + 1)
  const note = `Managed by Homebrew: run \`brew upgrade ${formula}\`.`
  return { type: 'manual', source: { type: 'manual', label: 'Homebrew', current: cellar?.[2] ?? null, note } }
}

/** -1, 0 or 1 by semver precedence (build metadata ignored), or null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  const x = parse(a)
  const y = parse(b)
  if (x === null || y === null) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return Math.sign(d)
  }
  if (x[4] === y[4]) return 0
  if (x[4] === undefined) return 1
  if (y[4] === undefined) return -1
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const numeric = /^\d+$/.test(p[i]) && /^\d+$/.test(q[i])
    const d = numeric ? Number(p[i]) - Number(q[i]) : p[i] < q[i] ? -1 : p[i] > q[i] ? 1 : 0
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

/** The registry's latest version of an npm package. */
export async function latestNpmVersion(http: Http, pkg: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const answer = await http.getJson(`https://registry.npmjs.org/${pkg}/latest`)
  if (!answer.ok) return { ok: false, error: answer.error }
  const version = isObject(answer.json) ? (text(answer.json.version)?.trim() || null) : null
  return version === null ? { ok: false, error: 'the registry answer has no version' } : { ok: true, version }
}
