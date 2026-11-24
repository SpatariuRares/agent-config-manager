// A realistic Gemini CLI 0.35.3 machine for the provider's tests, and helpers to run it through the real router.
import { fakeFs } from '../../core/test-support.ts'
import type { CliResult } from '../../core/ports.ts'
import type { Action, ActionAnswer, View } from '../../adapters/view.ts'
import { routeAction, routeView } from '../router.ts'
import { fakeExec } from '../testing.ts'
import type { ProviderDeps } from '../types.ts'
import { geminiProvider } from './index.ts'

export const HOME = '/home/me'
export const GEMINI = `${HOME}/.gemini`
export const USER_SETTINGS = `${GEMINI}/settings.json`
export const ENABLEMENT = `${GEMINI}/extensions/extension-enablement.json`
export const MCP_ENABLEMENT = `${GEMINI}/mcp-server-enablement.json`
export const SHOP = '/work/shop'
export const SHOP_SETTINGS = `${SHOP}/.gemini/settings.json`
export const BACKUPS = `${HOME}/.config/claude-config-manager/backups/gemini`
export const OLD_BACKUP = 'settings.2026-11-20T10-00-00-000Z.json'

/** Secret values the fixture holds; none may ever show in an item. */
export const SECRETS = ['super-secret-env', 'sk-live-0123456789abcdef', 'abc123token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Bearer xyz', 'hunter2']

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

/** The user's settings.json: JSON with comments, as Gemini CLI allows. */
export const userSettingsText =
  '// Gemini CLI user settings\n' +
  json({
    mcpServers: {
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@2.2.5'] },
      vercel: { type: 'http', url: 'https://mcp.vercel.com/mcp?token=abc123token' },
      secretive: {
        command: 'node',
        args: ['server.js', '--api-key', 'sk-live-0123456789abcdef'],
        env: { API_KEY: 'super-secret-env' }
      },
      remote: { url: 'https://user:hunter2@example.com/sse', headers: { Authorization: 'Bearer xyz' } },
      blocked: { command: 'blocked-mcp' }
    },
    mcp: { excluded: ['blocked'] },
    hooks: {
      BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo hi', name: 'greeter' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 notify' }] }]
    },
    hooksConfig: { disabled: ['greeter'] },
    skills: { disabled: ['Review'] },
    agents: { overrides: { planner: { enabled: false } } },
    security: { auth: { selectedType: 'oauth-personal' } }
  })

export const shopSettingsText = json({
  mcpServers: { db: { command: 'pg-mcp', args: ['--readonly'] } },
  hooks: { AfterTool: [{ hooks: [{ type: 'command', command: 'npm run lint' }] }] },
  skills: { disabled: ['deploy'] }
})

const ext = `${GEMINI}/extensions`

