// Reads Gemini CLI's setup into items: extensions (as plugins), skills, agents, MCP servers and hooks, globally and
// per project. Read-only; never opens .env, credential, history or log files. Sources are listed in ./index.ts.
import type { Item, Kind } from '../../adapters/view.ts'
import {
  admitMcp,
  describeMcp,
  existingProjects,
  isObject,
  itemKey,
  listAllBackups,
  readAgents,
  readSkills,
  redactCommand,
  redactUrl,
  sameFolder,
  versionOf,
  type FileSystem,
  type Json,
  type McpConfig,
  type ProviderView
} from '../toolkit.ts'
import { GEMINI_ADD, GEMINI_ADD_TEAM } from './mcp-add.ts'
import { agentDir, settingsOf, skillDirs, type GeminiPaths } from './paths.ts'

export const GEMINI = 'gemini'

// ---------------------------------------------------------------------------------------------- JSON with comments

/**
 * Gemini CLI reads settings.json through strip-json-comments: `//` and `/* *\/` outside strings are allowed.
 * Comments become spaces, so a parse error's position is still a position in the file.
 */
export function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const start = i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      out += text.slice(start, ++i)
    } else if (c === '/' && text[i + 1] === '/') {
      const start = i
      while (i < text.length && text[i] !== '\n') i++
      out += ' '.repeat(i - start)
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

/** A JSON (or, with `comments`, JSONC) object file: {} when missing; {} plus a problem when it is not an object. */
async function readObject(fs: FileSystem, file: string, versions: Record<string, string>, problems: string[], comments: boolean) {
  const text = await fs.readText(file)
  versions[file] = versionOf(text)
  if (text === null) return { text, json: {} as Json }
  try {
    const value = JSON.parse(comments ? stripComments(text) : text)
    if (isObject(value)) return { text, json: value }
    problems.push(`${file}: expected a JSON object`)
  } catch (error) {
    // Never quote the parser's message: it can echo the file's text, secrets included (as readJson in the core).
    const at = /position (\d+)/.exec((error as Error).message)?.[1]
    problems.push(`${file}: not valid JSON${at === undefined ? '' : ` (near character ${at})`}`)
  }
  return { text, json: {} as Json, broken: true }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const lower = (values: string[]) => new Set(values.map((value) => value.toLowerCase().trim()))

// -------------------------------------------------------------------------------------- extension enablement rules

/** One rule of extension-enablement.json, parsed like Gemini CLI's Override.fromFileRule. */
interface Rule {
  base: string
  disable: boolean
  subdirs: boolean
}

export const withSlashes = (path: string) => {
  let result = path.replace(/\\/g, '/')
  if (!result.startsWith('/')) result = `/${result}`
  return result.endsWith('/') ? result : `${result}/`
}

function ruleOf(text: string): Rule {
  const disable = text.startsWith('!')
  let base = disable ? text.slice(1) : text
  const subdirs = base.endsWith('*')
  if (subdirs) base = base.slice(0, -1)
  return { base, disable, subdirs }
}

function ruleMatches(rule: Rule, path: string): boolean {
  const glob = `${rule.base}${rule.subdirs ? '*' : ''}`
  const source = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/(\/?)\*/g, '($1.*)?')
  return new RegExp(`^${source}$`).test(path)
}

/** ExtensionEnablementManager.isEnabled: enabled unless the last rule matching the folder disables it. */
export function extensionEnabled(enablement: Json, name: string, folder: string): boolean {
  const overrides = isObject(enablement[name]) ? strings(enablement[name].overrides) : []
  let enabled = true
  for (const text of overrides) {
    const rule = ruleOf(text)
    if (ruleMatches(rule, withSlashes(folder))) enabled = !rule.disable
  }
  return enabled
}

/** The rules written for exactly this folder (by `gemini extensions enable|disable --scope ...` run there). */
export const rulesFor = (enablement: Json, name: string, folder: string) =>
  (isObject(enablement[name]) ? strings(enablement[name].overrides) : []).filter((text) => ruleOf(text).base === withSlashes(folder))

// --------------------------------------------------------------------------------------------------- extensions

export interface Extension {
  /** The folder in ~/.gemini/extensions. */
  dir: string
  name: string
  version: string | null
  description: string
  install: { type: string | null; source: string | null }
  contributes: NonNullable<Item['plugin']>['contributes']
}

async function hasEntries(fs: FileSystem, dir: string) {
  return (await fs.listEntries(dir)).length > 0
}

/** `commands/**\/*.toml` as Gemini names them: subfolders become namespaces (`gcs/sync.toml` is `gcs:sync`). */
async function commandNames(fs: FileSystem, dir: string, prefix = '', depth = 0): Promise<string[]> {
  const names: string[] = []
  for (const entry of await fs.listEntries(dir)) {
    if (entry.endsWith('.toml')) names.push(`${prefix}${entry.slice(0, -'.toml'.length)}`)
    else if (depth < 4 && (await hasEntries(fs, `${dir}/${entry}`))) names.push(...(await commandNames(fs, `${dir}/${entry}`, `${prefix}${entry}:`, depth + 1)))
  }
  return names.sort()
}

async function readExtensions(fs: FileSystem, paths: GeminiPaths, versions: Record<string, string>, problems: string[]): Promise<Extension[]> {
  const extensions: Extension[] = []
  for (const entry of await fs.listEntries(paths.extensionsDir)) {
    const dir = `${paths.extensionsDir}/${entry}`
    // Files (extension-enablement.json) and empty folders are not extensions; their content is never read.
    if (!(await hasEntries(fs, dir))) continue
    const installFile = `${dir}/.gemini-extension-install.json`
    const install = (await readObject(fs, installFile, versions, problems, false)).json
    const type = typeof install.type === 'string' ? install.type : null
    const source = typeof install.source === 'string' ? install.source : null
    // A linked extension lives at its source (ExtensionManager._buildExtension).
    const root = type === 'link' && source !== null ? source : dir
    const manifestFile = `${root}/gemini-extension.json`
    const read = await readObject(fs, manifestFile, versions, problems, false)
    if (read.text === null) {
      problems.push(`${manifestFile}: missing, so Gemini CLI does not load ${dir}`)
      continue
    }
    const manifest = read.json
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      if (!read.broken) problems.push(`${manifestFile}: no "name"`)
      continue
    }
    const hooksFile = `${root}/hooks/hooks.json`
    const hooks = (await readObject(fs, hooksFile, versions, problems, false)).json
    extensions.push({
      dir,
      name: manifest.name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      install: { type, source },
      contributes: {
        skills: (await readSkills(fs, `${root}/skills`)).map((skill) => skill.name),
        agents: (await readAgents(fs, `${root}/agents`)).filter((agent) => !baseName(agent.path).startsWith('_')).map((agent) => agent.name),
        commands: await commandNames(fs, `${root}/commands`),
        hooks: isObject(hooks.hooks) ? Object.keys(hooks.hooks) : [],
        mcpServers: isObject(manifest.mcpServers) ? Object.keys(manifest.mcpServers).sort() : []
      }
    })
  }
  return extensions.sort((a, b) => a.name.localeCompare(b.name))
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// ------------------------------------------------------------------------------------------------------ MCP

export interface McpServer {
  name: string
  project: string | null
  file: string
  config: Json
}

/**
 * The transport a Gemini CLI server declares (mcp-client.ts createUrlTransport): `httpUrl` is streamable HTTP, a
 * `url` takes its `type` (none is streamable HTTP), `tcp` is a websocket, and a command is stdio unless it says
 * otherwise. A declared type is kept as written, so one the destination cannot carry is refused, never rewritten.
 */
export function transportOf(config: Json): string {
  const declared = config.type === undefined || config.type === null ? null : String(config.type)
  if (typeof config.httpUrl === 'string') return declared ?? 'http'
  if (typeof config.url === 'string') return declared ?? 'http'
  if (typeof config.tcp === 'string') return 'websocket'
  return declared ?? 'stdio'
}

/** Keys that cannot go together: `httpUrl` with `url` (which one Gemini CLI runs), or `httpUrl` with a type other than http. */
function malformedKeys(config: Json): string[] {
  const set = (key: string) => config[key] !== undefined && config[key] !== null
  if (!set('httpUrl')) return []
  if (set('url')) return ['httpUrl', 'url']
  return set('type') && config.type !== 'http' ? ['httpUrl', 'type'] : []
}

/**
 * A Gemini CLI server as McpConfig: the transport transportOf() reads, and its address (`httpUrl`, `url` or
 * `tcp`) as the url. `type` only names the transport; every other key (timeout, trust, cwd...) is `rest`.
 */
export function geminiMcpConfig(name: string, config: Json): McpConfig {
  const { command, args, env, url, httpUrl, tcp, type, headers, ...rest } = config
  const malformed = malformedKeys(config)
  return { name, transport: transportOf(config), command, args, url: httpUrl ?? url ?? tcp, env, headers, rest, ...(malformed.length > 0 ? { malformed } : {}) }
}

// --------------------------------------------------------------------------------------------------- the setup

/** What an item key stands for, so an action can find what it changes. */
export type Ref =
  | { kind: 'plugins'; extension: Extension; project: string | null; enabled: boolean }
  /** `blocked`: a settings list (mcp.excluded, mcp.allowed) keeps it off whatever `gemini mcp enable` says. */
  | { kind: 'mcp'; server: McpServer; blocked: string | null; enabled: boolean }
  | { kind: 'skills' | 'agents' | 'hooks' }

export interface Setup {
  view: ProviderView
  refs: Map<string, Ref>
  /** Known projects: those in ~/.gemini/projects.json that exist, without the home folder. */
  projects: string[]
  /** Every settings place: global first, then each project, with its parsed file. */
  places: { project: string | null; file: string; json: Json; broken: boolean }[]
  enablement: Json
}

const READ_ONLY = { movable: false, notMovableReason: 'Read-only for Gemini CLI in this app.', removable: false } as const

const off = (description: string, reason: string | null) => (reason === null ? description : [description, `Off (${reason})`].filter(Boolean).join(' · '))

export async function readSetup(fs: FileSystem, paths: GeminiPaths): Promise<Setup> {
  const versions: Record<string, string> = {}
  const problems: string[] = []
  const items: Item[] = []
  const refs = new Map<string, Ref>()
  const add = (item: Omit<Item, 'agent'>, ref: Ref) => {
    if (refs.has(item.key)) return
    items.push({ agent: GEMINI, ...item })
    refs.set(item.key, ref)
  }

  const registry = (await readObject(fs, paths.projects, versions, problems, false)).json
  const candidates = isObject(registry.projects) ? Object.keys(registry.projects) : []
  const projects: string[] = []
  // The home folder is not a project, whatever path (a link, an alias) names it.
  for (const project of await existingProjects(fs, candidates)) if (!(await sameFolder(fs, project, paths.home))) projects.push(project)

  const places: Setup['places'] = []
  for (const project of [null, ...projects]) {
    const file = settingsOf(paths, project)
    const read = await readObject(fs, file, versions, problems, true)
    places.push({ project, file, json: read.json, broken: read.broken === true })
  }
  const user = places[0].json
  const enablement = (await readObject(fs, paths.enablement, versions, problems, false)).json
  const mcpEnablement = (await readObject(fs, paths.mcpEnablement, versions, problems, false)).json

  // Extensions: one global item each, and one per known project that has its own rule.
  for (const extension of await readExtensions(fs, paths, versions, problems)) {
    const { install } = extension
    const base = {
      kind: 'plugins' as Kind,
      name: extension.name,
      description: extension.description,
      movable: false,
      notMovableReason: 'Extensions are installed for the user; turn them on or off per project instead.',
      removable: false
    }
    const plugin = {
      id: extension.name,
      version: extension.version,
      contributes: extension.contributes,
      sharesNameWith: [],
      installs: [{ scope: 'user', project: null }]
    }
    const updatable = install.source !== null && (install.type === 'git' || install.type === 'github-release')
    const enabled = extensionEnabled(enablement, extension.name, paths.home)
    add(
      {
        ...base,
        key: itemKey('plugins', null, extension.name),
        project: null,
        scope: 'user',
        source: extension.dir,
        plugin: { ...plugin, enabled, installed: true },
        ...(updatable ? { updateSource: { type: 'plugin' as const, label: redactUrl(install.source!), current: extension.version } } : {})
      },
      { kind: 'plugins', extension, project: null, enabled }
    )
    for (const project of projects) {
      if (rulesFor(enablement, extension.name, project).length === 0) continue
      const here = extensionEnabled(enablement, extension.name, project)
      add(
        { ...base, key: itemKey('plugins', project, extension.name), project, scope: 'project', source: paths.enablement, plugin: { ...plugin, enabled: here, installed: false } },
        { kind: 'plugins', extension, project, enabled: here }
      )
    }
  }

  for (const place of places) {
    const { project, json } = place
    const scope = project === null ? 'user' : 'project'
    // Lists Gemini CLI merges with UNION (settingsSchema.ts): a project adds to the user's.
    const union = (get: (settings: Json) => unknown) => lower([...strings(get(user)), ...(project === null ? [] : strings(get(json)))])

    const disabledSkills = union((settings) => settings.skills?.disabled)
    for (const dir of skillDirs(paths, project)) {
      for (const skill of await readSkills(fs, dir)) {
        const folder = skill.path.slice(0, -'/SKILL.md'.length)
        const reason = disabledSkills.has(skill.name.toLowerCase().trim()) ? 'skills.disabled' : null
        add(
          { ...READ_ONLY, key: itemKey('skills', folder), kind: 'skills', name: skill.name, description: off(skill.description, reason), project, scope, source: folder },
          { kind: 'skills' }
        )
      }
    }

    const overridesOf = (settings: Json, name: string) => (isObject(settings.agents?.overrides) && isObject(settings.agents.overrides[name]) ? settings.agents.overrides[name] : {})
    for (const agent of await readAgents(fs, agentDir(paths, project))) {
      if (baseName(agent.path).startsWith('_')) continue
      const override = { ...overridesOf(user, agent.name), ...(project === null ? {} : overridesOf(json, agent.name)) }
      const reason = override.enabled === false ? 'agents.overrides' : null
      add(
        { ...READ_ONLY, key: itemKey('agents', agent.path), kind: 'agents', name: agent.name, description: off(agent.description, reason), project, scope, source: agent.path },
        { kind: 'agents' }
      )
    }

    // mcp.allowed and mcp.excluded have no merge strategy: the project's list replaces the user's.
    const list = (key: 'allowed' | 'excluded') => {
      const own = json.mcp?.[key]
      return lower(Array.isArray(own) ? strings(own) : strings(user.mcp?.[key]))
    }
    const excluded = list('excluded')
    const allowed = list('allowed')
    const servers = isObject(json.mcpServers) ? Object.entries(json.mcpServers).filter((entry): entry is [string, Json] => isObject(entry[1])) : []
    for (const [name, config] of servers.sort(([a], [b]) => a.localeCompare(b))) {
      const id = name.toLowerCase().trim()
      const blocked = excluded.has(id) ? 'mcp.excluded' : allowed.size > 0 && !allowed.has(id) ? 'not in mcp.allowed' : null
      const enabled = !(isObject(mcpEnablement[id]) && mcpEnablement[id].enabled === false)
      const reason = blocked ?? (enabled ? null : 'gemini mcp disable')
      const mcp = describeMcp(geminiMcpConfig(name, config))
      const target = mcp.target
      // A global server can only go to a project (a team file); a project's can also go global.
      const admitted = admitMcp(geminiMcpConfig(name, config), project === null ? GEMINI_ADD_TEAM : GEMINI_ADD)
      const refusal = admitted.ok ? null : admitted.message
      const server: McpServer = { name, project, file: place.file, config }
      add(
        {
          key: itemKey('mcp', project, name),
          kind: 'mcp',
          name,
          description: off(target, reason),
          project,
          scope,
          source: place.file,
          movable: refusal === null,
          ...(refusal === null ? {} : { notMovableReason: refusal }),
          removable: true,
          mcp
        },
        { kind: 'mcp', server, blocked, enabled }
      )
    }

    const disabledHooks = new Set([...strings(user.hooksConfig?.disabled), ...(project === null ? [] : strings(json.hooksConfig?.disabled))])
    const events = isObject(json.hooks) ? Object.entries(json.hooks) : []
    for (const [event, definitions] of events) {
      if (!Array.isArray(definitions)) continue
      definitions.forEach((definition, d) => {
        if (!isObject(definition) || !Array.isArray(definition.hooks)) return
        const matcher = typeof definition.matcher === 'string' && definition.matcher !== '' ? definition.matcher : '*'
        definition.hooks.forEach((hook: unknown, h: number) => {
          if (!isObject(hook)) return
          const command = typeof hook.command === 'string' ? hook.command : ''
          const name = typeof hook.name === 'string' && hook.name !== '' ? hook.name : null
          // HookRegistry.getHookName: the name, else the command.
          const reason = disabledHooks.has(name ?? command) ? 'hooksConfig.disabled' : null
          const shown = redactCommand(command)
          add(
            {
              ...READ_ONLY,
              key: itemKey('hooks', place.file, event, d, h),
              kind: 'hooks',
              name: name ?? (shown || String(hook.type ?? 'hook')),
              description: off(`${event} · ${matcher}`, reason),
              project,
              scope,
              source: place.file,
              hook: { event, matcher, command: shown }
            },
            { kind: 'hooks' }
          )
        })
      })
    }
  }

  const backups = (await listAllBackups(fs, paths.backups)).map(({ name, target, at }) => ({ name, target, at }))
  const order: Kind[] = ['plugins', 'skills', 'agents', 'mcp', 'hooks']
  items.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      (a.project === null ? 0 : 1) - (b.project === null ? 0 : 1) ||
      (a.project ?? '').localeCompare(b.project ?? '')
  )
  return { view: { items, projects, versions, backups, problems }, refs, projects, places, enablement }
}
