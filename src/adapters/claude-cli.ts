// PluginCli over the real `claude` binary.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PluginCli } from '../core/ports.ts'

// Apps like Orca may start workers without the shell's PATH, so look in the usual places too.
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.claude/local')]

export async function findClaude(path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of [...path.split(delimiter).filter(Boolean), ...FALLBACK_DIRS]) {
    const candidate = join(dir, 'claude')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

export function claudeCli(binary: () => Promise<string | null> = () => findClaude()): PluginCli {
  return {
    async uninstall(id, scope, cwd) {
      const claude = await binary()
      if (claude === null) return { ok: false, output: 'The claude command was not found.' }
      const args = ['plugin', 'uninstall', id, '--scope', scope, '--keep-data', '--json']
      return new Promise((resolve) => {
        execFile(claude, args, { cwd: cwd ?? homedir(), timeout: 120_000 }, (error, stdout, stderr) => {
          resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() || String(error ?? '') })
        })
      })
    }
  }
}
