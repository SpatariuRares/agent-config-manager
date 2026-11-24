import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

test('writeText keeps the permissions of the file it replaces', async () => {
  const path = join(scratch, 'private.json')
  await writeFile(path, 'old')
  await chmod(path, 0o600)
  await nodeFileSystem.writeText(path, 'new')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('concurrent writes to the same file both land, without temp-name collisions', async () => {
  const path = join(scratch, 'race.json')
  await Promise.all([nodeFileSystem.writeText(path, 'one'), nodeFileSystem.writeText(path, 'two')])
  assert.ok(['one', 'two'].includes(await readFile(path, 'utf8')))
  assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith('race.json.')), [])
})

test('move renames a folder into a missing parent, and refuses an existing destination', async () => {
  const src = join(scratch, 'skills', 'one')
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'SKILL.md'), 'one')
  const dst = join(scratch, 'project', '.claude', 'skills', 'one')
  await nodeFileSystem.move(src, dst)
  assert.equal(await readFile(join(dst, 'SKILL.md'), 'utf8'), 'one')
  assert.equal(await nodeFileSystem.realPath(src), null)

  const other = join(scratch, 'skills', 'other')
  await mkdir(other, { recursive: true })
  await assert.rejects(nodeFileSystem.move(other, dst), /exists/)
  assert.equal(await readFile(join(dst, 'SKILL.md'), 'utf8'), 'one')
})

test('move of a symlinked skill moves the link and leaves its target where it is', async () => {
  const real = join(scratch, 'dotfiles', 'linked')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'SKILL.md'), 'linked')
  const link = join(scratch, 'skills', 'linked')
  await mkdir(join(scratch, 'skills'), { recursive: true })
  await symlink(real, link)
  const dst = join(scratch, 'elsewhere', 'linked')
  await nodeFileSystem.move(link, dst)
  assert.equal((await lstat(dst)).isSymbolicLink(), true)
  assert.equal(await nodeFileSystem.linkTarget(dst), real)
  assert.equal(await readFile(join(real, 'SKILL.md'), 'utf8'), 'linked')
  assert.equal(await nodeFileSystem.linkTarget(link), null)
})

test('copy copies a folder recursively, keeps inner links verbatim, and refuses an existing destination', async () => {
  const src = join(scratch, 'copy-src')
  await mkdir(join(src, 'sub'), { recursive: true })
  await writeFile(join(src, 'SKILL.md'), 'body')
  await writeFile(join(src, 'sub', 'x.txt'), 'x')
  await symlink('sub/x.txt', join(src, 'rel-link'))
  const dst = join(scratch, 'copy-dst', 'skill')
  await nodeFileSystem.copy(src, dst)
  assert.equal(await readFile(join(dst, 'SKILL.md'), 'utf8'), 'body')
  assert.equal(await readFile(join(dst, 'sub', 'x.txt'), 'utf8'), 'x')
  assert.equal(await nodeFileSystem.linkTarget(join(dst, 'rel-link')), 'sub/x.txt')
  assert.equal(await readFile(join(src, 'SKILL.md'), 'utf8'), 'body')
  await assert.rejects(nodeFileSystem.copy(src, dst), /exists/)
})

test('copy of a symlink copies the link itself', async () => {
  const real = join(scratch, 'copy-real')
  await mkdir(real, { recursive: true })
  await writeFile(join(real, 'SKILL.md'), 'r')
  const link = join(scratch, 'copy-link')
  await symlink(real, link)
  const dst = join(scratch, 'copy-link-dst')
  await nodeFileSystem.copy(link, dst)
  assert.equal(await nodeFileSystem.linkTarget(dst), real)
})

test('linkTarget is null for plain files and missing paths', async () => {
  const file = join(scratch, 'plain.txt')
  await writeFile(file, 'p')
  assert.equal(await nodeFileSystem.linkTarget(file), null)
  assert.equal(await nodeFileSystem.linkTarget(join(scratch, 'nothing')), null)
})