export function files(): Record<string, string> {
  return {
    [USER_SETTINGS]: userSettingsText,
    [MCP_ENABLEMENT]: json({ context7: { enabled: false } }),
    [ENABLEMENT]: json({ obsidian: { overrides: [`${HOME}/*`, `!${SHOP}/*`] }, 'local-ext': { overrides: [`!${HOME}/*`] } }),
    [`${ext}/obsidian/gemini-extension.json`]: json({
      name: 'obsidian',
      version: '1.1.0',
      description: 'Obsidian vault tools',
      mcpServers: { 'obsidian-mcp': { command: 'node', args: ['${extensionPath}/dist/index.js'] } }
    }),
    [`${ext}/obsidian/.gemini-extension-install.json`]: json({ source: 'https://github.com/someone/gemini-obsidian', type: 'git' }),
    [`${ext}/obsidian/skills/companion/SKILL.md`]: '---\nname: obsidian-companion\ndescription: Notes helper\n---\n',
    [`${ext}/obsidian/agents/librarian.md`]: '---\nname: librarian\ndescription: Finds notes\n---\n',
    [`${ext}/obsidian/commands/obsidian/search.toml`]: 'prompt = "search"\n',
    [`${ext}/obsidian/commands/daily.toml`]: 'prompt = "daily"\n',
    [`${ext}/obsidian/hooks/hooks.json`]: json({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
    [`${ext}/obsidian/.env`]: 'OBSIDIAN_TOKEN=hunter2\n',
    [`${ext}/local-ext/gemini-extension.json`]: json({ name: 'local-ext', version: '0.1.0' }),
    [`${ext}/local-ext/.gemini-extension-install.json`]: json({ source: '/src/local-ext', type: 'local' }),
    [`${GEMINI}/skills/review/SKILL.md`]: '---\nname: review\ndescription: Reviews code\n---\n',
    [`${GEMINI}/skills/_shared/notes.md`]: 'not a skill',
    [`${HOME}/.agents/skills/shared/SKILL.md`]: '---\nname: shared\ndescription: Shared skill\n---\n',
    [`${GEMINI}/agents/planner.md`]: '---\nname: planner\ndescription: Plans work\n---\n',
    [`${GEMINI}/agents/_draft.md`]: '---\nname: draft\ndescription: ignored\n---\n',
    [`${GEMINI}/projects.json`]: json({ projects: { [SHOP]: 'shop', [HOME]: 'me', '/gone': 'gone' } }),
    [SHOP_SETTINGS]: shopSettingsText,
    [`${SHOP}/.gemini/skills/deploy/SKILL.md`]: '---\nname: deploy\ndescription: Deploys\n---\n',
    [`${SHOP}/.gemini/agents/reviewer.md`]: '---\nname: reviewer\ndescription: Reviews PRs\n---\n',
    [`${SHOP}/README.md`]: 'shop',
    // Antigravity's files, not Gemini CLI's: never shown.
    [`${GEMINI}/config/mcp_config.json`]: json({ mcpServers: { antigravity: { serverUrl: 'https://x.example' } } }),
    [`${GEMINI}/config/agents/jd-judge.md`]: '---\nname: jd-judge\ndescription: Antigravity agent\n---\n',
    // Secrets the provider must never read.
    [`${GEMINI}/.env`]: 'GEMINI_API_KEY=hunter2\n',
    [`${GEMINI}/oauth_creds.json`]: json({ access_token: 'hunter2' }),
    [`${GEMINI}/google_accounts.json`]: json({ active: 'me@example.com' }),
    [`${GEMINI}/history/abc/log.json`]: '[]',
    [`${GEMINI}/logs/x.log`]: 'log',
    [`${BACKUPS}/${OLD_BACKUP}`]: json({ mcpServers: {} })
  }
}

export const CLOCK = () => new Date('2026-11-24T10:00:00.000Z')

type Reply = (command: string, argv: readonly string[], cwd: string | null) => CliResult | Promise<CliResult>

/** A machine with the fixture, `gemini` on PATH, and a CLI double that answers with `reply`. */
export function machine(options: { files?: Record<string, string>; reply?: Reply } = {}) {
  const fs = fakeFs(options.files ?? files())
  const reads: string[] = []
  const readText = fs.readText.bind(fs)
  const listEntries = fs.listEntries.bind(fs)
  fs.readText = async (path) => {
    reads.push(path)
    return readText(path)
  }
  fs.listEntries = async (dir) => {
    reads.push(`${dir}/`)
    return listEntries(dir)
  }
  const exec = fakeExec({ commands: { gemini: '/usr/bin/gemini' }, reply: options.reply })
  const deps: ProviderDeps = { fs, exec, home: HOME, clock: CLOCK }
  return { fs, exec, deps, reads }
}

const providers = [geminiProvider()]

export async function viewOf(deps: ProviderDeps): Promise<View> {
  const answer = await routeView(deps, providers, { agent: 'gemini' })
  if (!answer.ok) throw new Error(answer.error)
  return answer.view
}

export async function act(deps: ProviderDeps, action: Action, versions?: Record<string, string>): Promise<ActionAnswer> {
  const view = versions === undefined ? await viewOf(deps) : null
  return routeAction(deps, providers, { agent: 'gemini', action, versions: versions ?? view!.versions })
}

/** The item of a kind with this name (and project), or a thrown error naming what is there. */
export function itemOf(view: View, kind: string, name: string, project: string | null = null) {
  const item = view.items.find((i) => i.kind === kind && i.name === name && i.project === project)
  if (!item) throw new Error(`no ${kind} ${name} in ${project ?? 'global'}: ${view.items.map((i) => `${i.kind}/${i.name}@${i.project}`).join(', ')}`)
  return item
}

export { json }
