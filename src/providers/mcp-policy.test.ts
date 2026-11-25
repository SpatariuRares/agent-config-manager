// The MCP server policy module, through its interface only: one table of config x destination -> outcome.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admitMcp, commandLine, describeMcp, privateFile, teamFile, type Carries, type Destination, type McpConfig } from './mcp-policy.ts'

const SK = 'sk-live-0123456789abcdef'
const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
/** Values no refusal message may ever contain. */
const VALUES = [SK, GHP, 'abc123secret', 'hunter2']

const ALL: Carries = { transports: ['stdio', 'http', 'sse'], fields: ['args', 'env', 'headers'] }
const ARGV = commandLine('`some add`', { team: false, carries: ALL })
const ARGV_TEAM = commandLine('`some add`', { team: true, carries: ALL, hint: 'Or choose only me.' })
const ARGV_KEEPS = commandLine('`keeper add`', { team: false, carries: { ...ALL, keeps: (key) => key === 'description' } })
const NARROW = commandLine('`narrow add`', { team: false, carries: { transports: ['stdio'], fields: ['args'] } })
const TEAM = teamFile('a project file', ALL)
const PRIVATE = privateFile('a user file', ALL)
const KEEPS = privateFile('a keeper file', { ...ALL, keeps: (key, value) => key === 'timeout' && typeof value === 'number' })

const stdio = (fields: Partial<McpConfig> = {}): McpConfig => ({ name: 's', transport: 'stdio', command: 'npx', ...fields })
const http = (fields: Partial<McpConfig> = {}): McpConfig => ({ name: 's', transport: 'http', url: 'https://api.example/mcp', ...fields })
/** A config whose env and headers throw when read: describeMcp must never touch them. */
function sealed(config: McpConfig): McpConfig {
  const copy = { ...config }
  for (const field of ['env', 'headers'] as const) {
    Object.defineProperty(copy, field, { enumerable: true, get: () => assert.fail(`describeMcp read ${field}`) })
  }
  return copy
}

type Expected = 'ok' | { reason: 'not-portable' | 'secret'; paths: string[] } | { shows: { transport: string; target: string } }
type Row = [string, McpConfig, Destination | 'describe', Expected]

const refused = (reason: 'not-portable' | 'secret', ...paths: string[]) => ({ reason, paths })

