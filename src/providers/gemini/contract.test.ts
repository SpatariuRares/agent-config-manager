// Gemini CLI against the contract every provider must pass, plus its own info.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeFs } from '../../core/test-support.ts'
import { fakeExec, providerContract } from '../testing.ts'
import { GEMINI_SUPPORTS, geminiProvider } from './index.ts'
import { files, HOME, OLD_BACKUP, USER_SETTINGS } from './test-support.ts'

providerContract(geminiProvider(), {
  home: HOME,
  files: files(),
  // Every other write goes through the gemini CLI, which the contract's runner does not run; restore is the
  // one write this provider makes itself.
  write: {
    action: (view) => ({ type: 'restore', name: view.backups.find((backup) => backup.name === OLD_BACKUP)!.name }),
    file: USER_SETTINGS
  }
})

test('Gemini CLI info: id, name, config home, its five classes and what works', async () => {
  const info = await geminiProvider().info({ fs: fakeFs(files()), exec: fakeExec(), home: HOME })
  assert.equal(info.id, 'gemini')
  assert.equal(info.name, 'Gemini CLI')
  assert.equal(info.detected, true)
  assert.equal(info.configHome, '~/.gemini')
  assert.deepEqual(info.kinds, ['plugins', 'skills', 'agents', 'mcp', 'hooks'])
  assert.deepEqual(info.supports, GEMINI_SUPPORTS)
  assert.deepEqual(GEMINI_SUPPORTS, {
    plugins: ['setEnabled', 'uninstall', 'update', 'restore', 'snapshot'],
    mcp: ['move', 'remove', 'setEnabled', 'restore', 'snapshot']
  })
  assert.match(info.note ?? '', /read-only/)
})

test('Gemini CLI is detected from its binary on PATH alone, or from ~/.gemini alone', async () => {
  const onPath = await geminiProvider().info({ fs: fakeFs({}), exec: fakeExec({ commands: { gemini: '/usr/bin/gemini' } }), home: HOME })
  assert.equal(onPath.detected, true)
  const folder = await geminiProvider().info({ fs: fakeFs({ [`${HOME}/.gemini/settings.json`]: '{}' }), exec: fakeExec(), home: HOME })
  assert.equal(folder.detected, true)
})
