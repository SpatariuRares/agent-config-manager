import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getProvider, PROVIDERS } from './registry.ts'

test('the registry lists Claude Code, and refuses ids it does not have', () => {
  assert.deepEqual(PROVIDERS.map((provider) => provider.id), ['claude'])
  const found = getProvider('claude')
  assert.ok(found.ok)
  assert.equal(found.provider, PROVIDERS[0])
  for (const id of ['codex-nope', '', undefined, null, 1, '__proto__', 'toString']) {
    const missing = getProvider(id)
    assert.equal(missing.ok, false, String(id))
    assert.equal(!missing.ok && missing.reason, 'unknown-agent')
  }
  assert.ok(Object.isFrozen(PROVIDERS))
})