const ROWS: Row[] = [
  // 1. Reference: `${VAR}` and no secret anywhere in the value.
  ['${TOKEN} is a reference, fit for a team file', stdio({ env: { TOKEN: '${TOKEN}' } }), TEAM, 'ok'],
  ['Bearer ${TOKEN} is a reference, fit for a team file', http({ headers: { Authorization: 'Bearer ${TOKEN}' } }), TEAM, 'ok'],
  ['sk-live-...$x is a literal (no ${VAR})', stdio({ env: { TOKEN: `${SK}$x` } }), TEAM, refused('secret', 'env.TOKEN')],
  ['${A}sk-live-... is a literal (a secret next to the reference)', stdio({ env: { K: `\${A}${SK}` } }), TEAM, refused('secret', 'env.K')],
  ['$x is a literal (not ${VAR})', stdio({ env: { LOG: '$x' } }), TEAM, refused('secret', 'env.LOG')],
  ['${HOME}/ghp_... is a literal', stdio({ env: { CFG: `\${HOME}/${GHP}` } }), ARGV, refused('secret', 'env.CFG')],
  // 2. Team file: every env and header value is a reference, harmless or not.
  ['a team file refuses a harmless literal env value', stdio({ env: { LOG: 'info', TOKEN: '${TOKEN}' } }), TEAM, refused('secret', 'env.LOG')],
  ['a team file refuses a literal header', http({ headers: { 'X-Region': 'eu', Authorization: 'Bearer ${TOKEN}' } }), TEAM, refused('secret', 'headers.X-Region')],
  ['a team command line refuses literal env too', stdio({ env: { LOG: 'info' } }), ARGV_TEAM, refused('secret', 'env.LOG')],
  // 3. Command line or team file: nothing secret in command, args, url or a kept rest value.
  ['a team file refuses a token after --api-key', stdio({ args: ['server', '--api-key', 'hunter2'] }), TEAM, refused('secret', 'args[2]')],
  ['a command line refuses a token-shaped arg', stdio({ args: ['server', GHP] }), ARGV, refused('secret', 'args[1]')],
  ['a command line refuses a token-shaped command', stdio({ command: GHP }), ARGV, refused('secret', 'command')],
  ['a command line refuses a token in a --header arg', stdio({ args: ['mcp-remote', 'https://api.example/mcp', `--header=Authorization: Bearer ${GHP}`] }), ARGV, refused('secret', 'args[2]')],
  ['a command line refuses a url with a secret query', http({ url: 'https://api.example/mcp?api_key=abc123secret' }), ARGV, refused('secret', 'url')],
  ['a team file refuses a url with user info', http({ url: 'https://me:hunter2@api.example/mcp' }), TEAM, refused('secret', 'url')],
  ['a command line refuses a secret in a kept rest value', stdio({ rest: { description: `use ${GHP}` } }), ARGV_KEEPS, refused('secret', 'rest.description')],
  ['a harmless url arg with a query passes a command line', stdio({ args: ['--endpoint', 'https://api.example/mcp?region=eu', '/mcp', '--port=8080', 'node server.js', '${HOME}/bin'] }), ARGV, 'ok'],
  // 4. Command line: no env or header value looks secret.
  ['a command line refuses a literal under a secret name', stdio({ env: { TOKEN: `${SK}$x` } }), ARGV, refused('secret', 'env.TOKEN')],
  ['a command line refuses a bearer token header', http({ headers: { Authorization: 'Bearer abc123secret' } }), ARGV, refused('secret', 'headers.Authorization')],
  ['a command line refuses a token inside a longer env value', stdio({ env: { GH_CONFIG: `token ${GHP}` } }), ARGV, refused('secret', 'env.GH_CONFIG')],
  ['a command line refuses ${X}ghp_...', stdio({ env: { T: `\${X}${GHP}` } }), ARGV, refused('secret', 'env.T')],
  ['a command line refuses sk-live-...${X}', stdio({ env: { T: `${SK}\${X}` } }), ARGV, refused('secret', 'env.T')],
  ['a command line refuses a token inside JSON', stdio({ env: { CREDS: `{"token":"${GHP}"}` } }), ARGV, refused('secret', 'env.CREDS')],
  ['a command line refuses a token inside a longer header', http({ headers: { 'X-Custom': `token ${GHP}` } }), ARGV, refused('secret', 'headers.X-Custom')],
  ['a command line takes references and harmless literals', stdio({ env: { LOG: 'info', X: '$x', BIN: '${HOME}/bin', TOKEN: '${TOKEN}', AUTH: 'Bearer ${TOKEN}' } }), ARGV, 'ok'],
  // 5. Private file without argv: literals stay.
  ['a private file keeps literal secrets', stdio({ args: ['--api-key', 'hunter2'], env: { API_KEY: SK, T: `${SK}$x` } }), PRIVATE, 'ok'],
  ['a private file keeps a literal header', http({ url: 'https://api.example/mcp?api_key=abc123secret', headers: { Authorization: 'Bearer abc123secret' } }), PRIVATE, 'ok'],
  // 6. Check order: shape, then carry, then secret; all paths of the first failing class.
  ['shape comes before carry', http({ env: { A: 1 } }), NARROW, refused('not-portable', 'env.A')],
  ['carry comes before secret', http({ headers: { Authorization: 'Bearer abc123secret' } }), NARROW, refused('not-portable', 'transport', 'headers')],
  ['carry comes before secret, for env too', stdio({ env: { TOKEN: SK } }), NARROW, refused('not-portable', 'env')],
  ['every path of the failing class', stdio({ args: ['--token', 'hunter2', GHP], env: { API_KEY: SK, LOG: 'info' } }), ARGV, refused('secret', 'args[1]', 'args[2]', 'env.API_KEY')],
  ['literal and secret paths of one team refusal', stdio({ args: ['--token', 'hunter2'], env: { LOG: 'info' } }), ARGV_TEAM, refused('secret', 'env.LOG', 'args[1]')],
  // Shape: malformed fields.
  ['a stdio server without a command', stdio({ command: undefined }), PRIVATE, refused('not-portable', 'command')],
  ['an http server without a url', http({ url: '' }), PRIVATE, refused('not-portable', 'url')],
  ['args that are not all text', stdio({ args: ['a', 3] }), PRIVATE, refused('not-portable', 'args[1]')],
  ['args that are not a list', stdio({ args: 'a b' }), PRIVATE, refused('not-portable', 'args')],
  ['env that is not an object', stdio({ env: 'A=b' }), PRIVATE, refused('not-portable', 'env')],
  ['a header that is not text', http({ headers: { A: 1 } }), PRIVATE, refused('not-portable', 'headers.A')],
  // Carry: transports, fields, fields of the other transport, rest keys.
  ['a transport no destination has', { name: 's', transport: 'websocket', url: 'ws://x.example' }, PRIVATE, refused('not-portable', 'transport')],
  ['a transport this destination lacks', http(), NARROW, refused('not-portable', 'transport')],
  ['a field this destination lacks', stdio({ env: { LOG: 'info' } }), NARROW, refused('not-portable', 'env')],
  ['url and headers on a stdio server', stdio({ url: 'https://x.example', headers: { A: 'b' } }), PRIVATE, refused('not-portable', 'url', 'headers')],
  ['command and env on an http server', http({ command: 'npx', env: { A: 'b' } }), PRIVATE, refused('not-portable', 'command', 'env')],
  ['an unknown rest key without keeps', stdio({ rest: { cwd: '/srv' } }), PRIVATE, refused('not-portable', 'rest.cwd')],
  ['a rest key keeps refuses', stdio({ rest: { timeout: '5', cwd: '/srv' } }), KEEPS, refused('not-portable', 'rest.timeout', 'rest.cwd')],
  ['a rest key keeps accepts', stdio({ rest: { timeout: 5 } }), KEEPS, 'ok'],
  ['empty args and env are absent', stdio({ args: [], env: {} }), NARROW, 'ok'],
  // 8. Description: never env or headers; target from redactUrl / redactArgs.
  ['describe a stdio server', sealed(stdio({ args: ['server', '--api-key', 'hunter2'], env: { API_KEY: SK } })), 'describe', { shows: { transport: 'stdio', target: 'npx server --api-key <redacted>' } }],
  ['describe an http server', sealed(http({ url: 'https://api.example/mcp?api_key=abc123secret', headers: { A: 'b' } })), 'describe', { shows: { transport: 'http', target: 'https://api.example/mcp?api_key=<redacted>' } }]
]

