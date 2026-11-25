// The CommandRunner over real binaries: stand-in scripts in a mkdtemp folder, never a real agent CLI.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { findCommand, nodeCommandRunner } from './node-exec.ts'

const scratch = await mkdtemp(join(tmpdir(), 'acm-exec-'))
after(() => rm(scratch, { recursive: true, force: true }))

// A stand-in CLI in its own folder: it echoes its arguments, cwd and the first PATH entry, and fails for "broken".
const bin = join(scratch, 'bin')
await mkdir(bin)
const tool = join(bin, 'tool')
await writeFile(tool, '#!/bin/sh\necho "tool $* @ $(pwd -P) path=${PATH%%:*}"\ncase "$*" in *broken*) echo "nope" >&2; exit 1;; esac\n')
await chmod(tool, 0o755)
const runner = nodeCommandRunner((name) => findCommand(name, bin))

test('runs a command found by name with its argv in the given folder, its folder first on PATH', async () => {
  const result = await runner.run('tool', ['plugin', 'uninstall', 'a@m', '--scope', 'project'], scratch)
  assert.deepEqual(result, { ok: true, output: `tool plugin uninstall a@m --scope project @ ${await realpath(scratch)} path=${bin}` })
})

test('passes every argument as is, never through a shell', async () => {
  const result = await runner.run('tool', ['$(echo hi)', 'a b', ';', '*'], scratch)
  assert.match(result.output, /^tool \$\(echo hi\) a b ; \* @ /)
})

test('reports a failing exit code with its output', async () => {
  const result = await runner.run('tool', ['broken'], null)
  assert.equal(result.ok, false)
  assert.match(result.output, /nope/)
})

test('an absolute path runs as is; a command not found is reported instead of thrown', async () => {
  assert.equal((await nodeCommandRunner(async () => null).run(tool, ['x'], scratch)).ok, true)
  assert.deepEqual(await nodeCommandRunner(async () => null).run('npx', ['-y'], null), { ok: false, output: 'The npx command was not found.' })
})

test('finds a command on PATH, and null when there is none', async () => {
  assert.equal(await findCommand('tool', bin), tool)
  assert.equal(await findCommand('no-such-command-here', bin), null)
  assert.equal(await runner.find('tool'), tool)
})

test('closeStdin gives the program an empty, closed stdin, so a prompt ends at once instead of at the timeout', async () => {
  // A stand-in for a CLI that asks a question on stdin: `read` returns at end of input and prints "eof".
  const asks = join(scratch, 'asks')
  await writeFile(asks, '#!/bin/sh\nprintf "Continue? [Y/n]: "\nif read answer; then echo "answer:$answer"; else echo eof; fi\n')
  await chmod(asks, 0o755)
  const plain = nodeCommandRunner(async () => null)
  assert.deepEqual(await plain.run(asks, [], scratch, { timeoutMs: 10_000, closeStdin: true }), { ok: true, output: 'Continue? [Y/n]: eof' })
  // Without it the question waits for an answer that never comes, until the timeout.
  const waiting = await plain.run(asks, [], scratch, { timeoutMs: 300 })
  assert.equal(waiting.ok, false)
})
