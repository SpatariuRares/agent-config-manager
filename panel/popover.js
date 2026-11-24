// One floating layer at a time: the overflow menu or the Move/Copy picker.
// Fixed-positioned in #layer so no scrolling container clips it; never modal.

import { h } from './dom.js'
import { icon } from './icons.js'

let current = null

export function isOpen() {
  return current !== null
}

export function closePopover({ restoreFocus = true } = {}) {
  if (!current) return
  const { el, anchor, cleanup } = current
  current = null
  cleanup()
  el.remove()
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true })
}

function place(el, anchor) {
  const r = anchor.getBoundingClientRect()
  const gap = 4
  const margin = 8
  const w = el.offsetWidth
  const hgt = el.offsetHeight
  let left = Math.min(r.right - w, window.innerWidth - w - margin)
  left = Math.max(margin, left)
  let top = r.bottom + gap
  if (top + hgt > window.innerHeight - margin && r.top - gap - hgt >= margin) top = r.top - gap - hgt
  top = Math.max(margin, Math.min(top, window.innerHeight - hgt - margin))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}

function open(anchor, el, onKey) {
  closePopover({ restoreFocus: false })
  const layer = document.getElementById('layer')
  layer.append(el)
  place(el, anchor)
  const onPointer = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover({ restoreFocus: false })
  }
  // Follow the anchor when the page scrolls; close once it is gone or out of view.
  const onScroll = (e) => {
    if (el.contains(e.target)) return
    const r = anchor.getBoundingClientRect()
    if (!anchor.isConnected || r.bottom < 0 || r.top > window.innerHeight) closePopover({ restoreFocus: false })
    else place(el, anchor)
  }
  const onResize = () => closePopover({ restoreFocus: false })
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closePopover()
    } else onKey?.(e)
  }
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onResize)
  el.addEventListener('keydown', onKeydown)
  current = {
    el,
    anchor,
    cleanup() {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    },
  }
  return el
}

/**
 * Overflow menu. entries: { label, icon, onSelect, danger?, disabled?, hint? } or 'separator'.
 * A choice menu (the agent switcher) gives every entry `checked`, and may add `detail` (a second,
 * quieter line), `tag` (a short marker) and `dim` (shown quieter, still selectable).
 */
