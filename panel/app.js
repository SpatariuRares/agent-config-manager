// Claude Config panel: state, rendering and interaction. Talks to the backend only through transport.js.

import { h, replaceChildren } from './dom.js'
import { icon } from './icons.js'
import { closePopover, openMenu, openPicker } from './popover.js'
import { createTransport } from './transport.js'
import {
  KINDS,
  KIND_LABEL,
  SOURCE_TYPE,
  allProjects,
  countByKind,
  groupsFor,
  hasLocalScope,
  hookTitle,
  marketplaceOf,
  noun,
  projectName,
  relativeTime,
  sameProject,
  scopeLabel,
  settleStatuses,
  shortVersion,
  tildify,
  updatableKeys,
} from './model.js'

const transport = createTransport()
const root = document.documentElement

// ---------- Theme ----------

function applyScheme(scheme) {
  if (scheme !== 'light' && scheme !== 'dark') return
  root.classList.toggle('light', scheme === 'light')
  root.classList.toggle('dark', scheme === 'dark')
}
{
  const forced = new URLSearchParams(location.search).get('theme')
  if (forced) applyScheme(forced)
  else if (!root.classList.contains('light') && !root.classList.contains('dark')) {
    applyScheme(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  }
}
// Orca updates the variables and the html class in place; mirror the payload in case it arrives first.
transport.onTheme?.((theme) => applyScheme(theme?.colorScheme))

// ---------- Persisted UI preferences (per viewer; never required) ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`ccm.${key}`)
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ccm.${key}`, JSON.stringify(value))
    } catch {
      /* storage unavailable: preferences just do not persist */
    }
  },
}

// ---------- State ----------

const freshUpdates = () => ({ checking: false, checkedAt: null, statuses: {}, errors: [] })
const storedTab = KINDS.includes(store.get('tab', 'plugins')) ? store.get('tab', 'plugins') : 'plugins'

const state = {
  view: null,
  loading: true,
  loadError: null,
  /** Every agent the backend knows (View.agents), kept while another agent's view loads. */
  agents: null,
  /** The agent shown: the one picked, else the one the backend chose. Null before the first view. */
  agent: transport.agent,
  tab: storedTab,
  /** The tab the user picked last; shown again whenever the agent has that class. */
  preferredTab: storedTab,
  filter: '',
  /** { [tab]: { [groupId]: false } } — accordions default open; only closed ones are stored. */
  closed: store.get('closed', {}),
  expanded: new Set(),
  confirm: null,
  /** { key: string | null } while an action runs. */
  busy: null,
  notice: null,
  backupsOpen: store.get('backupsOpen', false),
  drag: null,
  /** The last on-demand update check; statuses are keyed by Item.key. Never polled. */
  updates: freshUpdates(),
  /** A plugin update waiting for the user to approve its command: { key, message, command, action }. */
  updateConfirm: null,
}

const $ = (id) => document.getElementById(id)
const els = {
  agent: $('agent'),
  foot: $('foot'),
  tabs: $('tabs'),
  panel: $('tabpanel'),
  filter: $('filter'),
  filterClear: $('filter-clear'),
  notice: $('notice'),
  problems: $('problems'),
  backups: $('backups'),
  strip: $('dropstrip'),
  refresh: $('refresh'),
  snapshot: $('snapshot'),
  updates: $('updates'),
}

const isOpenGroup = (tab, id) => state.closed[tab]?.[id] !== true
function setGroupOpen(tab, id, open) {
  const forTab = { ...(state.closed[tab] ?? {}) }
  if (open) delete forTab[id]
  else forTab[id] = true
  state.closed = { ...state.closed, [tab]: forTab }
  store.set('closed', state.closed)
}

const itemByKey = (key) => state.view?.items.find((i) => i.key === key)

// ---------- Agent capabilities (AgentInfo) ----------

/** The AgentInfo of the agent shown, or null before the backend has listed its agents. */
const currentAgent = () => state.agents?.find((a) => a.id === state.agent) ?? null
const agentName = () => currentAgent()?.name ?? 'Claude Code'
/** The tabs this agent has; every class until the agents are known. */
const agentKinds = () => {
  const kinds = currentAgent()?.kinds?.filter((k) => KINDS.includes(k))
  return kinds?.length ? kinds : KINDS
}
/** True when the agent supports this action on this class. Anything else is read-only: never offered. */
const supports = (kind, type) => !!currentAgent()?.supports?.[kind]?.includes(type)
/** For actions over every file (Create backup, Restore): supported for any class. */
const supportsAny = (type) => Object.values(currentAgent()?.supports ?? {}).some((list) => list?.includes(type))
/** Before the agents are known nothing is hidden, so the header does not jump on the first load. */
const offers = (type) => !currentAgent() || supportsAny(type)
/**
 * The scopes a move or copy into a project may target for this class, default first (AgentInfo.projectScopes).
 * Empty: items of this class never go into a project. A backend that predates projectScopes gets Claude's model.
 */
const projectScopes = (kind) => {
  const declared = currentAgent()?.projectScopes
  if (!declared) return hasLocalScope(kind) ? ['local', 'project'] : ['project']
  return (declared[kind] ?? []).filter((scope) => scope === 'local' || scope === 'project')
}
/** The item's on/off value: a plugin's own, else the item's (e.g. a Gemini CLI MCP server); undefined when it has none. */
const enabledOf = (item) => item.plugin?.enabled ?? item.enabled

/** Shows the preferred tab when this agent has it, else the agent's first class. */
function settleTab() {
  const kinds = agentKinds()
  state.tab = kinds.includes(state.preferredTab) ? state.preferredTab : kinds[0]
}

// ---------- Backend calls ----------

/** Each load gets a number; an answer for an older load (the agent changed meanwhile) is dropped. */
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  state.loading = true
  render()
  const answer = await transport.getView()
  if (seq !== loadSeq) return
  state.loading = false
  if (answer.ok) {
    state.view = answer.view
    state.loadError = null
    if (answer.view.agents?.length) state.agents = answer.view.agents
    state.agent = answer.view.agent ?? transport.agent
  } else {
    state.loadError = answer.error
    if (answer.agents?.length) state.agents = answer.agents
    state.agent = transport.agent
  }
  settleTab()
  render()
}

/**
 * Shows another agent: its view is read again, and the filter, the update check and anything
 * pending for the previous agent are cleared. The tab stays when the new agent has that class.
 */
function selectAgent(id) {
  if (!id || id === state.agent || state.busy) return
  transport.setAgent(id)
  state.agent = id
  state.view = null
  state.loadError = null
  state.filter = ''
  els.filter.value = ''
  state.updates = freshUpdates()
  state.confirm = null
  state.updateConfirm = null
  state.notice = null
  state.expanded.clear()
  settleTab()
  return load()
}

/**
 * Runs one action: disables every other action, shows progress on the item, then re-renders from
 * the returned view and reports the result in the notice area.
 */
async function run(action, { key = action.key ?? null, keys = null, label = 'Working…', focusNotice = false, focusAfter = null, describe } = {}) {
  if (state.busy) return
  closePopover({ restoreFocus: false })
  // Controls are disabled while the action runs, which drops focus; put it back afterwards.
  const focusId = document.activeElement?.closest?.('[data-fid]')?.dataset.fid
  const before = state.view
  state.busy = { key, keys, label }
  state.confirm = null
  state.updateConfirm = null
  render()
  const answer = await transport.runAction(action)
  state.busy = null
  const { result, view } = answer
  let reloadError = null
  if (view?.ok) {
    state.view = view.view
    state.loadError = null
    if (action.type === 'update' || action.type === 'updateAll') {
      const updated = action.type === 'update' && result.ok ? action.key : null
      state.updates = { ...state.updates, statuses: settleStatuses(state.updates.statuses, before, state.view, updated) }
    }
  } else reloadError = view?.error ?? 'No view came back.'

  // The update needs a marketplace command approved: show it inline and send nothing until the user says so.
  if (!result.ok && result.confirm) {
    state.updateConfirm = { key: result.confirm.action.key ?? action.key ?? null, message: result.message, command: result.confirm.command, action: result.confirm.action }
    state.notice = reloadError ? { tone: 'error', message: `The list could not be reloaded: ${reloadError}. Use Refresh.` } : null
    render()
    document.querySelector('[data-fid="cancel-update"]')?.focus({ preventScroll: true })
    document.querySelector('.confirm-update')?.scrollIntoView({ block: 'nearest' })
    return
  }

  const notice = result.ok
    ? { tone: 'ok', message: result.message, warning: result.warning, undo: result.undo }
    : { tone: 'error', message: result.message, detail: result.reason }
  if (reloadError && result.ok) notice.warning = [notice.warning, `The list could not be reloaded: ${reloadError}. Use Refresh.`].filter(Boolean).join(' ')
  if (result.ok) Object.assign(notice, describe?.(state.view) ?? {})
  state.notice = notice
  render()
  if (focusNotice) els.notice.querySelector('button')?.focus({ preventScroll: true })
  else if (document.activeElement === document.body || !document.activeElement) {
    // The control may be gone (an Update button disappears once the item is current): fall back.
    const target = [focusId, focusAfter].filter(Boolean).map((id) => document.querySelector(`[data-fid="${CSS.escape(id)}"]`)).find(Boolean)
    target?.focus({ preventScroll: true })
  }
}

/** Asks the backend whether anything has a newer version. On demand only: nothing calls this on a timer. */
async function checkUpdates() {
  if (state.updates.checking) return
  state.updates = { ...state.updates, checking: true }
  render()
  const agent = state.agent
  const answer = await transport.checkUpdates()
  if (agent !== state.agent) return
  state.updates = answer.ok
    ? { checking: false, checkedAt: answer.answer.checkedAt ?? Date.now(), statuses: answer.answer.statuses ?? {}, errors: answer.answer.errors ?? [] }
    : { ...state.updates, checking: false, errors: [`The check did not run: ${answer.error}`] }
  render()
}

const itemLabel = (item) => (item.kind === 'hooks' ? hookTitle(item) : item.name)

function updateItem(item) {
  return run({ type: 'update', key: item.key }, { label: 'Updating…', focusAfter: `menu:${item.key}` })
}

function updateAllOfTab() {
  const keys = updatableKeys(state.view, state.tab, state.updates.statuses)
  if (!keys.length) return
  return run({ type: 'updateAll', kind: state.tab, keys }, { key: null, keys, label: 'Updating…', focusAfter: 'check-updates' })
}

/** After a drop into a project as "only me", offer to make the new item a team item. */
function teamOffer(item, project) {
  return (view) => {
    const placed = view?.items.find((i) => i.kind === item.kind && i.name === item.name && i.project === project && i.scope === 'local')
    return placed ? { team: { type: 'move', key: placed.key, to: { project, scope: 'project' }, copy: false } } : {}
  }
}

function moveItem(item, project, scope, copy, opts = {}) {
  const scopes = projectScopes(item.kind)
  if (project !== null && !scopes.length) return
  const to = project === null ? { project: null } : { project, scope: scope ?? scopes[0] }
  const offer = project !== null && to.scope === 'local' && scopes.includes('project') ? teamOffer(item, project) : undefined
  return run({ type: 'move', key: item.key, to, copy }, { ...opts, describe: offer })
}

// ---------- Rendering ----------

function render() {
  root.classList.toggle('is-busy', !!state.busy)
  renderAgent()
  renderUpdatesBar()
  renderTabs()
  renderProblems()
  renderPanel()
  renderBackups()
  renderNotice()
  renderFoot()
  els.refresh.disabled = !!state.busy || state.loading
  els.snapshot.hidden = !offers('snapshot')
  els.snapshot.disabled = !!state.busy || !state.view
  els.filterClear.hidden = !state.filter
  els.filter.placeholder = `Filter ${noun(state.tab, 2)} by name`
}

/**
 * The agent switcher: the agent shown, where it keeps its setup, and why parts are read-only.
 * Agents that are not installed stay selectable, so the user can see where they would be configured.
 */
function renderAgent() {
  const agent = currentAgent()
  els.agent.hidden = !agent
  if (!agent) return replaceChildren(els.agent)
  replaceChildren(
    els.agent,
    h(
      'div',
      { class: 'agent-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'agent-btn',
          'aria-haspopup': 'menu',
          'aria-label': `Agent: ${agent.name}${agent.detected ? '' : ', not installed'}`,
          'data-act': 'agent-menu',
          'data-fid': 'agent',
          disabled: !!state.busy,
          title: 'Choose the agent whose setup this panel shows',
        },
        h('span', { class: 'agent-name' }, agent.name),
        icon('chevron', 12),
      ),
      agent.detected ? null : h('span', { class: 'tag tag-missing' }, 'Not installed'),
      h('span', { class: 'agent-home', title: agent.configHome }, agent.configHome),
    ),
    agent.note ? agentNote(agent.note) : null,
  )
}

function openAgentMenu(anchor) {
  openMenu(anchor, {
    label: 'Agents',
    className: 'agent-menu',
    entries: state.agents.map((a) => ({
      label: a.name,
      detail: a.configHome,
      tag: a.detected ? null : 'Not installed',
      dim: !a.detected,
      checked: a.id === state.agent,
      icon: 'check',
      onSelect: () => {
        selectAgent(a.id)
        els.agent.querySelector('[data-fid="agent"]')?.focus({ preventScroll: true })
      },
    })),
  })
}

function renderFoot() {
  const agent = currentAgent()
  if (!agent || agent.id === 'claude') {
    return replaceChildren(els.foot, 'Changes apply to new Claude Code sessions, or after ', h('code', null, '/reload-plugins'), '.')
  }
  replaceChildren(els.foot, `Changes apply to new ${agent.name} sessions.`)
}

function renderUpdatesBar() {
  // Nothing to check when the agent cannot update anything from here.
  els.updates.hidden = !offers('update')
  const u = state.updates
  const now = Date.now()
  let status
  if (u.checking) status = [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, 'Checking for updates…')]
  else if (u.checkedAt) status = h('span', null, 'Checked ', h('time', { datetime: new Date(u.checkedAt).toISOString(), title: new Date(u.checkedAt).toLocaleString() }, relativeTime(u.checkedAt, now)))
  else status = h('span', null, 'Updates not checked yet')
  replaceChildren(
    els.updates,
    h(
      'div',
      { class: 'updates-row' },
      h('p', { class: 'updates-status', role: 'status', 'aria-live': 'polite' }, status),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          'data-act': 'check-updates',
          'data-fid': 'check-updates',
          'aria-busy': u.checking ? 'true' : null,
          disabled: u.checking || !!state.busy || !state.view,
          title: 'Ask each marketplace, the skills repos and npm for newer versions. Runs only when you click.',
        },
        icon('check-updates', 14),
        'Check for updates',
      ),
    ),
    // One warning line however many sources failed; the reasons open under it, like the problems list.
    !u.checking && u.errors.length
      ? h(
          'details',
          { class: 'updates-errors' },
          h('summary', null, icon('alert', 12), h('span', null, u.errors.length === 1 ? '1 source could not be checked' : `${u.errors.length} sources could not be checked`), icon('chevron', 10)),
          h('ul', { role: 'list' }, u.errors.map((e) => h('li', { class: 'updates-error' }, e))),
        )
      : null,
  )
}

function renderTabs() {
  const counts = state.view ? countByKind(state.view) : null
  replaceChildren(
    els.tabs,
    agentKinds().map((kind) => {
      const selected = kind === state.tab
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `tab-${kind}`,
          class: 'tab',
          'aria-selected': String(selected),
          'aria-controls': 'tabpanel',
          tabindex: selected ? '0' : '-1',
          'data-act': 'tab',
          'data-kind': kind,
          'data-fid': `tab:${kind}`,
        },
        h('span', { class: 'tab-label' }, KIND_LABEL[kind]),
        h('span', { class: 'tab-count', 'aria-label': counts ? `${counts[kind]} ${noun(kind, counts[kind])}` : 'loading' }, counts ? String(counts[kind]) : '–'),
        tabUpdates(kind),
      )
    }),
  )
  els.panel.setAttribute('aria-labelledby', `tab-${state.tab}`)
}

function tabUpdates(kind) {
  if (state.updates.checking || !supports(kind, 'update')) return null
  const n = updatableKeys(state.view, kind, state.updates.statuses).length
  if (!n) return null
  const total = countByKind(state.view)[kind]
  return h('span', { class: 'tab-updates', title: `${n} ${n === 1 ? 'update' : 'updates'} available · ${total} ${noun(kind, total)}`, 'aria-label': `${n} ${n === 1 ? 'update' : 'updates'}` }, icon('update', 9), String(n))
}

function renderProblems() {
  const problems = state.view?.problems ?? []
  els.problems.hidden = problems.length === 0
  if (!problems.length) return replaceChildren(els.problems)
  replaceChildren(
    els.problems,
    h(
      'details',
      { class: 'problems' },
      h('summary', null, icon('alert', 14), h('span', null, problems.length === 1 ? '1 problem in your settings' : `${problems.length} problems in your settings`)),
      h('ul', null, problems.map((p) => h('li', null, p))),
    ),
  )
}

function renderPanel() {
  if (!state.view) {
    if (state.loadError) return replaceChildren(els.panel, loadErrorState())
    return replaceChildren(els.panel, skeleton())
  }
  const { groups, matched, query } = groupsFor(state.view, state.tab, state.filter)
  if (query && matched === 0) return replaceChildren(els.panel, tabTools(), filterEmptyState())
  replaceChildren(els.panel, tabTools(), groups.map(renderGroup))
}

/** The tab's update actions: "Update all (N)" after a check, and Refresh marketplaces on Plugins. */
function tabTools() {
  const plugins = state.tab === 'plugins' && supports('plugins', 'refreshMarketplaces')
  const keys = state.updates.checking || !supports(state.tab, 'updateAll') ? [] : updatableKeys(state.view, state.tab, state.updates.statuses)
  if (!plugins && !keys.length) return null
  const busy = !!state.busy || state.updates.checking
  const n = keys.length
  return h(
    'div',
    { class: 'tab-tools' },
    plugins
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost btn-xs',
            'data-act': 'refresh-marketplaces',
            'data-fid': 'refresh-marketplaces',
            disabled: busy,
            title: 'Fetch the latest plugin lists from every marketplace (claude plugin marketplace update)',
          },
          icon('refresh', 12),
          'Refresh marketplaces',
        )
      : null,
    n
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-update btn-xs',
            'data-act': 'update-all',
            'data-fid': `update-all:${state.tab}`,
            disabled: busy,
            title: `Update every ${noun(state.tab, 1)} the last check marked available, one at a time`,
          },
          icon('update', 12),
          `Update all (${n})`,
        )
      : null,
  )
}

function skeleton() {
  const widths = [62, 48, 70, 55, 40, 66]
  return h(
    'div',
    { class: 'skeleton', 'aria-busy': 'true', 'aria-label': `Loading your ${agentName()} setup` },
    h('div', { class: 'sk-head' }, h('span', { class: 'sk-bar', style: 'width:72px' })),
    widths.map((w) => h('div', { class: 'sk-row' }, h('span', { class: 'sk-bar', style: `width:${w}%` }), h('span', { class: 'sk-bar sk-sub', style: `width:${w - 22}%` }))),
  )
}

function loadErrorState() {
  return h(
    'div',
    { class: 'state state-error', role: 'alert' },
    icon('alert', 18),
    h('p', { class: 'state-title' }, `Could not read your ${agentName()} settings`),
    h('p', { class: 'state-detail' }, state.loadError),
    h('p', { class: 'state-hint' }, 'Fix the file named above, then try again. Nothing was changed.'),
    h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'refresh', 'data-fid': 'retry' }, icon('refresh', 14), 'Try again'),
  )
}

function filterEmptyState() {
  return h(
    'div',
    { class: 'state' },
    icon('search', 18),
    h('p', { class: 'state-title' }, `No ${noun(state.tab, 2)} match “${state.filter.trim()}”`),
    h('p', { class: 'state-hint' }, 'The filter looks at names in Global and every project.'),
    h('button', { type: 'button', class: 'btn btn-secondary', 'data-act': 'clear-filter', 'data-fid': 'clear-filter' }, 'Clear filter'),
  )
}

function renderGroup(group) {
  const open = isOpenGroup(state.tab, group.id)
  const bodyId = `acc-${state.tab}-${group.id.replace(/[^a-z0-9]/gi, '_')}`
  const title = group.project ? projectName(group.project) : 'Global'
  const detail = group.project ? tildify(group.project) : 'All projects'
  const count = state.filter.trim() ? `${group.items.length}/${group.total}` : String(group.total)
  return h(
    'section',
    { class: 'acc', 'data-drop': group.project ?? '', 'data-group': group.id },
    h(
      'h2',
      { class: 'acc-heading' },
      h(
        'button',
        {
          type: 'button',
          class: 'acc-toggle',
          'aria-expanded': String(open),
          'aria-controls': bodyId,
          'data-act': 'toggle-group',
          'data-group': group.id,
          'data-fid': `acc:${group.id}`,
          title: group.project ?? 'User scope: applies in every project',
        },
        icon('chevron', 14),
        icon(group.project ? 'folder' : 'globe', 14),
        h('span', { class: 'acc-text' }, h('span', { class: 'acc-title' }, title), h('span', { class: group.project ? 'acc-path' : 'acc-path is-plain' }, detail)),
        h('span', { class: 'drop-label', 'aria-hidden': 'true' }),
        h('span', { class: 'acc-count', 'aria-label': `${group.total} ${noun(state.tab, group.total)}` }, count),
      ),
    ),
    h(
      'div',
      { class: 'acc-body', id: bodyId, hidden: !open },
      group.items.length
        ? h('ul', { class: 'items', role: 'list' }, group.items.map(renderItem))
        : h('p', { class: 'acc-empty' }, emptyGroupText(group)),
    ),
  )
}

function emptyGroupText(group) {
  if (state.filter.trim()) return `No match in ${group.project ? projectName(group.project) : 'Global'}.`
  const n = noun(state.tab, 2)
  const agent = currentAgent()
  if (agent && !agent.detected && !group.project) return `${agent.name} is not installed on this machine. Its ${n} would live in ${agent.configHome}.`
  if (group.project) return `No ${n} in this project.`
  return supports(state.tab, 'move') ? `No global ${n}. Drag one here from a project to use it everywhere.` : `No global ${n}.`
}

/** The agent can move items of this class: drag, Move to… and Copy to… are offered. */
const canMove = (item) => supports(item.kind, 'move')

function renderItem(item) {
  const busy = !!state.busy
  const working = isWorking(item)
  const draggable = item.movable && canMove(item) && !busy
  return h(
    'li',
    {
      class: `item kind-${item.kind}${working ? ' is-working' : ''}${enabledOf(item) === false ? ' is-off' : ''}`,
      'data-key': item.key,
      draggable: draggable ? 'true' : 'false',
      'aria-busy': working ? 'true' : null,
    },
    h(
      'div',
      { class: 'row' },
      canMove(item)
        ? h('span', { class: `grip${item.movable ? '' : ' is-locked'}`, title: item.movable ? 'Drag to move · ⌥ drag to copy' : item.notMovableReason ?? 'Cannot be moved' }, icon(item.movable ? 'grip' : 'lock', 14))
        : h('span', { class: 'grip', 'aria-hidden': 'true' }),
      h('div', { class: 'main' }, itemMain(item)),
      h('div', { class: 'trail' }, itemTrail(item, busy)),
    ),
    itemExtra(item, busy),
  )
}

/**
 * The item's name line. After a check the update status sits at its end, next to the row's controls,
 * so rows keep their height; it wraps under the name only when the name is long.
 */
function titleRow(item, name, ...rest) {
  const status = item.updateSource ? updateStatus(item) : null
  return h('div', { class: `title${status ? ' has-status' : ''}` }, h('span', { class: 'name' }, name), rest, status)
}

const isWorking = (item) => state.busy?.key === item.key || !!state.busy?.keys?.includes(item.key)

function scopeTag(item) {
  if (item.project === null) return null
  return h('span', { class: `tag tag-${item.scope}`, title: item.scope === 'local' ? 'Only me: not shared with the team' : 'Team: shared through the project files' }, scopeLabel(item.scope))
}

function itemMain(item) {
  switch (item.kind) {
    case 'plugins':
      return pluginMain(item)
    case 'skills':
    case 'agents':
      return docMain(item)
    case 'mcp':
      return [
        titleRow(item, item.name, h('span', { class: 'chip-mono' }, item.mcp?.transport ?? '?'), scopeTag(item)),
        h('div', { class: 'mono-line', title: item.mcp?.target ?? '' }, item.mcp?.target ?? ''),
        sourceRow(item),
        notMovable(item),
      ]
    case 'hooks':
      return [
        h('div', { class: 'title' }, h('span', { class: 'name' }, hookTitle(item)), scopeTag(item)),
        h('div', { class: 'mono-line wrap', title: item.source }, item.hook?.command ?? ''),
        sourceRow(item),
        notMovable(item),
      ]
  }
}

function notMovable(item) {
  return item.movable || !canMove(item) ? null : h('p', { class: 'note' }, icon('lock', 12), h('span', null, item.notMovableReason ?? 'This item cannot be moved.'))
}

const CONTRIB = [
  ['skills', 'skill', 'skills'],
  ['agents', 'agent', 'agents'],
  ['commands', 'command', 'commands'],
  ['hooks', 'hook', 'hooks'],
  ['mcpServers', 'MCP', 'MCP'],
]

function pluginMain(item) {
  const p = item.plugin
  const market = marketplaceOf(p.id)
  const badges = CONTRIB.filter(([k]) => p.contributes[k]?.length).map(([k, one, many]) => {
    const n = p.contributes[k].length
    return h('span', { class: 'badge' }, `${n} ${n === 1 ? one : many}`)
  })
  const expanded = state.expanded.has(item.key)
  const others = p.sharesNameWith.map(marketplaceOf).filter(Boolean)
  return [
    titleRow(item, item.name, scopeTag(item)),
    item.updateSource
      ? sourceRow(item, 'meta')
      : h('div', { class: 'meta' }, h('span', null, market || p.id), p.version ? h('span', { class: 'ver' }, p.version) : null),
    badges.length
      ? h(
          'div',
          { class: 'badges' },
          badges,
          h(
            'button',
            {
              type: 'button',
              class: 'link-btn',
              'aria-expanded': String(expanded),
              'data-act': 'expand',
              'data-key': item.key,
              'data-fid': `expand:${item.key}`,
            },
            expanded ? 'Hide contents' : 'Contents',
          ),
        )
      : null,
    others.length ? h('p', { class: 'note' }, icon('info', 12), h('span', null, `Also installed from ${others.join(', ')}`)) : null,
    notMovable(item),
  ]
}

function docMain(item) {
  const expanded = state.expanded.has(item.key)
  const long = item.description.length > 90
  return [
    titleRow(item, item.name, scopeTag(item)),
    item.description
      ? h(
          'p',
          { class: `desc${expanded ? '' : ' clamp'}` },
          item.description,
        )
      : h('p', { class: 'desc is-empty' }, 'No description.'),
    long
      ? h(
          'button',
          { type: 'button', class: 'link-btn', 'aria-expanded': String(expanded), 'data-act': 'expand', 'data-key': item.key, 'data-fid': `expand:${item.key}` },
          expanded ? 'Less' : 'More',
        )
      : null,
    h('div', { class: 'mono-line path', title: item.source }, tildify(item.source)),
    sourceRow(item),
    notMovable(item),
  ]
}

/**
 * Where the item updates from, and after a check its status, on one quiet line:
 * "marketplace · claude-plugins-official · 1.6.0", "skills · mattpocock/skills",
 * "npm · @upstash/context7-mcp 2.2.5", "Homebrew · brew upgrade engram". Nothing for local items.
 */
function sourceRow(item, extraClass = '') {
  const s = item.updateSource
  if (!s) return null
  const type = SOURCE_TYPE[s.type]
  const parts =
    s.type === 'manual'
      ? [h('span', { class: 'src-type' }, s.label), s.note ? h('span', { class: 'src-note' }, s.note) : null]
      : [
          h('span', { class: 'src-type' }, type),
          h('span', { class: 'src-label' }, s.label),
          s.current && s.type !== 'skills-cli' ? h('span', { class: `ver${s.type === 'npm' ? ' is-inline' : ''}` }, s.current) : null,
        ]
  const title =
    s.type === 'manual'
      ? `Updated outside this app by ${s.label}${s.note ? `: ${s.note}` : ''}`
      : `Updates from ${s.label}${s.current ? ` (installed: ${s.current})` : ''}`
  return h('div', { class: `src-row ${extraClass}`.trim() }, h('span', { class: 'src', title }, parts))
}

function updateStatus(item) {
  const s = item.updateSource
  if (state.updates.checking) return s.type === 'manual' ? null : h('span', { class: 'upd is-checking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, 'Checking'))
  const st = state.updates.statuses[item.key]
  if (!st) return null
  const latest = shortVersion(st.latest)
  if (st.status === 'available') {
    if (s.type === 'manual' || !supports(item.kind, 'update')) return h('span', { class: 'upd is-available', title: st.note ?? null }, latest ? `${latest} available` : 'Update available')
    return h(
      'button',
      {
        type: 'button',
        class: 'btn btn-update btn-xs upd-btn',
        'data-act': 'update',
        'data-key': item.key,
        'data-fid': `update:${item.key}`,
        disabled: !!state.busy,
        title: [`Update ${itemLabel(item)}${st.latest ? ` to ${st.latest}` : ''}`, st.note].filter(Boolean).join('. '),
      },
      icon('update', 12),
      'Update',
      latest ? h('span', { class: 'upd-ver' }, latest) : null,
    )
  }
  if (st.status === 'current') return h('span', { class: 'upd is-current' }, icon('check', 12), 'Up to date')
  return h(
    'span',
    { class: 'upd is-unknown', title: st.note ?? 'The source did not say.' },
    icon('info', 12),
    'Unknown',
    h('span', { class: 'sr-only' }, `: ${st.note ?? 'the source did not say.'}`),
  )
}

function itemTrail(item, busy) {
  const parts = []
  if (item.plugin && item.project !== null && supports(item.kind, 'clearOverride')) {
    parts.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-xs',
          'data-act': 'clear-override',
          'data-key': item.key,
          'data-fid': `clear:${item.key}`,
          disabled: busy,
          title: `Clear the override; ${item.name} follows Global again in ${projectName(item.project)}`,
        },
        'Clear',
      ),
    )
  }
  const on = enabledOf(item)
  if (typeof on === 'boolean' && !supports(item.kind, 'setEnabled')) {
    // Read-only: the state is shown, never a switch that would be refused.
    parts.push(h('span', { class: 'onoff', title: `${on ? 'On' : 'Off'}; ${agentName()} ${noun(item.kind, 2)} are read-only here` }, on ? 'On' : 'Off'))
  } else if (typeof on === 'boolean') {
    parts.push(
      h(
        'button',
        {
          type: 'button',
          role: 'switch',
          class: 'switch',
          'aria-checked': String(on),
          'aria-label': `${item.name} enabled in ${item.project ? projectName(item.project) : 'Global'}`,
          'data-act': 'toggle',
          'data-key': item.key,
          'data-fid': `switch:${item.key}`,
          disabled: busy,
        },
        h('span', { class: 'switch-thumb' }),
      ),
    )
  }
  // The overflow menu only when it has something the agent supports.
  if (!menuEntries(item).length) return parts
  parts.push(
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-haspopup': 'menu',
        'aria-label': `Actions for ${item.kind === 'hooks' ? hookTitle(item) : item.name}`,
        'data-act': 'menu',
        'data-key': item.key,
        'data-fid': `menu:${item.key}`,
        disabled: busy,
      },
      icon('more', 16),
    ),
  )
  return parts
}

function itemExtra(item, busy) {
  const extra = []
  if (item.plugin && state.expanded.has(item.key)) {
    extra.push(
      h(
        'dl',
        { class: 'contents' },
        CONTRIB.filter(([k]) => item.plugin.contributes[k]?.length).map(([k, , many]) => [
          h('dt', null, many === 'MCP' ? 'MCP servers' : many[0].toUpperCase() + many.slice(1)),
          h('dd', null, item.plugin.contributes[k].join(', ')),
        ]),
      ),
    )
  }
  if (state.confirm === item.key) {
    extra.push(
      h(
        'div',
        { class: 'confirm', role: 'group', 'aria-label': `Confirm uninstall of ${item.plugin.id}` },
        h('p', null, h('strong', null, `Uninstall ${item.name}?`), ` It is removed from ${marketplaceOf(item.plugin.id) || 'its marketplace'} for every project. Your settings are backed up first.`),
        h(
          'div',
          { class: 'confirm-actions' },
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-act': 'cancel-confirm', 'data-fid': `cancel:${item.key}`, disabled: busy }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'data-act': 'uninstall', 'data-key': item.key, 'data-fid': `uninstall:${item.key}`, disabled: busy }, 'Uninstall'),
        ),
      ),
    )
  }
  if (state.updateConfirm?.key === item.key) extra.push(updateConfirmBox(item.name, busy))
  if (isWorking(item)) extra.push(h('p', { class: 'working' }, state.busy.label ?? 'Working…'))
  return extra
}

/** S4: the command a plugin update would run. Only an explicit "Run update" sends the approval. */
function updateConfirmBox(name, busy) {
  const c = state.updateConfirm
  return h(
    'div',
    { class: 'confirm confirm-update', role: 'group', 'aria-label': `Approve the command for ${name}` },
    h('p', null, h('strong', null, `Update ${name}?`), ' ', c.message),
    h('p', { class: 'cmd-label', id: 'cmd-label' }, 'Command it will run'),
    h('pre', { class: 'cmd', tabindex: '0', 'aria-labelledby': 'cmd-label' }, c.command),
    h(
      'div',
      { class: 'confirm-actions' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-act': 'cancel-update', 'data-fid': 'cancel-update', disabled: busy }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-act': 'run-update', 'data-fid': 'run-update', disabled: busy }, 'Run update'),
    ),
  )
}

function renderBackups() {
  const backups = [...(state.view?.backups ?? [])].sort((a, b) => b.at - a.at)
  // An agent that cannot back up or restore, and has no backups, has nothing to show here.
  els.backups.hidden = !offers('snapshot') && !offers('restore') && backups.length === 0
  if (els.backups.hidden) return replaceChildren(els.backups)
  const open = state.backupsOpen
  const busy = !!state.busy
  const now = Date.now()
  replaceChildren(
    els.backups,
    h(
      'h2',
      { class: 'acc-heading' },
      h(
        'button',
        { type: 'button', class: 'acc-toggle backups-toggle', 'aria-expanded': String(open), 'aria-controls': 'backup-list', 'data-act': 'toggle-backups', 'data-fid': 'backups' },
        icon('chevron', 14),
        icon('archive', 14),
        h('span', { class: 'acc-text' }, h('span', { class: 'acc-title' }, 'Backups')),
        h('span', { class: 'acc-count' }, state.view ? String(backups.length) : '–'),
      ),
    ),
    h(
      'div',
      { id: 'backup-list', class: 'acc-body', hidden: !open },
      backups.length
        ? h(
            'ul',
            { class: 'backup-list', role: 'list' },
            backups.map((b) =>
              h(
                'li',
                { class: 'backup', 'data-backup': b.name },
                h(
                  'div',
                  { class: 'main' },
                  h('div', { class: 'name', title: b.target }, b.target.split(/[\\/]/).pop()),
                  h('div', { class: 'meta' }, h('span', { class: 'backup-path', title: b.target }, tildify(b.target)), h('time', { datetime: new Date(b.at).toISOString(), title: new Date(b.at).toLocaleString() }, relativeTime(b.at, now))),
                ),
                supportsAny('restore')
                  ? h(
                      'button',
                      { type: 'button', class: 'btn btn-ghost btn-xs', 'data-act': 'restore', 'data-name': b.name, 'data-fid': `restore:${b.name}`, disabled: busy },
                      icon('restore', 13),
                      'Restore',
                    )
                  : null,
              ),
            ),
          )
        : h('p', { class: 'acc-empty' }, offers('snapshot') ? 'No backups yet. Every change backs up its file first; Create backup saves them all at once.' : 'No backups yet. Every change backs up its file first.'),
    ),
  )
}

function renderNotice() {
  const n = state.notice
  const busy = !!state.busy
  // An approval for an item that is not on screen (another tab, filtered out) shows here instead.
  if (state.updateConfirm && !els.panel.querySelector('.confirm-update')) {
    const c = state.updateConfirm
    const name = itemByKey(c.key)?.name ?? c.action?.key ?? 'this item'
    return replaceChildren(els.notice, h('div', { class: 'notice notice-confirm' }, updateConfirmBox(name, busy)))
  }
  if (!n) return replaceChildren(els.notice)
  replaceChildren(
    els.notice,
    h(
      'div',
      { class: `notice tone-${n.tone}` },
      icon(n.tone === 'error' ? 'alert' : 'check', 16),
      h(
        'div',
        { class: 'notice-body' },
        h('p', { class: 'notice-message' }, n.message),
        n.warning ? h('p', { class: 'notice-warning' }, icon('alert', 12), h('span', null, n.warning)) : null,
        n.undo || n.team
          ? h(
              'div',
              { class: 'notice-actions' },
              n.undo ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-act': 'undo', 'data-fid': 'undo', disabled: busy }, icon('undo', 13), 'Undo') : null,
              n.team ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-act': 'make-team', 'data-fid': 'make-team', disabled: busy }, icon('users', 13), 'Make it a team item') : null,
            )
          : null,
      ),
      h('button', { type: 'button', class: 'icon-btn notice-close', 'aria-label': 'Dismiss', 'data-act': 'dismiss', 'data-fid': 'dismiss' }, icon('close', 14)),
    ),
  )
}

// ---------- Menus and picker ----------

/** Global, plus every project when items of this class can go into one. */
function destinations(kind) {
  return [
    { project: null, label: 'Global', detail: 'All projects' },
    ...(projectScopes(kind).length ? allProjects(state.view).map((p) => ({ project: p, label: projectName(p), detail: tildify(p) })) : []),
  ]
}

function openPickerFor(item, anchor, copy) {
  const verb = copy ? 'Copy' : 'Move'
  const label = item.kind === 'hooks' ? hookTitle(item) : item.name
  openPicker(anchor, {
    title: `${verb} ${label} to`,
    verb,
    destinations: destinations(item.kind),
    scopes: projectScopes(item.kind),
    isOwnPlace: (project, scope) =>
      sameProject(project, item.project) && (project === null || projectScopes(item.kind).length < 2 || scope === item.scope),
    onPick: (project, scope) => moveItem(item, project, scope, copy, { focusNotice: true }),
  })
}

/** The overflow menu of an item: only the actions its agent supports for its class. */
function menuEntries(item, anchor) {
  const global = item.project === null
  const entries = []
  if (canMove(item)) {
    entries.push(
      { label: 'Move to…', icon: 'move', disabled: !item.movable, hint: item.movable ? null : item.notMovableReason, onSelect: () => openPickerFor(item, anchor, false) },
      { label: 'Copy to…', icon: 'copy', disabled: !item.movable, hint: item.movable ? null : item.notMovableReason, onSelect: () => openPickerFor(item, anchor, true) },
    )
  }
  const source = item.updateSource
  if (source && supports(item.kind, 'update')) {
    const manual = source.type === 'manual'
    const latest = state.updates.statuses[item.key]?.status === 'available' ? shortVersion(state.updates.statuses[item.key].latest) : null
    entries.push({
      label: latest && !manual ? `Update to ${latest}` : 'Update',
      icon: 'update',
      disabled: manual || state.updates.checking,
      hint: manual ? `Updated outside this app by ${source.label}${source.note ? `: ${source.note}` : ''}` : `Update from ${source.label}`,
      onSelect: () => updateItem(item),
    })
  }
  const end = []
  if (item.plugin && global) {
    if (supports(item.kind, 'uninstall')) end.push({
      label: 'Uninstall…',
      icon: 'trash',
      danger: true,
      disabled: !item.plugin.installed,
      hint: item.plugin.installed ? null : 'Not installed',
      onSelect: () => {
        state.confirm = item.key
        render()
        document.querySelector(`[data-fid="${CSS.escape(`cancel:${item.key}`)}"]`)?.focus()
      },
    })
  } else if (item.plugin) {
    if (supports(item.kind, 'clearOverride')) end.push({ label: 'Clear override', icon: 'eraser', onSelect: () => run({ type: 'clearOverride', key: item.key }, { focusNotice: true }) })
  } else if (supports(item.kind, 'remove')) {
    end.push({
      label: 'Remove',
      icon: 'trash',
      danger: true,
      disabled: !item.removable,
      onSelect: () => run({ type: 'remove', key: item.key }, { focusNotice: true }),
    })
  }
  return entries.length && end.length ? [...entries, 'separator', ...end] : [...entries, ...end]
}

function openItemMenu(item, anchor) {
  const entries = menuEntries(item, anchor)
  if (entries.length) openMenu(anchor, { label: `Actions for ${item.name}`, entries })
}

// ---------- Events ----------

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act]')
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return
  const key = target.dataset.key
  const item = key ? itemByKey(key) : null
  switch (target.dataset.act) {
    case 'tab':
      return selectTab(target.dataset.kind)
    case 'agent-menu':
      return state.agents?.length && openAgentMenu(target)
    case 'refresh':
      return load()
    case 'snapshot':
      return run({ type: 'snapshot' }, { key: null })
    case 'check-updates':
      return checkUpdates()
    case 'update':
      return item && updateItem(item)
    case 'update-all':
      return updateAllOfTab()
    case 'refresh-marketplaces':
      return run({ type: 'refreshMarketplaces' }, { key: null, label: 'Refreshing…', focusAfter: 'refresh-marketplaces' })
    case 'run-update': {
      // Sent exactly as the backend returned it: the approval names the command the user saw.
      const c = state.updateConfirm
      return c && run(c.action, { key: c.key, label: 'Updating…', focusAfter: c.key ? `menu:${c.key}` : null })
    }
    case 'cancel-update': {
      const was = state.updateConfirm?.key
      state.updateConfirm = null
      render()
      return was && document.querySelector(`[data-fid="${CSS.escape(`menu:${was}`)}"]`)?.focus()
    }
    case 'clear-filter':
      els.filter.value = ''
      state.filter = ''
      render()
      return els.filter.focus()
    case 'toggle-group': {
      const id = target.dataset.group
      setGroupOpen(state.tab, id, !isOpenGroup(state.tab, id))
      return render()
    }
    case 'toggle-backups':
      state.backupsOpen = !state.backupsOpen
      store.set('backupsOpen', state.backupsOpen)
      return render()
    case 'expand':
      if (state.expanded.has(key)) state.expanded.delete(key)
      else state.expanded.add(key)
      return render()
    case 'toggle':
      return item && typeof enabledOf(item) === 'boolean' && run({ type: 'setEnabled', key, enabled: !enabledOf(item) })
    case 'clear-override':
      return item && run({ type: 'clearOverride', key })
    case 'menu':
      return item && openItemMenu(item, target)
    case 'cancel-confirm': {
      const was = state.confirm
      state.confirm = null
      render()
      return document.querySelector(`[data-fid="${CSS.escape(`menu:${was}`)}"]`)?.focus()
    }
    case 'uninstall':
      return item && run({ type: 'uninstall', key }, { focusNotice: true })
    case 'restore':
      return run({ type: 'restore', name: target.dataset.name }, { key: null, focusNotice: true })
    case 'undo':
      return state.notice?.undo && run(state.notice.undo, { key: state.notice.undo.key ?? null, focusNotice: true })
    case 'make-team':
      return state.notice?.team && run(state.notice.team, { focusNotice: true })
    case 'dismiss':
      state.notice = null
      return render()
  }
})

function selectTab(kind, focus = false) {
  if (!agentKinds().includes(kind)) return
  state.preferredTab = kind
  if (kind !== state.tab) {
    state.tab = kind
    state.confirm = null
    state.updateConfirm = null
    store.set('tab', kind)
    render()
  }
  if (focus) document.getElementById(`tab-${kind}`)?.focus()
}

els.tabs.addEventListener('keydown', (e) => {
  const kinds = agentKinds()
  const i = kinds.indexOf(state.tab)
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: kinds.length - 1 }[e.key]
  if (next === undefined) return
  e.preventDefault()
  selectTab(kinds[(next + kinds.length) % kinds.length], true)
  document.getElementById(`tab-${state.tab}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value
  renderPanel()
  els.filterClear.hidden = !state.filter
})
els.filter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.filter.value) {
    e.preventDefault()
    els.filter.value = ''
    state.filter = ''
    render()
  }
})

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
    e.preventDefault()
    els.filter.focus()
    els.filter.select()
  }
})

