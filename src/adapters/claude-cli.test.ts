import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeCli, findClaude } from './claude-cli.ts'

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
