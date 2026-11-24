// Pure helpers over the View contract (src/adapters/view.ts). No DOM here.

export const KINDS = /** @type {const} */ (['plugins', 'skills', 'agents', 'mcp', 'hooks'])

export const KIND_LABEL = { plugins: 'Plugins', skills: 'Skills', agents: 'Agents', mcp: 'MCP', hooks: 'Hooks' }

/** Singular and plural nouns used in copy ("1 skill", "3 MCP servers"). */
const NOUN = {
  plugins: ['plugin', 'plugins'],
  skills: ['skill', 'skills'],
  agents: ['agent', 'agents'],
  mcp: ['MCP server', 'MCP servers'],
  hooks: ['hook', 'hooks'],
}

export function noun(kind, n) {
  return NOUN[kind][n === 1 ? 0 : 1]
}

/** Classes that have an "only me" file in a project; the others are always shared with the team. */
export function hasLocalScope(kind) {
  return kind === 'plugins' || kind === 'mcp' || kind === 'hooks'
}

export function projectName(path) {
  if (!path) return 'Global'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Shortens a home-directory path to ~ for display; the full path stays in the title. */
export function tildify(path) {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

/** "name@marketplace" -> "marketplace"; the text after the last '@'. */
export function marketplaceOf(pluginId) {
  const at = pluginId.lastIndexOf('@')
  return at === -1 ? '' : pluginId.slice(at + 1)
}

export function scopeLabel(scope) {
  return scope === 'local' ? 'Only me' : scope === 'project' ? 'Team' : 'Global'
}

export function hookTitle(item) {
  if (!item.hook) return item.name
  return item.hook.matcher ? `${item.hook.event} · ${item.hook.matcher}` : item.hook.event
}

function matches(item, query) {
  if (!query) return true
  const hay = [item.name, item.plugin?.id, item.hook && hookTitle(item)].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(query)
}

function byName(a, b) {
  const ka = a.kind === 'hooks' ? hookTitle(a) : a.name
  const kb = b.kind === 'hooks' ? hookTitle(b) : b.name
  return ka.localeCompare(kb, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key)
}

export function countByKind(view) {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const item of view.items) if (item.kind in counts) counts[item.kind]++
  return counts
}

/** Every project the panel can drop into: the known projects, plus any that only appear on items. */
export function allProjects(view) {
  const known = [...view.projects]
  const extra = [...new Set(view.items.map((i) => i.project).filter((p) => p && !known.includes(p)))].sort()
  return [...known, ...extra]
}

/**
 * The accordions of one tab: Global always, then one per project that has items of this class.
 * With a filter, project accordions without a match are left out.
 */
export function groupsFor(view, kind, filter) {
  const query = filter.trim().toLowerCase()
  const ofKind = view.items.filter((i) => i.kind === kind)
  const groups = []
  const global = ofKind.filter((i) => i.project === null).sort(byName)
  groups.push({ id: 'global', project: null, items: global.filter((i) => matches(i, query)), total: global.length })
  for (const project of allProjects(view)) {
    const own = ofKind.filter((i) => i.project === project).sort(byName)
    if (own.length === 0) continue
    const shown = own.filter((i) => matches(i, query))
    if (query && shown.length === 0) continue
    groups.push({ id: project, project, items: shown, total: own.length })
  }
  const matched = groups.reduce((n, g) => n + g.items.length, 0)
  return { groups, matched, total: ofKind.length, query }
}

export function relativeTime(at, now = Date.now()) {
  const s = Math.round((now - at) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const hours = Math.round(m / 60)
  if (hours < 24) return `${hours} h ago`
  const d = Math.round(hours / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function sameProject(a, b) {
  return (a ?? null) === (b ?? null)
}

// ---------- Updates ----------

/** Content hashes and commits shorten to 7 characters; versions stay as they are. */
export function shortVersion(value) {
  return value && /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 7) : value
}

/** The word before an update source's label: "marketplace · claude-plugins-official". */
export const SOURCE_TYPE = { plugin: 'marketplace', 'skills-cli': 'skills', npm: 'npm' }

/** Keys of the items of one kind that the last check marked available and that the app can update. */
export function updatableKeys(view, kind, statuses) {
  if (!view) return []
  return view.items
    .filter((i) => i.kind === kind && i.updateSource && i.updateSource.type !== 'manual' && statuses[i.key]?.status === 'available')
    .map((i) => i.key)
}

/**
 * The statuses to keep after an update action: an item that is gone, that was the one updated
 * successfully, or whose installed version changed is current now, so its old status is dropped.
 */
export function settleStatuses(statuses, before, after, updatedKey) {
  const old = new Map((before?.items ?? []).map((i) => [i.key, i]))
  const next = {}
  for (const [key, status] of Object.entries(statuses)) {
    const now = after.items.find((i) => i.key === key)
    if (!now || key === updatedKey) continue
    if ((old.get(key)?.updateSource?.current ?? null) !== (now.updateSource?.current ?? null)) continue
    next[key] = status
  }
  return next
}