// ---------- Drag and drop ----------
// Drag MOVES; holding ⌥ Option (altKey) COPIES. Drop targets: every accordion, and while dragging a
// strip that lists Global and every known project, including those with no items.

const DRAG_TYPE = 'application/x-claude-config-item'

function zoneProject(zone) {
  const value = zone.dataset.drop
  return value === '' ? null : value
}

function renderStrip(item) {
  const chips = destinations(item.kind).map((d) => {
    const own = sameProject(d.project, item.project)
    return h(
      'li',
      {
        class: `chip${own ? ' is-own' : ''}`,
        'data-drop': d.project ?? '',
        title: own ? 'Current place' : d.project ?? 'Global: all projects',
      },
      icon(d.project ? 'folder' : 'globe', 13),
      h('span', null, d.label),
    )
  })
  replaceChildren(
    els.strip,
    h(
      'div',
      { class: 'strip-head' },
      h('span', { class: 'strip-mode', 'data-mode': 'move' }, icon('move', 14), h('span', { class: 'strip-verb' }, 'Move')),
      h('span', { class: 'strip-hint' }, 'Hold ⌥ to copy'),
    ),
    h('p', { class: 'strip-label' }, 'Drop on a project'),
    h('ul', { class: 'chips', role: 'list' }, chips),
  )
}

