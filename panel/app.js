// Claude Config panel: state, rendering and interaction. Talks to the backend only through transport.js.

import { h, replaceChildren } from './dom.js'
import { icon } from './icons.js'
import { closePopover, openMenu, openPicker } from './popover.js'
import { createTransport } from './transport.js'
import {
  KINDS,
  KIND_LABEL,
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
  tildify,
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

const state = {
  view: null,
  loading: true,
  loadError: null,
  tab: KINDS.includes(store.get('tab', 'plugins')) ? store.get('tab', 'plugins') : 'plugins',
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
}

const $ = (id) => document.getElementById(id)
const els = {
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

// ---------- Backend calls ----------

async function load() {
  state.loading = true
  render()
  const answer = await transport.getView()
  state.loading = false
  if (answer.ok) {
    state.view = answer.view
    state.loadError = null
  } else {
    state.loadError = answer.error
  }
  render()
}

/**
 * Runs one action: disables every other action, shows progress on the item, then re-renders from
 * the returned view and reports the result in the notice area.
 */
async function run(action, { key = action.key ?? null, focusNotice = false, describe } = {}) {
  if (state.busy) return
  closePopover({ restoreFocus: false })
  // Controls are disabled while the action runs, which drops focus; put it back afterwards.
  const focusId = document.activeElement?.closest?.('[data-fid]')?.dataset.fid
  state.busy = { key }
  state.confirm = null
  render()
  const answer = await transport.runAction(action)
  state.busy = null
  const { result, view } = answer
  let reloadError = null
  if (view?.ok) {
    state.view = view.view
    state.loadError = null
  } else reloadError = view?.error ?? 'No view came back.'

  const notice = result.ok
    ? { tone: 'ok', message: result.message, warning: result.warning, undo: result.undo }
    : { tone: 'error', message: result.message, detail: result.reason }
  if (reloadError && result.ok) notice.warning = [notice.warning, `The list could not be reloaded: ${reloadError}. Use Refresh.`].filter(Boolean).join(' ')
  if (result.ok) Object.assign(notice, describe?.(state.view) ?? {})
  state.notice = notice
  render()
  if (focusNotice) els.notice.querySelector('button')?.focus({ preventScroll: true })
  else if (focusId && (document.activeElement === document.body || !document.activeElement)) {
    document.querySelector(`[data-fid="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true })
  }
}

/** After a drop into a project as "only me", offer to make the new item a team item. */
function teamOffer(item, project) {
  return (view) => {
    const placed = view?.items.find((i) => i.kind === item.kind && i.name === item.name && i.project === project && i.scope === 'local')
    return placed ? { team: { type: 'move', key: placed.key, to: { project, scope: 'project' }, copy: false } } : {}
  }
}

function moveItem(item, project, scope, copy, opts = {}) {
  const to = project === null ? { project: null } : { project, scope: scope ?? (hasLocalScope(item.kind) ? 'local' : 'project') }
  const offer = project !== null && to.scope === 'local' ? teamOffer(item, project) : undefined
  return run({ type: 'move', key: item.key, to, copy }, { ...opts, describe: offer })
}

// ---------- Rendering ----------

function render() {
  root.classList.toggle('is-busy', !!state.busy)
  renderTabs()
  renderProblems()
  renderPanel()
  renderBackups()
  renderNotice()
  els.refresh.disabled = !!state.busy || state.loading
  els.snapshot.disabled = !!state.busy || !state.view
  els.filterClear.hidden = !state.filter
  els.filter.placeholder = `Filter ${noun(state.tab, 2)} by name`
}

function renderTabs() {
  const counts = state.view ? countByKind(state.view) : null
  replaceChildren(
    els.tabs,
    KINDS.map((kind) => {
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
      )
    }),
  )
  els.panel.setAttribute('aria-labelledby', `tab-${state.tab}`)
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
  if (query && matched === 0) return replaceChildren(els.panel, filterEmptyState())
  replaceChildren(els.panel, groups.map(renderGroup))
}

function skeleton() {
  const widths = [62, 48, 70, 55, 40, 66]
  return h(
    'div',
    { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading your Claude Code setup' },
    h('div', { class: 'sk-head' }, h('span', { class: 'sk-bar', style: 'width:72px' })),
    widths.map((w) => h('div', { class: 'sk-row' }, h('span', { class: 'sk-bar', style: `width:${w}%` }), h('span', { class: 'sk-bar sk-sub', style: `width:${w - 22}%` }))),
  )
}

function loadErrorState() {
  return h(
    'div',
    { class: 'state state-error', role: 'alert' },
    icon('alert', 18),
    h('p', { class: 'state-title' }, 'Could not read your Claude Code settings'),
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
  return group.project
    ? `No ${n} in this project.`
    : `No global ${n}. Drag one here from a project to use it everywhere.`
}

function renderItem(item) {
  const busy = !!state.busy
  const working = state.busy?.key === item.key
  const draggable = item.movable && !busy
  return h(
    'li',
    {
      class: `item kind-${item.kind}${working ? ' is-working' : ''}${item.plugin && !item.plugin.enabled ? ' is-off' : ''}`,
      'data-key': item.key,
      draggable: draggable ? 'true' : 'false',
      'aria-busy': working ? 'true' : null,
    },
    h(
      'div',
      { class: 'row' },
      h('span', { class: `grip${item.movable ? '' : ' is-locked'}`, title: item.movable ? 'Drag to move · ⌥ drag to copy' : item.notMovableReason ?? 'Cannot be moved' }, icon(item.movable ? 'grip' : 'lock', 14)),
      h('div', { class: 'main' }, itemMain(item)),
      h('div', { class: 'trail' }, itemTrail(item, busy)),
    ),
    itemExtra(item, busy),
  )
}

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
        h('div', { class: 'title' }, h('span', { class: 'name' }, item.name), h('span', { class: 'chip-mono' }, item.mcp?.transport ?? '?'), scopeTag(item)),
        h('div', { class: 'mono-line', title: item.mcp?.target ?? '' }, item.mcp?.target ?? ''),
        notMovable(item),
      ]
    case 'hooks':
      return [
        h('div', { class: 'title' }, h('span', { class: 'name' }, hookTitle(item)), scopeTag(item)),
        h('div', { class: 'mono-line wrap', title: item.source }, item.hook?.command ?? ''),
        notMovable(item),
      ]
  }
}

function notMovable(item) {
  return item.movable ? null : h('p', { class: 'note' }, icon('lock', 12), h('span', null, item.notMovableReason ?? 'This item cannot be moved.'))
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
    h('div', { class: 'title' }, h('span', { class: 'name' }, item.name), scopeTag(item)),
    h('div', { class: 'meta' }, h('span', null, market || p.id), p.version ? h('span', { class: 'ver' }, p.version) : null),
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
    h('div', { class: 'title' }, h('span', { class: 'name' }, item.name), scopeTag(item)),
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
    notMovable(item),
  ]
}

function itemTrail(item, busy) {
  const parts = []
  if (item.plugin && item.project !== null) {
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
  if (item.plugin) {
    const on = item.plugin.enabled
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
  if (state.busy?.key === item.key) extra.push(h('p', { class: 'working' }, 'Working…'))
  return extra
}

function renderBackups() {
  const backups = [...(state.view?.backups ?? [])].sort((a, b) => b.at - a.at)
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
                h(
                  'button',
                  { type: 'button', class: 'btn btn-ghost btn-xs', 'data-act': 'restore', 'data-name': b.name, 'data-fid': `restore:${b.name}`, disabled: busy },
                  icon('restore', 13),
                  'Restore',
                ),
              ),
            ),
          )
        : h('p', { class: 'acc-empty' }, 'No backups yet. Every change backs up its file first; Create backup saves them all at once.'),
    ),
  )
}

function renderNotice() {
  const n = state.notice
  if (!n) return replaceChildren(els.notice)
  const busy = !!state.busy
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

function destinations() {
  return [
    { project: null, label: 'Global', detail: 'All projects' },
    ...allProjects(state.view).map((p) => ({ project: p, label: projectName(p), detail: tildify(p) })),
  ]
}

function openPickerFor(item, anchor, copy) {
  const verb = copy ? 'Copy' : 'Move'
  const label = item.kind === 'hooks' ? hookTitle(item) : item.name
  openPicker(anchor, {
    title: `${verb} ${label} to`,
    verb,
    destinations: destinations(),
    withScope: hasLocalScope(item.kind),
    isOwnPlace: (project, scope) =>
      sameProject(project, item.project) && (project === null || !hasLocalScope(item.kind) || scope === item.scope),
    onPick: (project, scope) => moveItem(item, project, scope, copy, { focusNotice: true }),
  })
}

function openItemMenu(item, anchor) {
  const global = item.project === null
  const entries = [
    { label: 'Move to…', icon: 'move', disabled: !item.movable, hint: item.movable ? null : item.notMovableReason, onSelect: () => openPickerFor(item, anchor, false) },
    { label: 'Copy to…', icon: 'copy', disabled: !item.movable, hint: item.movable ? null : item.notMovableReason, onSelect: () => openPickerFor(item, anchor, true) },
    'separator',
  ]
  if (item.plugin && global) {
    entries.push({
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
    entries.push({ label: 'Clear override', icon: 'eraser', onSelect: () => run({ type: 'clearOverride', key: item.key }, { focusNotice: true }) })
  } else {
    entries.push({
      label: 'Remove',
      icon: 'trash',
      danger: true,
      disabled: !item.removable,
      onSelect: () => run({ type: 'remove', key: item.key }, { focusNotice: true }),
    })
  }
  openMenu(anchor, { label: `Actions for ${item.name}`, entries })
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
    case 'refresh':
      return load()
    case 'snapshot':
      return run({ type: 'snapshot' }, { key: null })
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
      return item && run({ type: 'setEnabled', key, enabled: !item.plugin.enabled })
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
  if (!KINDS.includes(kind)) return
  if (kind !== state.tab) {
    state.tab = kind
    state.confirm = null
    store.set('tab', kind)
    render()
  }
  if (focus) document.getElementById(`tab-${kind}`)?.focus()
}

els.tabs.addEventListener('keydown', (e) => {
  const i = KINDS.indexOf(state.tab)
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: KINDS.length - 1 }[e.key]
  if (next === undefined) return
  e.preventDefault()
  selectTab(KINDS[(next + KINDS.length) % KINDS.length], true)
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
  const chips = destinations().map((d) => {
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
  for (const zone of document.querySelectorAll('.is-own-place')) zone.classList.remove('is-own-place')
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
  if (!item?.movable) return e.preventDefault()
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
  for (const zone of document.querySelectorAll('[data-drop]')) {
    if (sameProject(zoneProject(zone), item.project)) zone.classList.add('is-own-place')
  }
  setDragMode(e.altKey)
})

/** dragenter and dragover both aim the drop: dragover repeats while still, dragenter fires on each new element. */
function aimDrop(e) {
  if (!state.drag) return
  setDragMode(e.altKey)
  const zone = e.target.closest?.('[data-drop]')
  if (!zone || zone.classList.contains('is-own-place')) {
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
  if (!zone || !item || zone.classList.contains('is-own-place')) return
  const project = zoneProject(zone)
  if (sameProject(project, item.project)) return
  moveItem(item, project, undefined, copy)
})

document.addEventListener('dragend', endDrag)

// ---------- Boot ----------

root.dataset.transport = transport.mode
render()
load()
