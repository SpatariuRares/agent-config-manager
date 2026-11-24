// The shared redaction rules: what every provider shows of MCP targets, hook commands and CLI argv.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { argsHaveSecret, looksSecret, redactArgs, redactCommand, redactUrl, urlHasSecret } from './redact.ts'

const R = '<redacted>'

test('looksSecret: known token prefixes and long high-entropy strings, not paths, packages or plain words', () => {
  for (const value of [
    'sk-live-SECRET1234567890',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_SECRET1234567',
    'github_pat_11ABCDEFG0123456789',
    'xoxb-1234-5678-abcdef',
    'AKIAIOSFODNN7EXAMPLE',
    'glpat-abcdefghij1234',
    'AIzaSyA1234567890abcdefgh',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
    'Qx7vP2mN9kL4rT8wZ3yB6cF1hJ5dG0sA'
  ]) {
    assert.equal(looksSecret(value), true, value)
  }
  for (const value of ['npx', '-y', '@upstash/context7-mcp@2.2.5', '/usr/local/lib/node_modules/some-very-long-package-name/dist/index.js', 'serve', 'sk-', 'skills', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '']) {
    assert.equal(looksSecret(value), false, value)
  }
})

test('redactArgs: values after secret flags, KEY=value with a secret name, and token-shaped words', () => {
  assert.deepEqual(redactArgs(['srv', '--api-key', 'sk-live-SECRET1234567890']), ['srv', '--api-key', R])
  assert.deepEqual(redactArgs(['--token', 'abc', '--key', 'k1', '-k', 'k2', '--password', 'p', '--secret', 's']), ['--token', R, '--key', R, '-k', R, '--password', R, '--secret', R])
  assert.deepEqual(redactArgs(['--auth-token', 'a', '--authorization', 'b', '--header', 'X-Key: v', '-H', 'Authorization: Bearer x']), ['--auth-token', R, '--authorization', R, '--header', R, '-H', R])
  assert.deepEqual(redactArgs(['--token=abc', 'API_KEY=xyz', 'MODE=fast']), [`--token=${R}`, `API_KEY=${R}`, 'MODE=fast'])
  assert.deepEqual(redactArgs(['run', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']), ['run', R])
  assert.deepEqual(redactArgs(['--url', 'https://x.io/mcp?token=abc123tok']), ['--url', `https://x.io/mcp?token=${R}`])
  // A flag after a secret flag is a flag, not its value.
  assert.deepEqual(redactArgs(['-y', '@upstash/context7-mcp@2.2.5', '--token', '--verbose']), ['-y', '@upstash/context7-mcp@2.2.5', '--token', '--verbose'])
})

test('argsHaveSecret: true exactly when redactArgs would hide something', () => {
  assert.equal(argsHaveSecret(['srv', '--api-key', 'sk-live-SECRET1234567890']), true)
  assert.equal(argsHaveSecret(['-y', '@upstash/context7-mcp@2.2.5']), false)
})

test('redactUrl: no user info, every query value hidden, no fragment; the rest kept', () => {
  assert.equal(redactUrl('https://x.io/mcp?token=abc123tok'), `https://x.io/mcp?token=${R}`)
  assert.equal(redactUrl('https://user:hunter2@example.com/sse'), 'https://example.com/sse')
  assert.equal(redactUrl('https://x.io/a?v=2&key=k#access_token=t'), `https://x.io/a?v=${R}&key=${R}`)
  assert.equal(redactUrl('https://mcp.context7.com/mcp'), 'https://mcp.context7.com/mcp')
  assert.equal(redactUrl('not a url?token=abc'), `not a url?${R}`)
})

test('urlHasSecret: user info, a secret-named query key or a token-shaped query value', () => {
  assert.equal(urlHasSecret('https://x.io/mcp?token=abc123tok'), true)
  assert.equal(urlHasSecret('https://user:pw@x.io/'), true)
  assert.equal(urlHasSecret('https://x.io/?q=sk-live-SECRET1234567890'), true)
  assert.equal(urlHasSecret('https://x.io/mcp?version=2'), false)
  assert.equal(urlHasSecret('https://x.io'), false)
})

test('redactCommand: Bearer, Authorization headers, KEY=value, secret flags and URLs in a shell command', () => {
  const curl = redactCommand(`curl -H 'Authorization: Bearer hunter2' https://x.io/hook`)
  assert.doesNotMatch(curl, /hunter2/)
  assert.match(curl, /^curl -H 'Authorization: <redacted>' https:\/\/x\.io\/hook$/)
  assert.equal(redactCommand('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 notify'), `GITHUB_TOKEN=${R} notify`)
  assert.equal(redactCommand('tool --api-key  sk-live-SECRET1234567890 run'), `tool --api-key  ${R} run`)
  assert.equal(redactCommand('tool --key x -k y'), `tool --key ${R} -k ${R}`)
  assert.equal(redactCommand('wget "https://x.io/a?token=abc123tok"'), `wget "https://x.io/a?token=${R}"`)
  assert.equal(redactCommand('send Bearer abc.def'), `send Bearer ${R}`)
  assert.equal(redactCommand('npm run lint && echo done'), 'npm run lint && echo done')
})