function setDragMode(copy) {
  if (!state.drag || state.drag.copy === copy) return
  state.drag.copy = copy
  root.dataset.dragMode = copy ? 'copy' : 'move'
  const mode = els.strip.querySelector('.strip-mode')
  if (mode) {
    mode.dataset.mode = copy ? 'copy' : 'move'
    mode.replaceChildren(icon(copy ? 'copy' : 'move', 14), h('span', { class: 'strip-verb' }, copy ? 'Copy' : 'Move'))
  }
  const hint = els.strip.querySelector('.strip-hint')
  if (hint) hint.textContent = copy ? 'Release ⌥ to move' : 'Hold ⌥ to copy'
  for (const label of document.querySelectorAll('.drop-label')) label.textContent = copy ? 'Copy here' : 'Move here'
}

function setActiveZone(zone) {
  if (state.drag.zone === zone) return
  state.drag.zone?.classList.remove('is-drop-target')
  state.drag.zone = zone
  zone?.classList.add('is-drop-target')
}

function endDrag() {
  if (!state.drag) return
  state.drag.source?.classList.remove('is-dragging')
  state.drag.zone?.classList.remove('is-drop-target')
  for (const zone of document.querySelectorAll('.is-own-place, .is-no-drop')) zone.classList.remove('is-own-place', 'is-no-drop')
  state.drag = null
  delete root.dataset.dragMode
  root.classList.remove('is-dragging')
  els.strip.hidden = true
  els.notice.classList.remove('is-hidden-by-drag')
}

