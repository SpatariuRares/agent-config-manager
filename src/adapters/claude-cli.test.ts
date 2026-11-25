import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeCli, findClaude, nodeCommandRunner } from './claude-cli.ts'

const scratch = await mkdtemp(join(tmpdir(), 'ccm-cli-'))
after(() => rm(scratch, { recursive: true, force: true }))

// A stand-in `claude` that echoes its arguments and cwd, and fails for the scope "broken".
const fake = join(scratch, 'claude')
await writeFile(
  fake,
  '#!/bin/sh\necho "$* @ $(pwd -P)"\ncase "$*" in *"--scope broken"*) echo "nope" >&2; exit 1;; esac\n'
)
await chmod(fake, 0o755)

test('runs claude plugin uninstall with scope, keep-data and json, in the given folder', async () => {
  const cli = claudeCli(async () => fake)
  const { realpath } = await import('node:fs/promises')
  const result = await cli.uninstall('a@m', 'project', scratch)
  assert.deepEqual(result, {
    ok: true,
    output: `plugin uninstall a@m --scope project --keep-data --json @ ${await realpath(scratch)}`
  })
})

test('reports a failing exit code with its output', async () => {
  const result = await claudeCli(async () => fake).uninstall('a@m', 'broken', null)
  assert.equal(result.ok, false)
  assert.match(result.output, /nope/)
})

test('finds claude on PATH, and reports a missing binary instead of throwing', async () => {
  assert.equal(await findClaude(scratch), fake)
  const result = await claudeCli(async () => null).uninstall('a@m', 'user', null)
  assert.deepEqual(result, { ok: false, output: 'The claude command was not found.' })
})

test('adds an MCP server with add-json and the scope, in the given folder', async () => {
  const { realpath } = await import('node:fs/promises')
  const result = await claudeCli(async () => fake).mcpAdd('db', '{"command":"x"}', 'local', scratch)
  assert.deepEqual(result, {
    ok: true,
    output: `mcp add-json db {"command":"x"} --scope local @ ${await realpath(scratch)}`
  })
})

test('removes an MCP server with the scope, and reports failures', async () => {
  const cli = claudeCli(async () => fake)
  const { realpath } = await import('node:fs/promises')
  assert.deepEqual(await cli.mcpRemove('db', 'project', scratch), {
    ok: true,
    output: `mcp remove db --scope project @ ${await realpath(scratch)}`
  })
  assert.equal((await cli.mcpRemove('db', 'broken', null)).ok, false)
  assert.deepEqual(await claudeCli(async () => null).mcpRemove('db', 'user', null), {
    ok: false,
    output: 'The claude command was not found.'
  })
})

test('an MCP name that looks like an option is refused before running claude', async () => {
  const cli = claudeCli(async () => fake)
  for (const result of [await cli.mcpAdd('-h', '{}', 'local', null), await cli.mcpRemove('--scope', 'local', null)]) {
    assert.equal(result.ok, false)
    assert.match(result.output, /cannot start with "-"/)
  }
})

// Stand-ins for npx and git in their own folder: they echo their arguments, cwd and the first PATH entry.
const tools = join(scratch, 'tools')
await import('node:fs/promises').then(({ mkdir }) => mkdir(tools))
for (const name of ['npx', 'git']) {
  await writeFile(join(tools, name), `#!/bin/sh\necho "${name} $* @ $(pwd -P) path=\${PATH%%:*}"\n`)
  await chmod(join(tools, name), 0o755)
}
const withTools = () => claudeCli(async () => fake, { npx: async () => join(tools, 'npx'), git: async () => join(tools, 'git') })

test('updates a plugin with scope and json in the install folder, never with -y', async () => {
  const { realpath } = await import('node:fs/promises')
  const result = await withTools().pluginUpdate('a@m', 'project', scratch)
  assert.deepEqual(result, { ok: true, output: `plugin update a@m --scope project --json @ ${await realpath(scratch)}` })
  assert.doesNotMatch(result.output, /(^| )-y( |$)|--yes/)
})

test('passes --accept-command only with the sha the user confirmed', async () => {
  const result = await withTools().pluginUpdate('a@m', 'user', null, 'abc123')
  assert.match(result.output, /^plugin update a@m --scope user --json --accept-command abc123 @ /)
  assert.doesNotMatch(result.output, /(^| )-y( |$)|--yes/)
})

test('refreshes the plugin marketplaces', async () => {
  assert.match((await withTools().marketplaceUpdate()).output, /^plugin marketplace update @ /)
})

test('updates a skill with npx skills, globally and without prompts, with npx\'s folder first on PATH', async () => {
  const result = await withTools().skillsUpdate('grill-me')
  assert.equal(result.ok, true)
  assert.match(result.output, new RegExp(`^npx -y skills update grill-me -g -y @ .* path=${tools}$`))
})

test('a skill name that looks like an option is refused before running npx', async () => {
  const result = await withTools().skillsUpdate('-g')
  assert.equal(result.ok, false)
  assert.match(result.output, /cannot start with "-"/)
})

test('runs git with its arguments in the given folder, and reports a missing npx or git', async () => {
  const { realpath } = await import('node:fs/promises')
  const result = await withTools().git(['rev-parse', 'HEAD'], scratch)
  assert.equal(result.output, `git rev-parse HEAD @ ${await realpath(scratch)} path=${tools}`)
  const missing = claudeCli(async () => fake, { npx: async () => null, git: async () => null })
  assert.deepEqual(await missing.skillsUpdate('x'), { ok: false, output: 'The npx command was not found.' })
  assert.deepEqual(await missing.git(['status'], scratch), { ok: false, output: 'The git command was not found.' })
})

test('finds any command on PATH the way it finds claude', async () => {
  const { findCommand } = await import('./claude-cli.ts')
  assert.equal(await findCommand('npx', tools), join(tools, 'npx'))
  assert.equal(await findCommand('no-such-command-here', tools), null)
})

test('closeStdin gives the program an empty, closed stdin, so a prompt ends at once instead of at the timeout', async () => {
  // A stand-in for a CLI that asks a question on stdin: `read` returns at end of input and prints "eof".
  const asks = join(scratch, 'asks')
  await writeFile(asks, '#!/bin/sh\nprintf "Continue? [Y/n]: "\nif read answer; then echo "answer:$answer"; else echo eof; fi\n')
  await chmod(asks, 0o755)
  const runner = nodeCommandRunner(async () => null)
  assert.deepEqual(await runner.run(asks, [], scratch, { timeoutMs: 10_000, closeStdin: true }), { ok: true, output: 'Continue? [Y/n]: eof' })
  // Without it the question waits for an answer that never comes, until the timeout.
  const waiting = await runner.run(asks, [], scratch, { timeoutMs: 300 })
  assert.equal(waiting.ok, false)
})