/** A token followed by characters a token cannot hold: the word still starts with a credential. */
const TAILED = [`${SK}$x`, `${GHP}!`, `${GHP}#frag`, `x#${GHP}`]

test('a token followed by $, !, # (or after one) is refused by every command line and team file, kept by a private file', () => {
  for (const to of [ARGV, ARGV_TEAM, TEAM, PRIVATE]) {
    for (const value of TAILED) {
      const cases: [McpConfig, string][] = [
        [stdio({ args: ['server', value] }), 'args[1]'],
        [stdio({ args: ['server', `FOO=${value}`] }), 'args[1]'],
        [stdio({ command: value }), 'command'],
        [stdio({ env: { CFG: value } }), 'env.CFG'],
        [http({ headers: { 'X-Region': value } }), 'headers.X-Region'],
        [http({ url: `https://api.example/mcp#${value}` }), 'url']
      ]
      for (const [config, path] of cases) {
        const admitted = admitMcp(config, to)
        const label = `${to.label} (team: ${to.team}) ${path} = ${value}`
        if (to === PRIVATE) {
          assert.equal(admitted.ok, true, label)
          continue
        }
        assert.equal(admitted.ok, false, `${label}: admitted`)
        if (admitted.ok) continue
        assert.equal(admitted.reason, 'secret', `${label}: ${admitted.message}`)
        assert.match(admitted.message, new RegExp(`[(, ]${path.replace(/[[\].]/g, '\\$&')}[,)]`), `${label}: ${admitted.message}`)
        assert.ok(!admitted.message.includes(value), `${label}: the message shows the value`)
      }
    }
  }
})

