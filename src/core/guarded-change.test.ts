// The guarded change module through its interface, over fakeFs and fakeExec: version check, backups, the effect,
// the post-condition, and the one wording of each refusal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BackupStore } from './backups.ts'
import { guardedChange, restoreOf, versionRefusal, type Change, type ChangeDeps } from './guarded-change.ts'
import { versionOf } from './json.ts'
import type { CliResult } from './ports.ts'
import { fakeExec, fakeFs } from './test-support.ts'

const STORE: BackupStore = { dir: '/b' }
const STAMP = '2026-11-24T10-00-00-000Z'
const A = '/home/.agent/a.json'
const B = '/home/.agent/b.json'
const backupOf = (file: string) => `/b/${encodeURIComponent(file)}.${STAMP}.json`
const say = (path: string) => path.replace('/home/', '~/')

function machine(files: Record<string, string>, reply?: (command: string, argv: readonly string[]) => CliResult) {
  const fs = fakeFs(files)
  const exec = fakeExec({ commands: { agent: '/usr/bin/agent' }, reply })
  const deps: ChangeDeps = { fs, exec, store: STORE, clock: () => new Date('2026-11-24T10:00:00.000Z'), say }
  return { fs, exec, deps }
}

const versions = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([file, text]) => [file, versionOf(text)]))
const refusal = (result: Awaited<ReturnType<typeof guardedChange>>) => {
  assert.equal(result.ok, false)
  return result as Extract<typeof result, { ok: false }>
}

test('a JSON edit is version checked, backed up first, written as 2-space JSON, and offers a restore undo', async () => {
  const files = { [A]: '{"x":1}' }
  const { fs, deps } = machine(files)
  const result = await guardedChange(deps, { files: [A], versions: versions(files), steps: [{ effect: { kind: 'json', file: A, edit: (json) => void (json.y = 2) } }] })
  assert.ok(result.ok)
  assert.equal(fs.files[A], '{\n  "x": 1,\n  "y": 2\n}\n')
  assert.equal(fs.files[backupOf(A)], '{"x":1}')
  assert.equal(result.backups.get(A), backupOf(A))
  assert.deepEqual(result.restore(A), { type: 'restore', name: `${encodeURIComponent(A)}.${STAMP}.json` })
})

test('a stale view is refused as changed, naming the file, and nothing is backed up or run', async () => {
  const { fs, exec, deps } = machine({ [A]: 'now', [B]: 'b' })
  const before = structuredClone(fs.files)
  const change: Change = {
    files: [B, A],
    versions: { [A]: versionOf('then'), [B]: versionOf('b') },
    steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'add', 'x'], cwd: null } }]
  }
  const stale = refusal(await guardedChange(deps, change))
  assert.equal(stale.reason, 'changed')
  assert.equal(stale.message, '~/.agent/a.json changed since it was read. Refresh and try again.')
  assert.deepEqual(fs.files, before)
  assert.deepEqual(exec.calls, [])
  assert.deepEqual(await versionRefusal(deps, [A], change.versions), stale)
  assert.equal(await versionRefusal(deps, [B], change.versions), null)
})

test('an unversioned file is not version checked, but is still backed up', async () => {
  const { fs, deps } = machine({ [A]: 'rewritten all the time' })
  const result = await guardedChange(deps, {
    files: [A],
    versions: {},
    unversioned: [A],
    steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'remove', 'x'], cwd: null } }]
  })
  assert.ok(result.ok)
  assert.equal(fs.files[backupOf(A)], 'rewritten all the time')
})

test('a JSON edit that refuses, or a file that is not a JSON object, writes and backs up nothing', async () => {
  const files = { [A]: '{"x":1}', [B]: '[1]' }
  const { fs, deps } = machine(files)
  const before = structuredClone(fs.files)
  const refused = refusal(await guardedChange(deps, { files: [A], versions: versions(files), steps: [{ effect: { kind: 'json', file: A, edit: () => 'x is taken.' } }] }))
  assert.deepEqual(refused, { ok: false, reason: 'refused', message: 'x is taken.' })
  const unreadable = refusal(await guardedChange(deps, { files: [B], versions: versions(files), steps: [{ effect: { kind: 'json', file: B, edit: () => undefined } }] }))
  assert.deepEqual(unreadable, { ok: false, reason: 'unreadable', message: '~/.agent/b.json is not a valid JSON object; it was left untouched.' })
  assert.deepEqual(fs.files, before)
})

test('a JSON edit that changes nothing writes nothing and has no undo', async () => {
  const files = { [A]: '{"x":1}' }
  const { fs, deps } = machine(files)
  const result = await guardedChange(deps, { files: [A], versions: versions(files), steps: [{ effect: { kind: 'json', file: A, edit: (json) => void (json.x = 1) } }] })
  assert.ok(result.ok)
  assert.equal(result.backups.size, 0)
  assert.equal(result.restore(A), undefined)
  assert.deepEqual(Object.keys(fs.files), [A])
})

test('a JSON edit creates a missing file from {}, backing up {} so the undo can empty it again', async () => {
  const { fs, deps } = machine({})
  const result = await guardedChange(deps, { files: [A], versions: {}, steps: [{ effect: { kind: 'json', file: A, edit: (json) => void (json.x = 1) } }] })
  assert.ok(result.ok)
  assert.equal(fs.files[A], '{\n  "x": 1\n}\n')
  assert.equal(fs.files[backupOf(A)], '{}\n')
})

