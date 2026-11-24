// Reads what Copilot CLI loads into the panel's items. Nothing here writes.
// Secrets: env and headers are never read into an item, and the commands and URLs that are shown pass through
// the toolkit's redaction (redactArgs, redactUrl, redactCommand). Parse errors are reported with a fixed message, never the parser's, because that can quote the file.
import type { Item, Kind } from '../../adapters/view.ts'
import {
  existingProjects,
  isObject,
  itemKey,
  listAllBackups,
  parseObject,
  readAgents,
  readEntryDir,
  readSkills,
  redactArgs,
  redactCommand,
  redactUrl,
  sortByName,
  versionOf,
  type EntryRef,
  type FileSystem,
  type Json,
  type ProviderView
} from '../toolkit.ts'
import { COPILOT, placesOf, type CopilotPaths, type Place } from './paths.ts'

/** What a write needs to know about a writable item, by key. */
export type Ref =
  | { kind: 'skills' | 'agents'; project: string | null; entry: EntryRef }
  | { kind: 'mcp'; project: string | null; file: string; name: string; config: Json }

export interface Inventory {
  view: ProviderView
  refs: Map<string, Ref>
}

const SHARED = 'Shared with other agents (it is not in a Copilot folder), so it is read-only here.'
const READ_ONLY: Partial<Record<Kind, string>> = {
  plugins: 'Plugins are managed with `copilot plugin`; this app does not change them yet.',
  hooks: 'Hooks are read-only here for now.'
}

export async function readCopilot(fs: FileSystem, paths: CopilotPaths): Promise<Inventory> {
  const problems: string[] = []
  const versions: Record<string, string> = {}
  const items: Item[] = []
  const refs = new Map<string, Ref>()
  // The home folder can be a trusted project too; then a shared folder is read twice. Keys keep it once.
  // Only items in a writable place get a Ref: without one, every write refuses the item as read-only.
  const add = (item: Item, ref?: Ref) => {
    if (items.some((other) => other.key === item.key)) return
    items.push(item)
    if (ref && item.movable) refs.set(item.key, ref)
  }
  const base = (kind: Kind, key: string, name: string, project: string | null, source: string, place: Place): Item => ({
    key,
    agent: COPILOT,
    kind,
    name,
    description: '',
    project,
    scope: project === null ? 'user' : 'project',
    source,
    movable: place.writable,
    removable: place.writable,
    ...(place.writable ? {} : { notMovableReason: READ_ONLY[kind] ?? SHARED })
  })

  const projects = await trustedProjects(fs, paths, problems)
  // A folder or file reached twice (the home folder trusted as a project, under its own name or through a link)
  // is read once, at its first place: global comes first.
  const seen = new Set<string>()
  const firstVisit = async (path: string) => {
    const real = await fs.realPath(path)
    if (real === null) return true
    if (seen.has(real)) return false
    seen.add(real)
    return true
  }
  for (const project of [null, ...projects]) {
    for (const kind of ['skills', 'agents'] as const) {
      for (const place of placesOf(paths, kind, project)) {
        if (!(await firstVisit(place.path))) continue
        for (const entry of await readEntryDir(fs, kind, place.path, kind === 'skills' ? readSkills : readAgentFiles)) {
          const key = itemKey(kind, entry.entry)
          add({ ...base(kind, key, entry.name, project, entry.path, place), description: entry.description }, { kind, project, entry })
        }
      }
    }
    for (const place of placesOf(paths, 'mcp', project)) {
      if (!(await firstVisit(place.path))) continue
      const text = await fs.readText(place.path)
      versions[place.path] = versionOf(text)
      for (const [name, config] of serversIn(text, place.path, problems)) {
        const key = itemKey('mcp', place.path, name)
        add({ ...base('mcp', key, name, project, place.path, place), mcp: describeServer(config) }, { kind: 'mcp', project, file: place.path, name, config })
      }
    }
    for (const place of placesOf(paths, 'hooks', project)) {
      if (!(await firstVisit(place.path))) continue
      for (const file of await fs.listEntries(place.path)) {
        if (!file.endsWith('.json')) continue
        const path = `${place.path}/${file}`
        for (const { index, ...hook } of hooksIn(await fs.readText(path), path, problems)) {
          add({ ...base('hooks', itemKey('hooks', path, hook.event, index), hook.event, project, path, place), hook })
        }
      }
    }
  }
  for (const plugin of await readPlugins(fs, paths, problems)) {
    add({ ...base('plugins', itemKey('plugins', plugin.dir), plugin.name, null, plugin.dir, placesOf(paths, 'plugins', null)[0]), description: plugin.description })
  }

  const backups = (await listAllBackups(fs, paths.store)).map(({ name, target, at }) => ({ name, target, at }))
  return { view: { items, projects, versions, backups, problems }, refs }
}