export function openMenu(anchor, { label, entries, className = '' }) {
  const buttons = []
  const menu = h(
    'div',
    { class: `popover menu ${className}`.trim(), role: 'menu', 'aria-label': label },
    entries.map((entry) => {
      if (entry === 'separator') return h('div', { class: 'menu-sep', role: 'separator' })
      const choice = entry.checked !== undefined
      const button = h(
        'button',
        {
          type: 'button',
          class: `menu-item${entry.danger ? ' is-danger' : ''}${entry.dim ? ' is-dim' : ''}${entry.detail ? ' has-detail' : ''}`,
          role: choice ? 'menuitemradio' : 'menuitem',
          'aria-checked': choice ? String(!!entry.checked) : null,
          tabindex: '-1',
          'aria-disabled': entry.disabled ? 'true' : null,
          title: entry.hint ?? null,
          onclick: () => {
            if (entry.disabled) return
            closePopover({ restoreFocus: false })
            entry.onSelect()
          },
        },
        icon(entry.icon, 14),
        entry.detail
          ? h('span', { class: 'menu-text' }, h('span', { class: 'menu-label' }, entry.label), h('span', { class: 'menu-detail' }, entry.detail))
          : h('span', { class: 'menu-label' }, entry.label),
        entry.tag ? h('span', { class: 'menu-tag' }, entry.tag) : null,
      )
      buttons.push(button)
      return button
    }),
  )
  const focusAt = (i) => buttons[(i + buttons.length) % buttons.length]?.focus()
  open(anchor, menu, (e) => {
    const i = buttons.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') focusAt(i + 1)
    else if (e.key === 'ArrowUp') focusAt(i - 1)
    else if (e.key === 'Home') focusAt(0)
    else if (e.key === 'End') focusAt(buttons.length - 1)
    else if (e.key === 'Tab') return closePopover({ restoreFocus: false })
    else return
    e.preventDefault()
  })
  focusAt(Math.max(0, buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true')))
}

const SCOPE_OPTION = { local: ['Only me', 'user'], project: ['Team', 'users'] }
const SCOPE_NOTE = {
  local: 'Only me: kept in your own settings for that project, not shared.',
  project: 'Team: written to the project files, usually committed and shared.',
}
const ONLY_SCOPE_NOTE = {
  local: 'In a project, this class is kept only for you.',
  project: 'In a project, this class is always shared with the team.',
}

/**
 * Move/Copy picker: a destination listbox (Global and every project) plus, when the class may go into a
 * project in more than one scope, a choice between them. Not a modal: Escape or a click outside closes it.
 * options: { title, verb, destinations: [{ project, label, detail }], scopes, isOwnPlace(project, scope), onPick(project, scope) }
 * `scopes`: the agent's projectScopes for the class, default first; with one, it is used without asking.
 */
export function openPicker(anchor, { title, verb, destinations, scopes = ['project'], isOwnPlace, onPick }) {
  let scope = scopes[0] ?? 'project'
  let active = -1
  const uid = `pk${Date.now().toString(36)}`
  const withScope = scopes.length > 1

  const radios = withScope
    ? scopes.map((value) => {
        const [text, glyph] = SCOPE_OPTION[value]
        return h('button', { type: 'button', role: 'radio', class: 'seg-option', 'data-value': value, tabindex: '-1' }, icon(glyph, 14), text)
      })
    : []
  const scopeNote = h('p', { class: 'picker-note' })
  const options = destinations.map((d, i) =>
    h(
      'li',
      { role: 'option', id: `${uid}-${i}`, class: 'picker-option', 'data-index': String(i), title: d.project ?? null },
      icon(d.project ? 'folder' : 'globe', 14),
      h('span', { class: 'picker-name' }, d.label),
      d.detail ? h('span', { class: 'picker-detail' }, d.detail) : null,
      h('span', { class: 'picker-here' }, 'Current place'),
    ),
  )
  const listbox = h('ul', { class: 'picker-list', role: 'listbox', tabindex: '0', 'aria-label': `${verb} to` }, options)

  const disabledAt = (i) => isOwnPlace(destinations[i].project, scope)
  function sync() {
    for (const r of radios) {
      const on = r.dataset.value === scope
      r.setAttribute('aria-checked', String(on))
      r.tabIndex = on ? 0 : -1
    }
    scopeNote.textContent = withScope ? SCOPE_NOTE[scope] : scopes.length ? ONLY_SCOPE_NOTE[scope] : 'This class stays out of projects: it can only go to Global.'
    options.forEach((o, i) => {
      o.setAttribute('aria-disabled', String(disabledAt(i)))
      o.setAttribute('aria-selected', String(i === active))
    })
    if (active >= 0 && disabledAt(active)) active = -1
    if (active < 0) active = options.findIndex((_, i) => !disabledAt(i))
    options.forEach((o, i) => o.setAttribute('aria-selected', String(i === active)))
    if (active >= 0) {
      listbox.setAttribute('aria-activedescendant', options[active].id)
      options[active].scrollIntoView({ block: 'nearest' })
    } else listbox.removeAttribute('aria-activedescendant')
  }
  function step(delta) {
    for (let n = 1; n <= options.length; n++) {
      const i = (active + delta * n + options.length * n) % options.length
      if (!disabledAt(i)) {
        active = i
        return sync()
      }
    }
  }
  function pick(i) {
    if (i < 0 || disabledAt(i)) return
    const { project } = destinations[i]
    closePopover({ restoreFocus: false })
    onPick(project, project === null ? undefined : scope)
  }

  for (const r of radios) {
    r.addEventListener('click', () => {
      scope = r.dataset.value
      sync()
    })
    r.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown'
        scope = scopes[(scopes.indexOf(scope) + (forward ? 1 : scopes.length - 1)) % scopes.length]
        sync()
        radios.find((x) => x.dataset.value === scope).focus()
      }
    })
  }
  listbox.addEventListener('click', (e) => {
    const option = e.target.closest('[role="option"]')
    if (option) pick(Number(option.dataset.index))
  })
  listbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'Home') {
      active = -1
      step(1)
    } else if (e.key === 'End') {
      active = 0
      step(-1)
    } else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else return
    e.preventDefault()
  })

  const el = h(
    'div',
    { class: 'popover picker', role: 'dialog', 'aria-label': title },
    h('p', { class: 'picker-title' }, title),
    withScope ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Who it is for, in a project' }, radios) : null,
    scopeNote,
    listbox,
  )
  sync()
  open(anchor, el, (e) => {
    if (e.key === 'Tab') {
      // Keep Tab inside the picker: scope choice <-> list.
      const stops = [radios.find((r) => r.tabIndex === 0), listbox].filter(Boolean)
      const i = stops.indexOf(document.activeElement)
      e.preventDefault()
      stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus()
    }
  })
  listbox.focus()
}
