// FileSystem port over node:fs, shared by the Orca worker and the future localhost server.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  }
}

export function defaultClaudePaths(home = homedir()): ClaudePaths {
  return { claudeDir: join(home, '.claude'), userConfigFile: join(home, '.claude.json') }
}
