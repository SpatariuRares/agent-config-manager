// Project writes against a real disk, through the provider and the router: symlinks are something only a real
// filesystem has. Every home is a mkdtemp folder; no CLI runs.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { nodeFileSystem } from '../../adapters/node-fs.ts'
import type { ActionResult, Target, View } from '../../adapters/view.ts'
import { fakeExec } from '../../core/test-support.ts'
import { routeAction, routeView } from '../router.ts'
import type { ProviderDeps } from '../types.ts'
import { claudeProvider } from './index.ts'

const homes: string[] = []
after(() => Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))))

/** A real home whose user settings turn a@m off, and a project folder `/work/blog` setting c@m (installed). */
async function home(): Promise<{ deps: ProviderDeps; home: string; settings: string; user: string }> {
  const home = await mkdtemp(join(tmpdir(), 'acm-home-'))
  homes.push(home)
  const settings = join(home, '.claude', 'settings.json')
  const user = JSON.stringify({ enabledPlugins: { 'a@m': false } })
  await mkdir(join(home, '.claude', 'plugins'), { recursive: true })
  await writeFile(settings, user)
  await writeFile(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'c@m': [{ scope: 'user' }] } }))
  await mkdir(join(home, 'blog', '.claude'), { recursive: true })
  await writeFile(join(home, 'blog', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'c@m': true } }))
  return { deps: { fs: nodeFileSystem, exec: fakeExec(), home }, home, settings, user }
}

/** Copies the c@m override of the blog project into `to`, through the router. */
async function copyOverride(deps: ProviderDeps, to: Target): Promise<ActionResult> {
  const answer = await routeView(deps, [claudeProvider()])
  assert.equal(answer.ok, true)
  const view = (answer as { ok: true; view: View }).view
  const item = view.items.find((i) => i.kind === 'plugins' && i.plugin?.id === 'c@m' && i.project?.endsWith('/blog'))
  assert.ok(item, 'the blog override')
  return (await routeAction(deps, [claudeProvider()], { agent: 'claude', action: { type: 'move', key: item.key, to, copy: true }, versions: view.versions })).result
}

test('a project that is a symlink to the home folder cannot write the user settings', async () => {
  const { deps, home: dir, settings, user } = await home()
  const alias = join(dir, 'alias')
  await symlink(dir, alias)
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: { [alias]: {}, [join(dir, 'blog')]: {} } }))
  const result = await copyOverride(deps, { project: alias, scope: 'project' })
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.equal(await readFile(settings, 'utf8'), user)
})

test('a project settings file that is a symlink to the user settings cannot be written through', async () => {
  const { deps, home: dir, settings, user } = await home()
  const project = join(dir, 'proj')
  await mkdir(join(project, '.claude'), { recursive: true })
  await symlink(settings, join(project, '.claude', 'settings.json'))
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ projects: { [project]: {}, [join(dir, 'blog')]: {} } }))
  const result = await copyOverride(deps, { project, scope: 'project' })
  assert.equal(result.ok === false && result.reason, 'unknown-project')
  assert.equal(await readFile(settings, 'utf8'), user)
})
