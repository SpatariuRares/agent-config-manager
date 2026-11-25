import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs } from './args.ts'

test('no arguments and `start` both start the panel on port 4321 and open the browser', () => {
  assert.deepEqual(parseArgs([]), { command: 'start', port: 4321, open: true })
  assert.deepEqual(parseArgs(['start']), { command: 'start', port: 4321, open: true })
})

test('start takes --port N and --no-open', () => {
  assert.deepEqual(parseArgs(['start', '--port', '5000', '--no-open']), { command: 'start', port: 5000, open: false })
  assert.deepEqual(parseArgs(['--no-open']), { command: 'start', port: 4321, open: false })
})

test('start refuses a port that is not a number from 0 to 65535', () => {
  for (const argv of [['start', '--port'], ['start', '--port', 'x'], ['start', '--port', '70000'], ['start', '--port', '1.5']]) {
    const parsed = parseArgs(argv)
    assert.equal(parsed.command, 'invalid', argv.join(' '))
    assert.match((parsed as { message: string }).message, /--port/)
  }
})

test('install-commands and uninstall-commands default to every agent and take --agent and --dry-run', () => {
  assert.deepEqual(parseArgs(['install-commands']), { command: 'install-commands', agents: 'all', dryRun: false })
  assert.deepEqual(parseArgs(['install-commands', '--agent', 'gemini', '--dry-run']), {
    command: 'install-commands',
    agents: ['gemini'],
    dryRun: true
  })
  assert.deepEqual(parseArgs(['uninstall-commands', '--agent', 'all']), { command: 'uninstall-commands', agents: 'all', dryRun: false })
  assert.deepEqual(parseArgs(['uninstall-commands', '--agent', 'codex']), { command: 'uninstall-commands', agents: ['codex'], dryRun: false })
})

test('an unknown agent, command or option is refused with a message', () => {
  assert.match((parseArgs(['install-commands', '--agent', 'cursor']) as { message: string }).message, /claude, codex, gemini, copilot or all/)
  assert.match((parseArgs(['install-commands', '--agent']) as { message: string }).message, /--agent/)
  assert.match((parseArgs(['frobnicate']) as { message: string }).message, /Unknown command: frobnicate/)
  assert.match((parseArgs(['start', '--dry-run']) as { message: string }).message, /Unknown option for start: --dry-run/)
  assert.match((parseArgs(['install-commands', '--port', '1']) as { message: string }).message, /Unknown option for install-commands: --port/)
})

test('--help, -h, help, --version and -v are recognised anywhere first', () => {
  for (const flag of ['--help', '-h', 'help']) assert.deepEqual(parseArgs([flag]), { command: 'help' })
  assert.deepEqual(parseArgs(['install-commands', '--help']), { command: 'help' })
  for (const flag of ['--version', '-v']) assert.deepEqual(parseArgs([flag]), { command: 'version' })
})
