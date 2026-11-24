// Reads the Codex setup into the panel's items, plus what the writes need (refs). Read-only.
// Every format here is cited in the comment block at the top of ./index.ts.
import { parse } from 'smol-toml'
import type { Item, Scope } from '../../adapters/view.ts'
import {
  argsHaveSecret,
  existingProjects,
  isObject,
  itemKey,
  listAllBackups,
  readEntryDir,
  readJson,
  readSkills,
  redactArgs,
  redactCommand,
  redactUrl,
  sameFolder,
  tilde,
  versionOf,
  type BackupStore,
  type EntryKind,
  type EntryRef,
  type FileSystem,
  type Json,
  type ProviderDeps,
  type ProviderView
} from '../toolkit.ts'
import { appBackupDir } from '../toolkit.ts'

export const CODEX = 'codex'

export interface CodexPaths {
  home: string
  /** $CODEX_HOME, which defaults to ~/.codex. */
  codexHome: string
  /** The user config; this app never writes it (see ./index.ts). */
  config: string
  /** The user hooks file. */
  hooks: string
}

export const codexPaths = (home: string): CodexPaths => ({
  home,
  codexHome: `${home}/.codex`,
  config: `${home}/.codex/config.toml`,
  hooks: `${home}/.codex/hooks.json`
})

export const codexBackups = (paths: CodexPaths): BackupStore => ({
  dir: appBackupDir(paths.home, CODEX),
  aliases: { config: paths.config, hooks: paths.hooks }
})

/** Folders Codex reads skills from: user scope first, then a project's. */
export function skillDirs(paths: CodexPaths, project: string | null): string[] {
  if (project === null) return [`${paths.codexHome}/skills`, sharedSkillDir(paths, project)]
  return [sharedSkillDir(paths, project), `${project}/.codex/skills`]
}

/** The .agents/skills folder of a place: Gemini CLI and Copilot CLI read it too, so this app never changes it. */
export const sharedSkillDir = (paths: CodexPaths, project: string | null) => `${project ?? paths.home}/.agents/skills`

export const SHARED_SKILL_REASON = 'It is in a .agents/skills folder, which other agents (Gemini CLI, Copilot CLI) read too, so it is read-only here.'

/** Folders Codex reads custom agent files (`*.toml`) from. */
export const agentDir = (paths: CodexPaths, project: string | null) => (project === null ? `${paths.codexHome}/agents` : `${project}/.codex/agents`)

/** Where a move or copy puts a skill or agent: Codex's own folder of that place, never the shared .agents/skills. */
export function destinationDir(paths: CodexPaths, kind: EntryKind, project: string | null): string {
  if (kind === 'agents') return agentDir(paths, project)
  return project === null ? `${paths.codexHome}/skills` : `${project}/.codex/skills`
}

/** What a write needs to know about an item, by item key. */
export type Ref =
  | {
      kind: 'skills' | 'agents'
      entry: EntryRef
      /** The file whose version guards the write: SKILL.md or the agent file. */
      file: string
      project: string | null
      movable: boolean
      removable: boolean
      reason?: string
    }
  | {
      kind: 'mcp'
      name: string
      /** The config.toml that holds the server. */
      file: string
      project: string | null
      server: Json
    }

export interface CodexRead {
  view: ProviderView
  refs: Map<string, Ref>
  /** Projects listed in config.toml with trust_level = "trusted". */
  trusted: Set<string>
}

/** Server names `codex mcp add/remove` accept (validate_server_name in codex-rs/cli/src/mcp_cmd.rs). */
export const validServerName = (name: string) => /^[A-Za-z0-9_:@/.-]+$/.test(name)

/** A name this app passes to `codex mcp add/remove`: valid for Codex, and not read as an option (`-x`). */
export const usableServerName = (name: string) => validServerName(name) && !name.startsWith('-')

/** A stdio server `codex mcp add NAME -- COMMAND ARGS...` recreates exactly: nothing but command and args. */
export function copyableServer(server: Json): string | null {
  if (typeof server.command !== 'string') {
    return 'only stdio servers can be copied: `codex mcp add --url` may start a browser login'
  }
  const extra = Object.keys(server).filter((key) => key !== 'command' && key !== 'args')
  if (extra.length > 0) return `it has settings \`codex mcp add\` cannot carry (${extra.join(', ')})`
  if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string'))) {
    return 'its args are not a list of strings'
  }
  if (argsHaveSecret([server.command, ...(server.args ?? [])])) {
    return 'its command line holds a secret-looking value, and `codex mcp add` would put it where other programs can read it'
  }
  return null
}