document.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('.item[draggable="true"]')
  if (!li || state.busy) return
  const item = itemByKey(li.dataset.key)
  if (!item?.movable || !canMove(item)) return e.preventDefault()
  closePopover({ restoreFocus: false })
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData(DRAG_TYPE, item.key)
  e.dataTransfer.setData('text/plain', item.kind === 'hooks' ? hookTitle(item) : item.name)
  state.drag = { key: item.key, project: item.project, copy: null, zone: null, source: li }
  // Only toggle classes here: re-rendering the list mid-drag would remove the drag source.
  li.classList.add('is-dragging')
  root.classList.add('is-dragging')
  renderStrip(item)
  els.strip.hidden = false
  els.notice.classList.add('is-hidden-by-drag')
  // A project is no target for a class that never goes into one (no projectScopes for it).
  const intoProjects = projectScopes(item.kind).length > 0
  for (const zone of document.querySelectorAll('[data-drop]')) {
    if (sameProject(zoneProject(zone), item.project)) zone.classList.add('is-own-place')
    else if (!intoProjects && zoneProject(zone) !== null) zone.classList.add('is-no-drop')
  }
  setDragMode(e.altKey)
})

/** dragenter and dragover both aim the drop: dragover repeats while still, dragenter fires on each new element. */
function aimDrop(e) {
  if (!state.drag) return
  setDragMode(e.altKey)
  const zone = e.target.closest?.('[data-drop]')
  if (!zone || zone.classList.contains('is-own-place') || zone.classList.contains('is-no-drop')) {
    setActiveZone(null)
    e.dataTransfer.dropEffect = 'none'
    return
  }
  e.preventDefault()
  e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
  setActiveZone(zone)
}
document.addEventListener('dragenter', aimDrop)
document.addEventListener('dragover', aimDrop)

