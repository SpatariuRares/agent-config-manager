// Runs bin/agent-config.js as a user would, in a child process with a throwaway HOME.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', '..')
const bin = join(root, 'bin', 'agent-config.js')
const scratch = await mkdtemp(join(tmpdir(), 'acm-cli-bin-'))
after(() => rm(scratch, { recursive: true, force: true }))

function run(args: string[], home = scratch): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: scratch }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}

test('--help prints the usage with every subcommand and exits 0', async () => {
  const { code, stdout } = await run(['--help'])
  assert.equal(code, 0)
  for (const text of ['Usage: agent-config', 'start', '--port', '--no-open', 'install-commands', 'uninstall-commands', '--agent', '--dry-run', '--version']) {
    assert.ok(stdout.includes(text), `help mentions ${text}`)
  }
})

test('--version prints the package version', async () => {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
  const { code, stdout } = await run(['--version'])
  assert.equal(code, 0)
  assert.equal(stdout.trim(), version)
})

test('a bad argument prints the problem and a hint to --help, and exits 2', async () => {
  const { code, stderr } = await run(['frobnicate'])
  assert.equal(code, 2)
  assert.match(stderr, /Unknown command: frobnicate/)
  assert.match(stderr, /agent-config --help/)
})

test('install-commands writes into the HOME it runs with and reports each path', async () => {
  const home = join(scratch, 'home')
  await mkdir(join(home, '.gemini'), { recursive: true })
  const { code, stdout } = await run(['install-commands', '--agent', 'gemini'], home)
  assert.equal(code, 0)
  const path = join(home, '.gemini', 'commands', 'agent-config.toml')
  assert.match(stdout, /gemini/)
  assert.ok(stdout.includes(path))
  assert.match(await readFile(path, 'utf8'), /agent-config start/)
})

test('older Node gets a clear message naming the required and the running version', async () => {
  const check = pathToFileURL(join(root, 'bin', 'node-check.js')).href
  const script = `import { unsupportedNodeMessage as m } from ${JSON.stringify(check)}
console.log(JSON.stringify([m('20.11.1'), m('23.5.0'), m('23.6.0'), m('24.0.0'), m('25.6.0')]))`
  const output = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
  const [v20, v235, v236, v24, v25] = JSON.parse(output) as (string | null)[]
  assert.match(v20 ?? '', /agent-config needs Node\.js 23\.6 or newer; this is Node\.js 20\.11\.1\./)
  assert.match(v235 ?? '', /this is Node\.js 23\.5\.0/)
  assert.deepEqual([v236, v24, v25], [null, null, null])
})
