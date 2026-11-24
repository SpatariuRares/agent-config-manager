// FileSystem port over node:fs, shared by the Orca worker and the localhost server.
import { randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FileSystem } from '../core/ports.ts'

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Whether anything, a broken symlink included, is at `path`. */
const occupied = (path: string) => lstat(path).then(() => true, (error) => (isMissing(error) ? false : Promise.reject(error)))

async function refuseExisting(dst: string) {
  if (await occupied(dst)) throw Object.assign(new Error(`${dst} already exists`), { code: 'EEXIST' })
  await mkdir(dirname(dst), { recursive: true })
}

// Links are copied as links with their text unchanged, never followed.
const copyTree = (src: string, dst: string) =>
  cp(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true })

export const nodeFileSystem: FileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },
  async listEntries(dir) {
    try {
      return (await readdir(dir)).filter((name) => !name.startsWith('.')).sort()
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },
  async realPath(path) {
    try {
      return await realpath(path)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },
  async linkTarget(path) {
    try {
      return await readlink(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (isMissing(error) || code === 'EINVAL') return null
      throw error
    }
  },
  async move(src, dst) {
    await refuseExisting(dst)
    try {
      await rename(src, dst)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      // Another volume: copy, then remove the original (a link is removed, never its target).
      await copyTree(src, dst)
      await rm(src, { recursive: true, force: true })
    }
  },
  async copy(src, dst) {
    await refuseExisting(dst)
    await copyTree(src, dst)
  },
  async writeText(path, text) {
    // Write through a symlink (dotfiles setups) instead of replacing the link with a plain file.
    const target = await realpath(path).catch((error) => (isMissing(error) ? path : Promise.reject(error)))
    await mkdir(dirname(target), { recursive: true })
    // Keep the replaced file's permissions (settings can hold secrets in `env`).
    const mode = await stat(target).then((info) => info.mode & 0o777, () => null)
    // Write a sibling temp file, then rename over the target: readers never see half a file.
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, { encoding: 'utf8', flag: 'wx', mode: mode ?? 0o600 })
      if (mode !== null) await chmod(temp, mode)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