document.addEventListener('dragleave', (e) => {
  // Chromium leaves relatedTarget null on drag events, so detect leaving the panel by position;
  // moves between zones are handled by dragover.
  if (!state.drag) return
  const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
  if (outside) setActiveZone(null)
})

document.addEventListener('drop', (e) => {
  if (!state.drag) return
  const zone = e.target.closest?.('[data-drop]')
  const item = itemByKey(state.drag.key)
  const copy = e.altKey || e.dataTransfer.dropEffect === 'copy' || state.drag.copy === true
  e.preventDefault()
  endDrag()
  if (!zone || !item || zone.classList.contains('is-own-place') || zone.classList.contains('is-no-drop')) return
  const project = zoneProject(zone)
  if (sameProject(project, item.project)) return
  moveItem(item, project, undefined, copy)
})

document.addEventListener('dragend', endDrag)

// ---------- Boot ----------

root.dataset.transport = transport.mode
render()
load()
// Keeps "Checked 3 min ago" honest. It only re-reads the clock; it never asks the backend anything.
setInterval(() => {
  if (state.updates.checkedAt && !state.updates.checking) renderUpdatesBar()
}, 30_000)

/** The agent's note, kept to two lines until the user asks for the rest. */
function agentNote(note) {
  const text = h('span', { class: 'agent-note-text' }, note)
  const long = note.length > 140
  const box = h('div', { class: 'agent-note' }, icon('info', 12), text)
  if (!long) return box
  const toggle = h('button', { type: 'button', class: 'agent-note-more', 'aria-expanded': 'false' }, 'More')
  toggle.addEventListener('click', () => {
    const open = box.classList.toggle('is-open')
    toggle.textContent = open ? 'Less' : 'More'
    toggle.setAttribute('aria-expanded', String(open))
  })
  box.append(toggle)
  return box
}
