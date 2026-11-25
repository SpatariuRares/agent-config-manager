// The `agent-config` command. bin/agent-config.js checks the Node version, then calls main().
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installCommands, nodeInstallerFs, type InstallerFs, type Outcome, uninstallCommands } from './agent-commands.ts'
import { HELP, parseArgs } from './args.ts'

export interface MainDeps {
  fs: InstallerFs
  home: string
  out: (text: string) => void
  err: (text: string) => void
  /** Starts the server; the default runs the same entry as `npm start`. */
  start: (port: number, open: boolean) => Promise<void>
}

const root = join(import.meta.dirname, '..', '..')

/** Runs src/adapters/http/main.ts, the `npm start` entry, with the parsed options as its arguments. */
async function startServer(port: number, open: boolean) {
  const entry = join(root, 'src', 'adapters', 'http', 'main.ts')
  process.argv = [process.argv[0], entry, '--port', String(port), ...(open ? [] : ['--no-open'])]
  await import(pathToFileURL(entry).href)
}

const LABELS: Record<Outcome['status'], string> = {
  written: 'added',
  updated: 'updated',
  unchanged: 'already there',
  'would-write': 'would add',
  skipped: 'skipped',
  refused: 'refused',
  removed: 'removed',
  'would-remove': 'would remove',
  absent: 'not installed'
}

const report = (outcomes: Outcome[]) =>
  outcomes.map(({ agent, path, status, reason }) => `  ${agent.padEnd(8)} ${LABELS[status].padEnd(13)} ${path}${reason ? `\n           (${reason})` : ''}`).join('\n')

/** Runs one command line. Resolves to the exit code; `start` resolves once the server is starting and keeps running. */
export async function main(argv: readonly string[], deps: Partial<MainDeps> = {}): Promise<number> {
  const { fs = nodeInstallerFs, home = homedir(), out = console.log, err = console.error, start = startServer } = deps
  const parsed = parseArgs(argv)
  switch (parsed.command) {
    case 'help':
      out(HELP)
      return 0
    case 'version': {
      const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }
      out(version)
      return 0
    }
    case 'invalid':
      err(`${parsed.message}\nRun agent-config --help for the usage.`)
      return 2
    case 'start':
      await start(parsed.port, parsed.open)
      return 0
    case 'install-commands':
    case 'uninstall-commands': {
      const run = parsed.command === 'install-commands' ? installCommands : uninstallCommands
      const outcomes = await run(fs, home, parsed.agents, { dryRun: parsed.dryRun })
      out(`${parsed.dryRun ? 'Dry run, nothing changed:' : parsed.command === 'install-commands' ? 'Agent commands:' : 'Removed agent commands:'}\n${report(outcomes)}`)
      if (parsed.command === 'install-commands' && outcomes.some((outcome) => outcome.status === 'written' || outcome.status === 'updated')) {
        out('\nStart a new agent session, then type /agent-config (in Codex: $agent-config).')
      }
      return outcomes.some((outcome) => outcome.status === 'refused') ? 1 : 0
    }
  }
}
