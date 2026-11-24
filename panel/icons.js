// Authored icons: 16px grid, 1.5 stroke, round caps. One family for the whole panel.

const paths = {
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
  archive: '<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6"/><path d="M6.5 9h3"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  more: '<circle cx="3.5" cy="8" r=".75"/><circle cx="8" cy="8" r=".75"/><circle cx="12.5" cy="8" r=".75"/>',
  grip: '<circle cx="6" cy="4" r=".6"/><circle cx="10" cy="4" r=".6"/><circle cx="6" cy="8" r=".6"/><circle cx="10" cy="8" r=".6"/><circle cx="6" cy="12" r=".6"/><circle cx="10" cy="12" r=".6"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  undo: '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>',
  alert: '<path d="M8 2.2 14.2 13a.6.6 0 0 1-.5.9H2.3a.6.6 0 0 1-.5-.9z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.6" r=".5"/>',
  check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  globe: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5"/><path d="M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  move: '<path d="M2.5 8h10"/><path d="m9.5 5 3 3-3 3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  trash: '<path d="M2.5 4.5h11"/><path d="M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5"/><path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6"/>',
  restore: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v3h3"/><path d="M8 5.5V8l1.8 1.2"/>',
  info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.5"/><circle cx="8" cy="5.1" r=".5"/>',
  eraser: '<path d="m9.2 2.8 4 4-6.4 6.4H3.7L2.3 11.8a1 1 0 0 1 0-1.4z"/><path d="M6.8 13.2h6.7"/><path d="m5.6 6.4 4 4"/>',
  users: '<circle cx="6" cy="5.5" r="2.25"/><path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5"/><path d="M10.5 3.5a2.25 2.25 0 0 1 0 4.2"/><path d="M12 9.8c1 .5 1.8 1.6 2 3.2"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4"/>',
}

const NS = 'http://www.w3.org/2000/svg'

export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon icon-${name}`)
  svg.innerHTML = paths[name] ?? ''
  return svg
}
