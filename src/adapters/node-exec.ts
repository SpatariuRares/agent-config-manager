// The CommandRunner port over real binaries (node:child_process), for every provider. Every call passes argv,
// never a shell.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { CliResult, CommandRunner } from '../core/ports.ts'

// Apps like Orca may start workers without the shell's PATH, so look in the usual install places too.
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/usr/bin']

/** The first executable called `name` on `path`, then in the usual install folders; null when there is none. */
export async function findCommand(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
  for (const dir of [...path.split(delimiter).filter(Boolean), ...FALLBACK_DIRS]) {
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

/**
 * CommandRunner over node:child_process. `find` locates a command by name (default: PATH, then the usual
 * install folders); an absolute path runs as is. Its folder goes first on PATH, so a node script like npx finds
 * `node` even without the shell's PATH.
 */
export function nodeCommandRunner(find: (name: string) => Promise<string | null> = (name) => findCommand(name)): CommandRunner {
  return {
    find,
    async run(name, argv, cwd, options = {}): Promise<CliResult> {
      const command = name.startsWith('/') ? name : await find(name)
      if (command === null) return { ok: false, output: `The ${name} command was not found.` }
      const env = { ...process.env, PATH: [dirname(command), process.env.PATH].filter(Boolean).join(delimiter) }
      return new Promise((resolve) => {
        const child = execFile(command, [...argv], { cwd: cwd ?? homedir(), timeout: options.timeoutMs ?? 120_000, env }, (error, stdout, stderr) => {
          resolve({ ok: error === null, output: `${stdout}${stderr}`.trim() || String(error ?? '') })
        })
        if (options.closeStdin) child.stdin?.end()
      })
    }
  }
}
