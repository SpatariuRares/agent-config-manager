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

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX'
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/abcDEF1234ghiJKL5678mnoPQR9012stuVWX3456yzAB-cd_EF'

test('redactUrl: a token in the path (a webhook URL) is hidden; ordinary path words stay readable', () => {
  assert.equal(redactUrl(SLACK), `https://hooks.slack.com/services/T000/B000/${R}`)
  assert.equal(redactUrl(DISCORD), `https://discord.com/api/webhooks/123456789012345678/${R}`)
  assert.equal(redactUrl(`${SLACK}?x=1`), `https://hooks.slack.com/services/T000/B000/${R}?x=${R}`)
  for (const url of ['https://x.io/mcp', 'https://x.io/v1/sse', 'https://x.io/api/mcp', 'https://x.io/.well-known/oauth-authorization-server']) {
    assert.equal(redactUrl(url), url)
  }
})

test('urlHasSecret: a token in the path counts; ordinary path words do not', () => {
  assert.equal(urlHasSecret(SLACK), true)
  assert.equal(urlHasSecret(DISCORD), true)
  for (const url of ['https://x.io/mcp', 'https://x.io/v1/sse', 'https://x.io/api/mcp', 'https://mcp.context7.com/mcp']) assert.equal(urlHasSecret(url), false, url)
})

test('a webhook URL in args or in a hook command is redacted, and counts as a secret', () => {
  assert.deepEqual(redactArgs(['--url', SLACK]), ['--url', `https://hooks.slack.com/services/T000/B000/${R}`])
  assert.equal(argsHaveSecret(['notify', DISCORD]), true)
  assert.equal(redactCommand(`curl -X POST ${SLACK}`), `curl -X POST https://hooks.slack.com/services/T000/B000/${R}`)
})

// ---------- A secret inside a longer value: every word of it is checked, not only the first.

const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const SK = 'sk-live-0123456789abcdef'

test('a secret inside a longer value is found and redacted: after a scheme, a word, a ${VAR}, a path or in JSON', () => {
  for (const [name, value] of [
    ['--header', `Authorization: Bearer ${GHP}`],
    ['GH_CONFIG', `token ${GHP}`],
    ['T', `\${X}${GHP}`],
    ['T', `${SK}\${X}`],
    ['CFG', `\${HOME}/${GHP}`],
    ['CREDS', `{"token":"${GHP}"}`],
    ['X-Custom', `token ${GHP}`]
  ]) {
    const word = `${name}=${value}`
    assert.equal(argsHaveSecret([word]), true, word)
    const [shown] = redactArgs([word])
    assert.doesNotMatch(shown, /ghp_|sk-live/, shown)
    assert.match(shown, /<redacted>/, shown)
  }
})

test('a secret inside a longer word without a name is found too, and the rest stays readable', () => {
  assert.equal(argsHaveSecret([`token ${GHP}`]), true)
  assert.deepEqual(redactArgs(['mcp-remote', `--header=Authorization: Bearer ${GHP}`]), ['mcp-remote', `--header=Authorization: ${R}`])
  assert.deepEqual(redactArgs([`--opts=mode fast ${SK}`]), [`--opts=mode fast ${R}`])
  assert.deepEqual(redactArgs([`--config={"token":"${GHP}","port":8080}`]), [`--config={"token":"${R}","port":8080}`])
})

test('Bearer or Basic followed by any token is a secret; followed by a ${VAR} reference it is not', () => {
  assert.equal(argsHaveSecret(['--header=Authorization: Bearer hunter2']), true)
  assert.equal(argsHaveSecret(['--header=X-Auth: Basic dXNlcjpwYXNz']), true)
  assert.deepEqual(redactArgs(['--header=X-Auth: Basic dXNlcjpwYXNz']), [`--header=X-Auth: Basic ${R}`])
  assert.equal(argsHaveSecret(['--header=Authorization: Bearer ${TOKEN}']), false)
  assert.equal(argsHaveSecret(['H=Bearer ${TOKEN}']), false)
})

test('a JSON value with a secret-named key holding a literal counts; a ${VAR} reference there does not', () => {
  assert.equal(argsHaveSecret(['CREDS={"password":"hunter2"}']), true)
  assert.equal(argsHaveSecret(['CREDS={"password":"${PASSWORD}","user":"me"}']), false)
})

test('harmless values stay readable and allowed: paths, ports, plain words, ${VAR} paths', () => {
  const harmless = ['/mcp', '--port=8080', 'node server.js', '${HOME}/bin', 'HOME=${HOME}/bin', 'serve', 'LOG=info', '-y', '@upstash/context7-mcp@2.2.5', 'https://api.example/mcp', '--config={"port":8080}', 'MODE=read only']
  for (const word of harmless) assert.equal(argsHaveSecret([word]), false, word)
  assert.deepEqual(redactArgs(harmless), harmless)
  assert.equal(redactCommand('node server.js --port=8080 ${HOME}/bin'), 'node server.js --port=8080 ${HOME}/bin')
})
