// Project writes against a real disk: symlinks are something only a real filesystem has.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { versionOf } from '../core/inventory.ts'
import { setProjectPluginState } from '../core/toggle.ts'
import { nodeFileSystem } from './node-fs.ts'

const home = await mkdtemp(join(tmpdir(), 'ccm-home-'))
after(() => rm(home, { recursive: true, force: true }))

test('a project that is a symlink to the home folder cannot write the user settings', async () => {
  const paths = { claudeDir: join(home, '.claude'), userConfigFile: join(home, '.claude.json') }
  const user = JSON.stringify({ enabledPlugins: { 'a@m': false } })
  await mkdir(paths.claudeDir, { recursive: true })
  await writeFile(join(paths.claudeDir, 'settings.json'), user)
  const alias = join(home, 'alias')
  await symlink(home, alias)
  await writeFile(paths.userConfigFile, JSON.stringify({ projects: { [alias]: {} } }))

  const result = await setProjectPluginState(nodeFileSystem, paths, {
    id: 'a@m',
    project: alias,
    scope: 'project',
    enabled: true,
    version: versionOf(user)
  })
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.equal(await readFile(join(paths.claudeDir, 'settings.json'), 'utf8'), user)
})
