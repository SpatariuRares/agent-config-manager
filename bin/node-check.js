// Plain JavaScript on purpose: it must load on any Node, before any TypeScript file is imported.

/** The message for a Node.js too old to run TypeScript directly, or null when `version` is 23.6 or newer. */
export function unsupportedNodeMessage(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number)
  if (major > 23 || (major === 23 && minor >= 6)) return null
  return `agent-config needs Node.js 23.6 or newer; this is Node.js ${String(version).replace(/^v/, '')}.\nInstall a current Node.js from https://nodejs.org and try again.`
}