test('a text effect replaces the file with the text as is', async () => {
  const files = { [A]: '// comments stay\n{}' }
  const { fs, deps } = machine(files)
  const result = await guardedChange(deps, { files: [A], versions: versions(files), steps: [{ effect: { kind: 'text', file: A, text: '// old\n{"y":1}' } }] })
  assert.ok(result.ok)
  assert.equal(fs.files[A], '// old\n{"y":1}')
  assert.equal(fs.files[backupOf(A)], '// comments stay\n{}')
})

test('a CLI effect runs by argv with its options, after every file that exists is backed up', async () => {
  const files = { [A]: 'a' }
  const seen: unknown[] = []
  const { fs, exec, deps } = machine(files)
  const run = exec.run.bind(exec)
  exec.run = async (command, argv, cwd, options) => {
    seen.push({ backedUp: backupOf(A) in fs.files, options })
    return run(command, argv, cwd, options)
  }
  const result = await guardedChange(deps, {
    files: [A, B],
    versions: versions(files),
    steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['ext', 'update', 'x'], cwd: '/work', options: { closeStdin: true, timeoutMs: 5 } } }]
  })
  assert.ok(result.ok)
  assert.deepEqual(exec.calls, ['agent ext update x @ /work'])
  assert.deepEqual(seen, [{ backedUp: true, options: { closeStdin: true, timeoutMs: 5 } }])
  assert.deepEqual([...result.backups.keys()], [A])
})

test('a failing CLI is cli-failed, with its output redacted and never its argv values', async () => {
  const files = { [A]: 'a' }
  const { deps } = machine(files, () => ({ ok: false, output: 'line 1\nboom\nAuthorization: Bearer abc123secret' }))
  const result = refusal(
    await guardedChange(deps, {
      files: [A],
      versions: versions(files),
      steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'add', 'x', '--token', 'sk-live-0123456789abcdef'], cwd: null }, about: 'x', hint: 'Run it in a terminal.' }]
    })
  )
  assert.equal(result.reason, 'cli-failed')
  assert.equal(result.message, 'agent mcp add for x failed: line 1 boom Authorization: <redacted>. Run it in a terminal.')
  assert.ok(result.ok === false && result.reason === 'cli-failed' && result.output.includes('boom') && !result.output.includes('abc123secret'))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, reason: 'cli-failed', message: result.message }, 'the output never reaches the panel')
  assert.doesNotMatch(result.message, /sk-live/)
})

test('a CLI that exits 0 but did not change the file is did-not-change, by the post-condition', async () => {
  const files = { [A]: '{}' }
  const { deps } = machine(files, () => ({ ok: true, output: 'Error: no such server' }))
  const result = refusal(
    await guardedChange(deps, {
      files: [A],
      versions: versions(files),
      steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'add', 'x'], cwd: null }, about: 'x', check: { file: A, holds: async (fs) => (await fs.readText(A)) !== '{}' } }]
    })
  )
  assert.deepEqual(result, {
    ok: false,
    reason: 'did-not-change',
    message: 'agent mcp add for x exited without an error, but ~/.agent/a.json does not show the change: Error: no such server.'
  })
})

test('a post-condition that holds passes the CLI output back', async () => {
  const files = { [A]: '{}' }
  const { deps } = machine(files, () => ({ ok: true, output: 'added' }))
  const result = await guardedChange(deps, {
    files: [A],
    versions: versions(files),
    steps: [{ effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'add', 'x'], cwd: null }, check: { file: A, holds: async () => true } }]
  })
  assert.ok(result.ok)
  assert.equal(result.output, 'added')
})

test('when the second step fails, the change is partial and names the backups that put it back', async () => {
  const files = { [A]: 'a', [B]: 'b' }
  const { deps, exec } = machine(files, (_command, argv) => (argv[1] === 'remove' ? { ok: false, output: 'locked' } : { ok: true, output: '' }))
  const result = refusal(
    await guardedChange(deps, {
      files: [A, B],
      versions: versions(files),
      steps: [
        { effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'add', 'x'], cwd: null }, about: 'x' },
        { effect: { kind: 'cli', command: 'agent', argv: ['mcp', 'remove', 'x'], cwd: null }, about: 'x' }
      ]
    })
  )
  assert.deepEqual(exec.calls, ['agent mcp add x @ -', 'agent mcp remove x @ -'])
  assert.equal(result.reason, 'partial')
  assert.equal(
    result.message,
    `agent mcp add for x worked; then agent mcp remove for x failed: locked. The backups made first can put the files back: ${encodeURIComponent(A)}.${STAMP}.json, ${encodeURIComponent(B)}.${STAMP}.json.`
  )
})

test('a second JSON step that refuses is partial too, and the first edit stays', async () => {
  const files = { [A]: '{}', [B]: '{}' }
  const { fs, deps } = machine(files)
  const result = refusal(
    await guardedChange(deps, {
      files: [A, B],
      versions: versions(files),
      steps: [
        { effect: { kind: 'json', file: A, edit: (json) => void (json.x = 1) } },
        { effect: { kind: 'json', file: B, edit: () => 'x is no longer there.' } }
      ]
    })
  )
  assert.equal(result.reason, 'partial')
  assert.match(result.message, /^the edit of ~\/\.agent\/a\.json worked; then the edit of ~\/\.agent\/b\.json was refused: x is no longer there\. /)
  assert.equal(JSON.parse(fs.files[A]).x, 1)
})

test('restoreOf names a backup by its file name, and nothing without one', () => {
  assert.deepEqual(restoreOf('/b/x.json'), { type: 'restore', name: 'x.json' })
  assert.equal(restoreOf(undefined), undefined)
  assert.equal(restoreOf(null), undefined)
})
