// Tiny DOM builder: h('button', { class: 'btn', 'data-act': 'x' }, 'Label').
// Attributes with null, undefined or false are left out; true sets an empty attribute.

export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [name, value] of Object.entries(props)) {
      if (value == null || value === false) continue
      if (name === 'class') el.className = value
      else if (name === 'text') el.textContent = value
      else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value)
      else if (value === true) el.setAttribute(name, '')
      else el.setAttribute(name, String(value))
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue
    if (Array.isArray(child)) append(el, child)
    else el.append(child instanceof Node ? child : String(child))
  }
}

/** Replaces an element's children, keeping focus on an equivalent control when one exists. */
export function replaceChildren(el, ...children) {
  const focusId = document.activeElement?.closest?.('[data-fid]')?.dataset.fid
  const hadFocusInside = focusId && el.contains(document.activeElement)
  el.replaceChildren()
  append(el, children)
  if (hadFocusInside) el.querySelector(`[data-fid="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true })
}