/** The parsed TOML file, or null when it is missing or invalid (then a line goes to `problems`). */
async function readToml(fs: FileSystem, path: string, home: string, problems: string[], versions: Record<string, string>): Promise<Json | null> {
  const text = await fs.readText(path)
  versions[path] = versionOf(text)
  if (text === null) return null
  try {
    return parse(text) as Json
  } catch (error) {
    const first = String((error as Error).message ?? error).split('\n')[0]
    problems.push(`${tilde(home, path)} is not valid TOML (${first}); nothing from it is shown.`)
    return null
  }
}

const table = (value: unknown): Json => (isObject(value) ? value : {})

export async function readCodex(deps: ProviderDeps): Promise<CodexRead> {
  const { fs, home } = deps
  const paths = codexPaths(home)
  const problems: string[] = []
  const versions: Record<string, string> = {}
  const items: Item[] = []
  const refs = new Map<string, Ref>()
  const add = (item: Omit<Item, 'agent' | 'movable' | 'removable'> & Partial<Pick<Item, 'movable' | 'removable'>>, ref?: Ref) => {
    items.push({ agent: CODEX, movable: false, removable: false, ...item })
    if (ref) refs.set(item.key, ref)
  }

  const config = (await readToml(fs, paths.config, home, problems, versions)) ?? {}
  const projectsTable = table(config.projects)
  const trusted = new Set(Object.keys(projectsTable).filter((path) => table(projectsTable[path]).trust_level === 'trusted'))
  // The home folder is not a project: its .agents/skills and .codex are the user-scope folders.
  const projects: string[] = []
  for (const path of await existingProjects(fs, Object.keys(projectsTable))) {
    if (!(await sameFolder(fs, path, home)) && !(await sameFolder(fs, path, paths.codexHome))) projects.push(path)
  }

  await readPlugins(deps, paths, config, add)

  // Agents named by an [agents.<role>] config_file must stay where the role points.
  const pinned = new Map<string, string>()
  const places: { project: string | null; scope: Scope; config: Json; configFile: string }[] = [
    { project: null, scope: 'user', config, configFile: paths.config }
  ]
  for (const project of projects) {
    const file = `${project}/.codex/config.toml`
    places.push({ project, scope: 'project', config: (await readToml(fs, file, home, problems, versions)) ?? {}, configFile: file })
  }
  for (const place of places) {
    for (const [role, value] of Object.entries(table(place.config.agents))) {
      if (!isObject(value) || typeof value.config_file !== 'string') continue
      const dir = place.configFile.slice(0, place.configFile.lastIndexOf('/'))
      const target = value.config_file.startsWith('/') ? value.config_file : `${dir}/${value.config_file}`
      pinned.set(target.replace(/\/\.\//g, '/'), `[agents.${role}] in ${tilde(home, place.configFile)}`)
    }
  }

  for (const place of places) {
    const { project, scope } = place
    // Skills: folders holding SKILL.md.
    for (const dir of skillDirs(paths, project)) {
      const shared = dir === sharedSkillDir(paths, project)
      for (const skill of await readEntryDir(fs, 'skills', dir, readSkills)) {
        versions[skill.path] = versionOf(await fs.readText(skill.path))
        const key = itemKey('skills', skill.entry)
        const relative = skill.link !== null && !skill.link.startsWith('/')
        const reason = shared ? SHARED_SKILL_REASON : relative ? `It is a relative link (${skill.link}); moving it would break it.` : undefined
        const movable = reason === undefined
        add(
          {
            key,
            kind: 'skills',
            name: skill.name,
            description: skill.description,
            project,
            scope,
            source: skill.path,
            movable,
            ...(reason === undefined ? {} : { notMovableReason: reason }),
            removable: !shared
          },
          { kind: 'skills', entry: skill, file: skill.path, project, movable, removable: !shared, reason }
        )
      }
    }
    // Agents: standalone TOML files, then roles declared in config.toml.
    const dir = agentDir(paths, project)
    for (const entry of await fs.listEntries(dir)) {
      if (!entry.endsWith('.toml')) continue
      const file = `${dir}/${entry}`
      const parsed = await readToml(fs, file, home, problems, versions)
      if (versions[file] === '') continue
      const agent = parsed ?? {}
      const name = typeof agent.name === 'string' && agent.name.trim() !== '' ? agent.name : entry.slice(0, -'.toml'.length)
      const link = await fs.linkTarget(file)
      const by = pinned.get(file)
      const relative = link !== null && !link.startsWith('/')
      const reason = by
        ? `${by} points to this file; moving or removing it would break that role.`
        : relative
          ? `It is a relative link (${link}); moving it would break it.`
          : undefined
      const key = itemKey('agents', file)
      add(
        {
          key,
          kind: 'agents',
          name,
          description: typeof agent.description === 'string' ? agent.description : '',
          project,
          scope,
          source: file,
          movable: reason === undefined,
          ...(reason === undefined ? {} : { notMovableReason: reason }),
          removable: by === undefined
        },
        {
          kind: 'agents',
          entry: { kind: 'agents', name, entry: file, link },
          file,
          project,
          movable: reason === undefined,
          removable: by === undefined,
          reason
        }
      )
    }
    for (const [role, value] of Object.entries(table(place.config.agents))) {
      if (!isObject(value)) continue
      const configFile = typeof value.config_file === 'string' ? ` Settings: ${value.config_file}.` : ''
      add({
        key: itemKey('agents', place.configFile, role),
        kind: 'agents',
        name: role,
        description: `${typeof value.description === 'string' ? value.description : ''}${configFile}`.trim(),
        project,
        scope,
        source: place.configFile,
        notMovableReason: `It is a role in ${tilde(home, place.configFile)}, which this app never rewrites.`
      })
    }
    // MCP servers.
    for (const [name, value] of Object.entries(table(place.config.mcp_servers))) {
      if (!isObject(value)) continue
      const key = itemKey('mcp', place.configFile, name)
      const http = typeof value.url === 'string'
      const args = Array.isArray(value.args) ? value.args.map(String) : []
      const target = http ? redactUrl(String(value.url)) : redactArgs([String(value.command ?? ''), ...args]).join(' ').trim()
      const validName = usableServerName(name)
      let movable = false
      let notMovableReason: string
      if (project === null) {
        notMovableReason = '`codex mcp add` only writes ~/.codex/config.toml, and this app never rewrites a project .codex/config.toml.'
      } else {
        const why = !validName ? '`codex mcp add` refuses its name' : copyableServer(value)
        movable = why === null && !Object.hasOwn(table(config.mcp_servers), name)
        notMovableReason =
          why !== null
            ? `It cannot be copied to ~/.codex/config.toml: ${why}.`
            : movable
              ? 'Only a copy to global works: this app never rewrites a project .codex/config.toml.'
              : `~/.codex/config.toml already has a server named "${name}".`
      }
      add(
        {
          key,
          kind: 'mcp',
          name,
          description: value.enabled === false ? 'Turned off in config.toml (enabled = false).' : '',
          project,
          scope,
          source: place.configFile,
          movable,
          notMovableReason,
          removable: project === null && validName,
          mcp: { transport: http ? 'http' : 'stdio', target }
        },
        { kind: 'mcp', name, file: place.configFile, project, server: value }
      )
    }
    // Hooks: hooks.json, then [hooks] tables in config.toml (Codex loads both and warns).
    const hooksFile = project === null ? paths.hooks : `${project}/.codex/hooks.json`
    const hooksText = await fs.readText(hooksFile)
    versions[hooksFile] = versionOf(hooksText)
    if (hooksText !== null) addHooks(table((await readJson(fs, hooksFile, problems)).hooks), hooksFile, place, config, add)
    addHooks(table(place.config.hooks), place.configFile, place, config, add)
  }

  const backups = (await listAllBackups(fs, codexBackups(paths))).map(({ name, target, at }) => ({ name, target, at }))
  const order = (item: Item) => `${item.project ?? ''}\u0000${item.kind}\u0000${item.name}`
  items.sort((a, b) => order(a).localeCompare(order(b)))
  return { view: { items, projects, versions, backups, problems }, refs, trusted }
}

type Add = (item: Omit<Item, 'agent' | 'movable' | 'removable'> & Partial<Pick<Item, 'movable' | 'removable'>>, ref?: Ref) => void

const snake = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

function addHooks(events: Json, file: string, place: { project: string | null; scope: Scope }, config: Json, add: Add) {
  const state = table(table(config.hooks).state)
  for (const [event, groups] of Object.entries(events)) {
    // [hooks] in config.toml also holds `state` (trust records), which is not an event.
    if (!Array.isArray(groups)) continue
    groups.forEach((group, g) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return
      const matcher = typeof group.matcher === 'string' ? group.matcher : ''
      group.hooks.forEach((handler, h) => {
        if (!isObject(handler)) return
        const command =
          typeof handler.command === 'string'
            ? redactCommand(handler.command)
            : handler.type === 'mcp_tool'
              ? `mcp_tool ${String(handler.server ?? '')} ${String(handler.tool ?? '')}`.trim()
              : String(handler.type ?? '')
        const off = table(state[`${file}:${snake(event)}:${g}:${h}`]).enabled === false
        const status = typeof handler.statusMessage === 'string' ? handler.statusMessage : ''
        add({
          key: itemKey('hooks', file, event, g, h),
          kind: 'hooks',
          name: command,
          description: [`${event}${matcher ? ` · ${matcher}` : ''}`, status, off ? 'turned off in /hooks' : ''].filter(Boolean).join(' · '),
          project: place.project,
          scope: place.scope,
          source: file,
          notMovableReason: 'Codex trusts each hook by a hash of where it is; moving it would make Codex skip it until reviewed again.',
          hook: { event, matcher, command }
        })
      })
    })
  }
}

async function readPlugins(deps: ProviderDeps, paths: CodexPaths, config: Json, add: Add) {
  const { fs } = deps
  for (const [id, value] of Object.entries(table(config.plugins))) {
    // `_default` holds the default for plugins without their own entry; it is not a plugin.
    if (id === '_default' || !isObject(value)) continue
    const at = id.lastIndexOf('@')
    const [name, market] = at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, '']
    const base = `${paths.codexHome}/plugins/cache/${market}/${name}`
    const version = market === '' ? null : activeVersion(await fs.listEntries(base))
    const root = version === null ? null : `${base}/${version}`
    const manifest = root === null ? {} : await readJson(fs, `${root}/.codex-plugin/plugin.json`)
    const contributes = { skills: [] as string[], agents: [] as string[], commands: [] as string[], hooks: [] as string[], mcpServers: [] as string[] }
    if (root !== null) {
      const under = (path: unknown) => (typeof path === 'string' ? `${root}/${path.replace(/^\.\//, '').replace(/\/$/, '')}` : null)
      const skills = under(manifest.skills)
      if (skills !== null) contributes.skills = (await readSkills(fs, skills)).map((skill) => skill.name)
      const mcp = under(manifest.mcpServers)
      if (mcp !== null) contributes.mcpServers = Object.keys(table((await readJson(fs, mcp)).mcpServers)).sort()
      const hooks = isObject(manifest.hooks) ? manifest.hooks : under(manifest.hooks) === null ? {} : await readJson(fs, under(manifest.hooks)!)
      contributes.hooks = Object.keys(table(hooks.hooks)).sort()
    }
    const installed = root !== null
    add({
      key: itemKey('plugins', id),
      kind: 'plugins',
      name: typeof manifest.displayName === 'string' ? manifest.displayName : name,
      description:
        typeof manifest.description === 'string'
          ? manifest.description
          : installed
            ? `From the ${market} marketplace.`
            : `Not in the plugin cache (${tilde(paths.home, base)}).`,
      project: null,
      scope: 'user',
      source: paths.config,
      notMovableReason: 'Codex installs plugins for the user only.',
      plugin: {
        id,
        enabled: value.enabled !== false,
        version: typeof manifest.version === 'string' ? manifest.version : version,
        contributes,
        sharesNameWith: [],
        installed,
        installs: installed ? [{ scope: 'user', project: null }] : []
      }
    })
  }
}

/** The version folder Codex uses: `local` when present, else the highest (active_plugin_version in core-plugin-common). */
function activeVersion(entries: string[]): string | null {
  const versions = entries.filter((entry) => !entry.startsWith('.'))
  if (versions.length === 0) return null
  if (versions.includes('local')) return 'local'
  return versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) ?? null
}
