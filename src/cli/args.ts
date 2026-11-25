// Parses the `agent-config` command line. Pure: no process, no disk.

export const AGENTS = ['claude', 'codex', 'gemini', 'copilot'] as const
export type AgentId = (typeof AGENTS)[number]

export const DEFAULT_PORT = 4321

export type Parsed =
  | { command: 'start'; port: number; open: boolean }
  | { command: 'install-commands' | 'uninstall-commands'; agents: AgentId[] | 'all'; dryRun: boolean }
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'invalid'; message: string }

const invalid = (message: string): Parsed => ({ command: 'invalid', message })

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.some((arg) => arg === '--help' || arg === '-h') || argv[0] === 'help') return { command: 'help' }
  if (argv.some((arg) => arg === '--version' || arg === '-v')) return { command: 'version' }

  const [first = 'start'] = argv
  const command = first.startsWith('-') ? 'start' : first
  const rest = first.startsWith('-') ? argv : argv.slice(1)

  if (command === 'start') {
    let port = DEFAULT_PORT
    let open = true
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--no-open') open = false
      else if (rest[i] === '--port') {
        const value = rest[++i]
        port = Number(value)
        if (value === undefined || value === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
          return invalid('--port needs a whole number from 0 to 65535.')
        }
      } else return invalid(`Unknown option for start: ${rest[i]}`)
    }
    return { command, port, open }
  }

  if (command === 'install-commands' || command === 'uninstall-commands') {
    let agents: AgentId[] | 'all' = 'all'
    let dryRun = false
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--dry-run') dryRun = true
      else if (rest[i] === '--agent') {
        const value = rest[++i]
        if (value === 'all') agents = 'all'
        else if ((AGENTS as readonly string[]).includes(value ?? '')) agents = [value as AgentId]
        else return invalid(`--agent needs one of: claude, codex, gemini, copilot or all${value === undefined ? '.' : ` (got ${value}).`}`)
      } else return invalid(`Unknown option for ${command}: ${rest[i]}`)
    }
    return { command, agents, dryRun }
  }

  return invalid(`Unknown command: ${command}`)
}

export const HELP = `Usage: agent-config [command] [options]

Starts Agent Config Manager, a local web panel for the setup of your coding agents.

Commands:
  start [--port N] [--no-open]   Start the panel (the default command). Prints a link with a
                                 one-time token and opens it in the browser. Port: ${DEFAULT_PORT}.
  install-commands [--agent A] [--dry-run]
                                 Add an /agent-config command to each agent, so you can open the
                                 panel from inside the agent. A is claude, codex, gemini, copilot
                                 or all (default: every agent whose config folder exists).
  uninstall-commands [--agent A] [--dry-run]
                                 Remove the commands install-commands added, and nothing else.

Options:
  --dry-run      List what would be written or removed; change nothing.
  -h, --help     Show this help.
  -v, --version  Show the version.
`
