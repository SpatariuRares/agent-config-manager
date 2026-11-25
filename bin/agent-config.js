#!/usr/bin/env node
// The `agent-config` command. Node.js 23.6+ runs the TypeScript sources directly (type stripping is on by default
// there), so there is no build step. This file stays plain JavaScript so older Node versions reach the version check.
import { unsupportedNodeMessage } from './node-check.js'

const tooOld = unsupportedNodeMessage(process.versions.node)
if (tooOld !== null) {
  console.error(tooOld)
  process.exit(1)
}

try {
  const { main } = await import('../src/cli/main.ts')
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // Node refuses to strip types from files inside node_modules, which is where a copied (not linked) install lands.
  if (error && error.code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    console.error('agent-config must run from a clone of its repository: in the clone, run `npm link` (or `npm install -g .`).')
    process.exit(1)
  }
  throw error
}