/**
 * The folders trusted in Copilot CLI (`trustedFolders` in ~/.copilot/config.json) that still exist: the projects
 * it loads workspace files from. config.json starts with `//` comment lines, so whole-line comments are dropped first.
 */
async function trustedProjects(fs: FileSystem, paths: CopilotPaths, problems: string[]): Promise<string[]> {
  const text = await fs.readText(paths.configFile)
  if (text === null) return []
  const json = parseObject(text.replace(/^\s*\/\/.*$/gm, ''))
  if (json === null) {
    problems.push(`${paths.configFile}: not readable as JSON, so no projects are shown.`)
    return []
  }
  const folders = Array.isArray(json.trustedFolders) ? json.trustedFolders.filter((folder) => typeof folder === 'string') : []
  return existingProjects(fs, folders)
}

/** Agent profiles: `<name>.agent.md` and plain `<name>.md`; Copilot CLI reads both. */
async function readAgentFiles(fs: FileSystem, dir: string) {
  const profiles = await readAgents(fs, dir, '.agent.md')
  const plain = (await readAgents(fs, dir, '.md')).filter((agent) => !agent.path.endsWith('.agent.md'))
  return sortByName([...profiles, ...plain])
}

/** The servers of an MCP file (`mcpServers`); a broken file is a problem and shows none. */
function serversIn(text: string | null, file: string, problems: string[]): [string, Json][] {
  if (text === null) return []
  const json = parseObject(text)
  if (json === null) {
    problems.push(`${file}: not a valid JSON object, so its MCP servers are not shown.`)
    return []
  }
  if (json.mcpServers === undefined) return []
  if (!isObject(json.mcpServers)) {
    problems.push(`${file}: "mcpServers" is not an object.`)
    return []
  }
  return Object.entries(json.mcpServers).filter((entry): entry is [string, Json] => isObject(entry[1]))
}

/** Transport and target, without env or headers. Copilot calls stdio `local`; both are shown as stdio. */
function describeServer(config: Json): { transport: string; target: string } {
  const url = typeof config.url === 'string' ? config.url : null
  const type = typeof config.type === 'string' ? config.type : url ? 'http' : 'stdio'
  const args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === 'string') : []
  const target = url !== null ? redactUrl(url) : redactArgs([config.command, ...args].filter((part) => typeof part === 'string' && part !== '')).join(' ')
  return { transport: type === 'local' ? 'stdio' : type, target }
}

/** Hook entries of a hooks file: `{ "version": 1, "hooks": { <event>: [ {...} ] } }`. env is never read. */
function hooksIn(text: string | null, file: string, problems: string[]) {
  if (text === null) return []
  const json = parseObject(text)
  if (json === null || !isObject(json.hooks)) {
    problems.push(`${file}: not a hooks file (a JSON object with a "hooks" object), so its hooks are not shown.`)
    return []
  }
  return Object.entries(json.hooks).flatMap(([event, entries]) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry, index) =>
      isObject(entry) ? [{ event, index, matcher: typeof entry.matcher === 'string' ? entry.matcher : '', command: redactCommand(commandOf(entry)) }] : []
    )
  )
}

/** What a hook runs: its shell command, the direct `exec` with its args, or the URL of an http hook. */
function commandOf(entry: Json): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  if (text(entry.exec)) return [entry.exec, ...(Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === 'string') : [])].join(' ')
  return text(entry.bash) || text(entry.command) || text(entry.powershell) || text(entry.url) || `(${text(entry.type) || 'command'} hook)`
}

/** Where an installed plugin keeps its manifest, in the order Copilot CLI checks. */
const MANIFESTS = ['plugin.json', '.plugin/plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']

/** Installed plugins: `installed-plugins/<marketplace>/<plugin>/` and `installed-plugins/_direct/<source>/`. */
async function readPlugins(fs: FileSystem, paths: CopilotPaths, problems: string[]) {
  const root = placesOf(paths, 'plugins', null)[0].path
  const plugins: { dir: string; name: string; description: string }[] = []
  for (const source of await fs.listEntries(root)) {
    for (const folder of await fs.listEntries(`${root}/${source}`)) {
      const dir = `${root}/${source}/${folder}`
      if ((await fs.listEntries(dir)).length === 0) continue
      const manifest = await readManifest(fs, dir, problems)
      const name = typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : folder
      plugins.push({ dir, name: source === '_direct' ? name : `${name}@${source}`, description: typeof manifest.description === 'string' ? manifest.description : '' })
    }
  }
  return sortByName(plugins)
}

async function readManifest(fs: FileSystem, dir: string, problems: string[]): Promise<Json> {
  for (const place of MANIFESTS) {
    const text = await fs.readText(`${dir}/${place}`)
    if (text === null) continue
    const json = parseObject(text)
    if (json === null) problems.push(`${dir}/${place}: not a valid JSON object.`)
    return json ?? {}
  }
  return {}
}
