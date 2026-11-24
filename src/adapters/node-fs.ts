// FileSystem port over node:fs, shared by the Orca worker and the future localhost server.
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudePaths, FileSystem } from '../core/ports.ts'

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

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
  async writeText(path, text) {
    // Write through a symlink (dotfiles setups) instead of replacing the link with a plain file.
    const target = await realpath(path).catch((error) => (isMissing(error) ? path : Promise.reject(error)))
    await mkdir(dirname(target), { recursive: true })
    // Write a sibling temp file, then rename over the target: readers never see half a file.
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}

export function defaultClaudePaths(home = homedir()): ClaudePaths {
  return { claudeDir: join(home, '.claude'), userConfigFile: join(home, '.claude.json') }
}