test('under a secret-named key, a value with a literal next to its reference is not a reference', () => {
  for (const to of [ARGV, ARGV_TEAM, TEAM]) {
    for (const [key, value] of [['TOKEN', '${A}hunter2'], ['API_KEY', 'hunter2${A}'], ['PASSWORD', 'pre-${A}'], ['MY_SECRET', '${A}:x'], ['AUTH', '${A}${B}z']]) {
      const admitted = admitMcp(stdio({ env: { [key]: value } }), to)
      assert.equal(admitted.ok, false, `${to.label} (team: ${to.team}) env.${key} = ${value}: admitted`)
      assert.ok(!admitted.ok && admitted.reason === 'secret' && admitted.message.includes(`env.${key}`) && !admitted.message.includes('hunter2'), `${to.label}: ${!admitted.ok && admitted.message}`)
    }
    const headers = admitMcp(http({ headers: { Authorization: '${A}hunter2' } }), to)
    assert.equal(headers.ok, false, `${to.label}: a header with a literal tail was admitted`)
  }
  // References only, an auth scheme with a reference, and a reference with a path under a harmless name stay fine.
  for (const to of [ARGV, ARGV_TEAM, TEAM]) {
    const ok = admitMcp(stdio({ env: { TOKEN: '${TOKEN}', API_KEY: '${A}${B}', HOME_DIR: '${HOME}/bin' } }), to)
    assert.equal(ok.ok, true, `${to.label}: ${!ok.ok && ok.message}`)
    const bearer = admitMcp(http({ headers: { Authorization: 'Bearer ${TOKEN}', 'X-Api-Key': '${KEY}' } }), to)
    assert.equal(bearer.ok, true, `${to.label}: ${!bearer.ok && bearer.message}`)
  }
})

test('MCP server policy: config x destination -> outcome, with field paths and never values', () => {
  for (const [label, config, to, expected] of ROWS) {
    if (to === 'describe') {
      assert.deepEqual(describeMcp(config), (expected as { shows: unknown }).shows, label)
      continue
    }
    const admitted = admitMcp(config, to)
    if (expected === 'ok') {
      assert.equal(admitted.ok, true, `${label}: ${admitted.ok ? '' : admitted.message}`)
      continue
    }
    const { reason, paths } = expected as { reason: string; paths: string[] }
    assert.equal(admitted.ok, false, `${label}: admitted`)
    if (admitted.ok) continue
    assert.equal(admitted.reason, reason, `${label}: ${admitted.message}`)
    // Field paths are listed in parentheses; a hint carries none in this table.
    const listed = [...admitted.message.matchAll(/\(([^)]*)\)/g)].flatMap(([, list]) => list.split(', '))
    assert.deepEqual(listed.sort(), [...paths].sort(), `${label}: ${admitted.message}`)
    assert.ok(admitted.message.startsWith(`"${config.name}" `), `${label}: names the server`)
    for (const value of VALUES) assert.ok(!admitted.message.includes(value), `${label}: the message shows a value`)
    if (to.hint) assert.ok(admitted.message.includes(to.hint), `${label}: the hint`)
  }

  // An admitted server carries what the destination takes, empty fields dropped, kept rest values kept.
  assert.deepEqual(admitMcp(stdio({ args: ['a'], env: { A: '${A}' }, headers: {}, rest: { timeout: 5 } }), KEEPS), {
    ok: true,
    server: { kind: 'mcp', name: 's', transport: 'stdio', command: 'npx', args: ['a'], env: { A: '${A}' }, rest: { timeout: 5 } }
  })
  assert.deepEqual(admitMcp(http({ args: [], headers: { A: '${A}' } }), TEAM), {
    ok: true,
    server: { kind: 'mcp', name: 's', transport: 'http', url: 'https://api.example/mcp', headers: { A: '${A}' }, rest: {} }
  })
})
