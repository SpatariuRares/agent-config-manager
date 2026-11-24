import assert from 'node:assert/strict'
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { nodeFileSystem } from './node-fs.ts'

const scratch = await mkdtemp(join(tmpdir(), 'ccm-node-fs-'))
after(() => rm(scratch, { recursive: true, force: true }))

test('writeText creates missing folders and leaves no temp file behind', async () => {
  const path = join(scratch, 'a', 'b', 'settings.json')
  await nodeFileSystem.writeText(path, '{}\n')
  assert.equal(await readFile(path, 'utf8'), '{}\n')
  assert.deepEqual(await readdir(join(scratch, 'a', 'b')), ['settings.json'])
})

test('writeText through a symlink updates the target and keeps the link', async () => {
  const real = join(scratch, 'real.json')
  const link = join(scratch, 'link.json')
  await writeFile(real, 'old')
  await symlink(real, link)
  await nodeFileSystem.writeText(link, 'new')
  assert.equal(await readFile(real, 'utf8'), 'new')
  assert.equal((await lstat(link)).isSymbolicLink(), true)
})

test('readText and listEntries treat missing paths as empty', async () => {
  assert.equal(await nodeFileSystem.readText(join(scratch, 'missing.json')), null)
  assert.deepEqual(await nodeFileSystem.listEntries(join(scratch, 'missing')), [])
})
