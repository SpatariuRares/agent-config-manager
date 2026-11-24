// In-memory backend for the panel outside Orca (and for the Playwright tests).
// It answers the same contract as the worker: 'view.get' -> ViewAnswer, 'action.run' -> ActionAnswer,
// 'updates.check' -> UpdatesAnswer, each for one agent (Claude Code, Codex, Gemini CLI, Copilot CLI).
// The data is synthetic; nothing here reads or writes the real disk or the network. An action the
// agent does not support is refused, like the real providers do. Every request is recorded in
// `requests` so tests can see exactly what was sent.

const HOME = '/Users/you'
const P_STORE = `${HOME}/code/storefront`
const P_API = `${HOME}/code/api-gateway`
const P_NOTES = `${HOME}/code/notes`
const PROJECTS = [P_API, P_NOTES, P_STORE]

const USER_SETTINGS = `${HOME}/.claude/settings.json`
const CLAUDE_JSON = `${HOME}/.claude.json`

const settingsFile = (project, scope) =>
  project === null ? USER_SETTINGS : `${project}/.claude/${scope === 'local' ? 'settings.local.json' : 'settings.json'}`

const CODEX_CONFIG = `${HOME}/.codex/config.toml`
const GEMINI_SETTINGS = `${HOME}/.gemini/settings.json`

/** Where each agent keeps an item of each class; Claude Code's layout is the real one. */
const LAYOUT = {
  claude(kind, name, project, scope) {
    switch (kind) {
      case 'plugins':
      case 'hooks':
        return settingsFile(project, scope)
      case 'skills':
        return `${project ?? `${HOME}`}/.claude/skills/${name}/SKILL.md`
      case 'agents':
        return `${project ?? `${HOME}`}/.claude/agents/${name}.md`
      case 'mcp':
        return project === null || scope === 'local' ? CLAUDE_JSON : `${project}/.mcp.json`
    }
  },
  codex(kind, name, project) {
    switch (kind) {
      case 'skills':
        return `${project ?? HOME}/.codex/skills/${name}/SKILL.md`
      case 'hooks':
        return `${HOME}/.codex/hooks.json`
      default:
        return project === null ? CODEX_CONFIG : `${project}/.codex/config.toml`
    }
  },
  gemini(kind, name, project) {
    if (kind === 'plugins') return `${HOME}/.gemini/extensions/${name}/gemini-extension.json`
    return project === null ? GEMINI_SETTINGS : `${project}/.gemini/settings.json`
  },
  copilot(kind, name) {
    return kind === 'mcp' ? `${HOME}/.copilot/mcp-config.json` : `${HOME}/.copilot/${kind}/${name}`
  },
}

function sourceFor(kind, name, project, scope, agent = 'claude') {
  return LAYOUT[agent](kind, name, project, scope)
}

function keyFor(kind, name, project, scope, agent = 'claude') {
  const source = sourceFor(kind, name, project, scope, agent)
  const shared = kind === 'plugins' || kind === 'mcp' || kind === 'hooks'
  return shared ? `${kind}:${source}#${project ?? '~'}#${name}` : `${kind}:${source}`
}

const none = () => ({ skills: [], agents: [], commands: [], hooks: [], mcpServers: [] })

function plugin(id, version, enabled, contributes = {}, project = null, scope = 'user', agent = 'claude') {
  const at = id.lastIndexOf('@')
  const name = at === -1 ? id : id.slice(0, at)
  const marketplace = at === -1 ? '' : id.slice(at + 1)
  return {
    key: keyFor('plugins', agent === 'claude' ? id : name, project, scope, agent),
    agent,
    kind: 'plugins',
    name,
    description: '',
    project,
    scope,
    source: sourceFor('plugins', agent === 'claude' ? id : name, project, scope, agent),
    movable: true,
    removable: project !== null,
    plugin: {
      id,
      enabled,
      version,
      contributes: { ...none(), ...contributes },
      sharesNameWith: [],
      installed: true,
      installs: [{ scope: 'user', project: null }],
    },
    // Installs update from their marketplace; a project override only switches the global install.
    ...(project === null && agent === 'claude' ? { updateSource: { type: 'plugin', label: marketplace, current: version } } : {}),
  }
}

const skillsCli = (repo, hash) => ({ updateSource: { type: 'skills-cli', label: repo, current: hash } })

function simple(kind, name, description, project = null, scope = project ? 'project' : 'user', extra = {}, agent = 'claude') {
  return {
    key: keyFor(kind, name, project, scope, agent),
    agent,
    kind,
    name,
    description,
    project,
    scope,
    source: sourceFor(kind, name, project, scope, agent),
    movable: true,
    removable: true,
    ...extra,
  }
}

function seedItems() {
  const plugins = [
    plugin('feature-dev@claude-plugins-official', '1.6.0', true, { agents: ['code-architect', 'code-explorer', 'code-reviewer'], commands: ['feature-dev'] }),
    plugin('code-review@claude-plugins-official', '1.4.2', true, { commands: ['code-review'], agents: ['reviewer'] }),
    plugin('commit-commands@claude-plugins-official', '1.1.0', true, { commands: ['commit', 'commit-push-pr', 'clean-gone'] }),
    plugin('pr-review-toolkit@claude-plugins-official', '2.0.1', false, { agents: ['silent-failure-hunter', 'type-design-analyzer', 'pr-test-analyzer', 'comment-analyzer'], commands: ['review-pr'] }),
    plugin('security-guidance@claude-plugins-official', '0.3.0', true, { hooks: ['PreToolUse'] }),
    plugin('frontend-design@claude-plugins-official', '1.0.4', false, { skills: ['frontend-design'] }),
    plugin('hookify@claude-plugins-official', '0.9.0', true, { commands: ['hookify', 'list', 'configure'], skills: ['writing-rules'], hooks: ['PreToolUse', 'Stop'] }),
    plugin('explanatory-output-style@claude-plugins-official', '1.0.0', false, { hooks: ['SessionStart'] }),
    plugin('plugin-dev@claude-plugins-official', '0.4.1', true, { skills: ['hook-development', 'mcp-integration', 'plugin-structure'], agents: ['plugin-validator'] }),
    plugin('agent-sdk-dev@claude-plugins-official', '1.2.0', false, { commands: ['new-sdk-app'], agents: ['agent-sdk-verifier-ts'] }),
    plugin('code-review@acme-tools', '0.9.2', false, { commands: ['code-review'], hooks: ['Stop'] }),
    plugin('deploy-helpers@acme-tools', '3.1.0', true, { commands: ['deploy', 'rollback'], mcpServers: ['acme-deploy'] }),
    plugin('k8s-tools@acme-tools', '2.4.0', true, { skills: ['kubectl-debug'], mcpServers: ['kube'] }),
    plugin('sql-assistant@acme-tools', '1.0.0', true, { skills: ['sql-review'], agents: ['query-tuner'] }),
    plugin('release-notes@acme-tools', null, true, { commands: ['release-notes'] }),
    plugin('obsidian-sync@community-hub', '0.2.3', false, { skills: ['obsidian-vault'] }),
    plugin('tmux-pilot@community-hub', '0.6.0', true, { commands: ['tmux'] }),
    plugin('rust-analyzer-lsp@community-hub', '1.0.0', false, {}),
    plugin('playwright-mcp@community-hub', '0.0.41', true, { mcpServers: ['playwright'] }),
    plugin('frontend-design@claude-plugins-official', '1.0.4', true, { skills: ['frontend-design'] }, P_STORE, 'local'),
    plugin('playwright-mcp@community-hub', '0.0.41', true, { mcpServers: ['playwright'] }, P_STORE, 'project'),
    plugin('k8s-tools@acme-tools', '2.4.0', false, { skills: ['kubectl-debug'], mcpServers: ['kube'] }, P_API, 'local'),
  ]
  const skills = [
    simple('skills', 'pdf', 'Extract text and tables from PDF files, fill forms, merge and split documents. Use when the user works with any .pdf file.', null, 'user', skillsCli('anthropics/skills', 'b71e0c9a4d2f83e6150c7a9d4be2f61c0a3d58e7')),
    simple('skills', 'docx', 'Create and edit Word documents with tracked changes, comments and styles.', null, 'user', skillsCli('anthropics/skills', '4c2a91f07e3db6a85c19f2e0d7b4a3c6e18f9d02')),
    simple('skills', 'tdd', 'Test-driven development: write the failing test first, make it pass, then refactor while the tests stay green. Use when the user asks for red-green-refactor or wants integration tests before the fix.', null, 'user', skillsCli('mattpocock/skills', '9e04d1b7c3a26f58e0b4d9c2a71f36e8b5d0c4a1')),
    simple('skills', 'grilling', 'Stress-test a plan by asking hard questions one at a time.', null, 'user', skillsCli('mattpocock/skills', '2d7f5c0e9b1a4836c7e2f0d5a9b3c1e6f84a7d20')),
    simple('skills', 'gsap-scrolltrigger', 'Scroll-linked animations with GSAP ScrollTrigger: pinning, scrub, snapping and cleanup.', null, 'user', skillsCli('greensock/gsap-skills', 'e5a3c8f1d06b29a7c4e1f8d3b5a02c9e7f16d4b8')),
    simple('skills', 'changelog-writer', 'Draft a changelog entry from the commits since the last tag.', null, 'user', {
      movable: false,
      notMovableReason: 'A symlink to ~/dotfiles/skills/changelog-writer; move the target instead.',
    }),
    simple('skills', 'design-tokens', 'The storefront colour, spacing and type tokens, and how to add one.', P_STORE),
    simple('skills', 'checkout-flows', 'How checkout, cart and payment flows are wired, with the tests that pin them.', P_STORE),
  ]
  const agents = [
    simple('agents', 'code-simplifier', 'Simplifies recently changed code for clarity without changing behaviour.'),
    simple('agents', 'test-runner', 'Runs the suite, reads failures and proposes the smallest fix.'),
    simple('agents', 'doc-writer', 'Writes and updates README and reference docs from the code.'),
    simple('agents', 'rate-limit-auditor', 'Reviews gateway routes for missing or inconsistent rate limits.', P_API),
  ]
  const mcp = [
    simple('mcp', 'context7', '', null, 'user', {
      mcp: { transport: 'stdio', target: npxContext7('2.2.5') },
      updateSource: { type: 'npm', label: '@upstash/context7-mcp', current: '2.2.5' },
    }),
    simple('mcp', 'engram', '', null, 'user', {
      mcp: { transport: 'stdio', target: '/opt/homebrew/bin/engram mcp' },
      updateSource: { type: 'manual', label: 'Homebrew', current: '1.14.2', note: 'brew upgrade engram' },
    }),
    simple('mcp', 'github', '', null, 'user', { mcp: { transport: 'stdio', target: 'npx -y @modelcontextprotocol/server-github' } }),
    simple('mcp', 'sentry', '', null, 'user', { mcp: { transport: 'sse', target: 'https://mcp.sentry.dev/sse' } }),
    simple('mcp', 'playwright', '', P_STORE, 'project', { mcp: { transport: 'stdio', target: 'npx @playwright/mcp@latest' } }),
    simple('mcp', 'postgres', '', P_API, 'local', { mcp: { transport: 'stdio', target: 'postgres-mcp --dsn postgres://localhost:5432/gateway' } }),
  ]
  const hooks = [
    simple('hooks', 'PreToolUse Bash', '', null, 'user', { hook: { event: 'PreToolUse', matcher: 'Bash', command: '~/.claude/hooks/guard-rm.sh' } }),
    simple('hooks', 'PostToolUse Edit|Write', '', null, 'user', { hook: { event: 'PostToolUse', matcher: 'Edit|Write', command: 'npx prettier --write "$CLAUDE_FILE_PATHS"' } }),
    simple('hooks', 'Stop', '', null, 'user', { hook: { event: 'Stop', matcher: '', command: 'afplay /System/Library/Sounds/Glass.aiff' } }),
    simple('hooks', 'SessionStart', '', P_STORE, 'project', { hook: { event: 'SessionStart', matcher: '', command: 'npm run --silent check:env' } }),
  ]
  return linkSharedNames([...plugins, ...skills, ...agents, ...mcp, ...hooks])
}

/** Fills plugin.sharesNameWith: other installed plugin ids with the same name. */
function linkSharedNames(items) {
  const ids = [...new Set(items.filter((i) => i.kind === 'plugins').map((i) => i.plugin.id))]
  for (const item of items) {
    if (item.kind !== 'plugins') continue
    item.plugin.sharesNameWith = ids.filter((id) => id !== item.plugin.id && id.slice(0, id.lastIndexOf('@')) === item.name)
  }
  return items
}

// ---------- Agents ----------

const KINDS = ['plugins', 'skills', 'agents', 'mcp', 'hooks']
/** Backups cover every file the agent writes, so each writable class can back up and restore. */
const FILES = ['snapshot', 'restore']

/** Every agent this fixture knows, as View.agents lists them. */
const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    detected: true,
    kinds: [...KINDS],
    supports: {
      plugins: ['move', 'remove', 'setEnabled', 'clearOverride', 'uninstall', 'update', 'updateAll', 'refreshMarketplaces', ...FILES],
      skills: ['move', 'remove', 'update', 'updateAll', ...FILES],
      agents: ['move', 'remove', ...FILES],
      mcp: ['move', 'remove', 'update', 'updateAll', ...FILES],
      hooks: ['move', 'remove', ...FILES],
    },
    configHome: '~/.claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    detected: true,
    kinds: [...KINDS],
    supports: {
      skills: ['move', 'remove', ...FILES],
      mcp: ['move', 'remove', ...FILES],
    },
    configHome: '~/.codex',
    note: 'Plugins, agents and hooks are read-only: this app does not edit config.toml or hooks.json yet.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    detected: true,
    kinds: ['plugins', 'mcp'],
    supports: {
      plugins: ['setEnabled', ...FILES],
      mcp: ['move', 'remove', ...FILES],
    },
    configHome: '~/.gemini',
    note: 'Extensions show as plugins; turn them on and off here, install and update them with gemini extensions.',
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    detected: false,
    kinds: ['plugins', 'skills', 'agents', 'mcp'],
    supports: {},
    configHome: '~/.copilot',
  },
]

/** Read-only classes: nothing moves or is removed, whatever the panel sends. */
const readOnly = { movable: false, notMovableReason: 'Read-only for this agent.', removable: false }

function codexItems() {
  const a = 'codex'
  const ext = (id, version, enabled) => ({ ...plugin(id, version, enabled, {}, null, 'user', a), ...readOnly })
  return [
    ext('github@openai-curated', '0.3.1', true),
    ext('linear@openai-curated', '0.2.0', false),
    simple('skills', 'openai-docs', 'Look up the OpenAI API reference and cite the page it came from.', null, 'user', {}, a),
    simple('skills', 'pr-summary', 'Summarise a pull request: what changed, why, and what to check.', null, 'user', {}, a),
    simple('skills', 'release-checklist', 'The steps to cut a gateway release, with the checks before each tag.', P_API, 'project', {}, a),
    simple('agents', 'reviewer', 'Reviews the current diff for bugs before you commit.', null, 'user', readOnly, a),
    simple('agents', 'explorer', 'Maps an unfamiliar module and reports the entry points.', null, 'user', readOnly, a),
    simple('mcp', 'context7', '', null, 'user', { mcp: { transport: 'stdio', target: npxContext7('2.2.5') } }, a),
    simple('mcp', 'figma', '', null, 'user', { mcp: { transport: 'http', target: 'https://mcp.figma.com/mcp' } }, a),
    simple('hooks', 'Stop', '', null, 'user', { ...readOnly, hook: { event: 'Stop', matcher: '', command: 'say "Codex is done"' } }, a),
  ]
}

function geminiItems() {
  const a = 'gemini'
  const ext = (id, version, enabled) => ({ ...plugin(id, version, enabled, {}, null, 'user', a), movable: false, notMovableReason: 'Extensions are installed per user.' })
  return [
    ext('conductor', '0.3.0', true),
    ext('security', '0.4.1', false),
    ext('code-review', '0.1.0', true),
    simple('mcp', 'github', '', null, 'user', { mcp: { transport: 'http', target: 'https://api.githubcopilot.com/mcp/' } }, a),
    simple('mcp', 'context7', '', null, 'user', { mcp: { transport: 'stdio', target: npxContext7('2.2.5') } }, a),
    simple('mcp', 'playwright', '', P_STORE, 'project', { mcp: { transport: 'stdio', target: 'npx @playwright/mcp@latest' } }, a),
  ]
}

const SEEDS = { claude: seedItems, codex: codexItems, gemini: geminiItems, copilot: () => [] }
/** The files each agent always has a version for, even with no items in them. */
const BASE_FILES = { claude: [USER_SETTINGS, CLAUDE_JSON], codex: [CODEX_CONFIG], gemini: [GEMINI_SETTINGS], copilot: [] }

const npxContext7 = (version) => `npx -y --package=@upstash/context7-mcp@${version} -- context7-mcp`

/** What the remote side has now, by plugin id, skill name or npm package. Absent = unknown. */
const LATEST = {
  'feature-dev@claude-plugins-official': '1.7.0',
  'code-review@claude-plugins-official': '1.4.2',
  'commit-commands@claude-plugins-official': '1.1.0',
  'pr-review-toolkit@claude-plugins-official': '2.1.0',
  'security-guidance@claude-plugins-official': '0.3.0',
  'frontend-design@claude-plugins-official': '1.0.4',
  'explanatory-output-style@claude-plugins-official': '1.0.0',
  'plugin-dev@claude-plugins-official': '0.4.1',
  'agent-sdk-dev@claude-plugins-official': '1.2.0',
  'code-review@acme-tools': '0.9.2',
  'deploy-helpers@acme-tools': '3.2.0',
  'k8s-tools@acme-tools': '2.4.0',
  'sql-assistant@acme-tools': '1.0.0',
  'obsidian-sync@community-hub': '0.2.3',
  'tmux-pilot@community-hub': '0.7.1',
  'rust-analyzer-lsp@community-hub': '1.0.0',
  'playwright-mcp@community-hub': '0.0.41',
  pdf: 'b71e0c9a4d2f83e6150c7a9d4be2f61c0a3d58e7',
  docx: '4c2a91f07e3db6a85c19f2e0d7b4a3c6e18f9d02',
  tdd: 'f3b8a0d6c2e91475b0a7d3c8e6f12b9a4d5c07e3',
  grilling: '7a1c4e9d0b5f2368a4c7e1d9b0f53a2c6e8d1b47',
  '@upstash/context7-mcp': '2.3.1',
}

/** Sources the check cannot answer for, with the reason (one network error, one missing version). */
const RATE_LIMITED = 'greensock/gsap-skills'
const CHECK_ERRORS = [`${RATE_LIMITED}: GitHub rate limit reached (60 requests per hour); try again in 41 min.`]
const NO_VERSION = (marketplace) => `${marketplace} does not declare a version for this plugin; the update itself reports what changed.`

/** The plugin whose update runs a marketplace-declared command, and the sha256 of that command. */
const NEEDS_APPROVAL = 'deploy-helpers@acme-tools'
const APPROVAL_COMMAND =
  'bash -c \'curl -fsSL https://raw.githubusercontent.com/acme-tools/deploy-helpers/v3.2.0/scripts/postinstall.sh | sh -s -- --install-dir "$CLAUDE_PLUGIN_ROOT/bin" --verify-signature --keyring ~/.config/acme/keyring.gpg\''
const APPROVAL_SHA = '5f0c2e8a9b41d736e0a2c95f18b7d4e3a6c09f2b8e51d7a4c3b60e9f2d18a7c5'

const clone = (value) => JSON.parse(JSON.stringify(value))
const basename = (path) => path.split('/').filter(Boolean).pop()
const where = (project) => (project ? basename(project) : 'Global')

/** One agent's setup in memory: its items, file versions and backups. */
function createStore(agent, { variant, now }) {
  let items = variant === 'empty' ? [] : SEEDS[agent.id]()
  let rev = 1
  let seq = 0
  /** name -> { entry, items } */
  const backups = new Map()

  const t0 = now()
  if (variant !== 'empty' && agent.id === 'claude') {
    for (const [target, ago] of [[USER_SETTINGS, 2 * 3600e3], [`${P_STORE}/.claude/settings.json`, 26 * 3600e3], [CLAUDE_JSON, 5 * 86400e3]]) {
      addBackup(target, t0 - ago, clone(items))
    }
  }

  function addBackup(target, at, snapshot) {
    const name = `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${++seq}-${basename(target)}`
    backups.set(name, { entry: { name, target, at }, items: snapshot })
    return name
  }

  function files() {
    const set = new Set(BASE_FILES[agent.id])
    for (const item of items) if (item.kind !== 'skills' && item.kind !== 'agents') set.add(item.source)
    return [...set].sort()
  }

  function view() {
    return {
      agents: clone(AGENTS),
      agent: agent.id,
      items: clone(items),
      projects: [...PROJECTS],
      versions: Object.fromEntries(files().map((f) => [f, `r${rev}`])),
      backups: [...backups.values()].map((b) => b.entry).sort((a, b) => b.at - a.at),
      problems: variant === 'empty' || agent.id !== 'claude' ? [] : [`${P_API}/.claude/settings.local.json: "enabledPlugins" names agent-sdk-dev@old-market, which is not installed.`],
    }
  }

  const viewAnswer = () => ({ ok: true, view: view() })
  const find = (key) => items.find((i) => i.key === key)
  const fail = (reason, message) => ({ ok: false, reason, message })

  /** Backs up before a change, like the real backend; returns the restore action for undo. */
  function backupBefore(target) {
    return { type: 'restore', name: addBackup(target, now(), clone(items)) }
  }

  function move(item, to, copy) {
    const project = to.project ?? null
    const scope = project === null ? 'user' : item.kind === 'skills' || item.kind === 'agents' ? 'project' : (to.scope ?? 'local')
    if (project === item.project && scope === item.scope) return fail('same_place', `${item.name} is already there.`)
    const undo = backupBefore(item.source)
    const verb = copy ? 'Copied' : 'Moved'
    let warning
    if (scope === 'project') warning = `Team items live in files that are usually committed: ${where(project)} shares this with everyone on the project.`

    if (item.kind === 'plugins') {
      const id = item.plugin.id
      const existing = items.find((i) => i.kind === 'plugins' && i.plugin.id === id && i.project === project)
      if (project === null) {
        if (existing) existing.plugin.enabled = true
        else items.push(plugin(id, item.plugin.version, true, item.plugin.contributes, null, 'user', agent.id))
        if (!copy) items = items.filter((i) => i !== item)
        linkSharedNames(items)
        return { ok: true, message: `${verb} ${item.name} to Global: on everywhere${copy ? '' : `, override in ${where(item.project)} cleared`}.`, undo, warning }
      }
      if (existing) items = items.filter((i) => i !== existing)
      items.push(plugin(id, item.plugin.version, true, item.plugin.contributes, project, scope, agent.id))
      if (!copy) {
        if (item.project === null) item.plugin.enabled = false
        else items = items.filter((i) => i !== item)
      }
      linkSharedNames(items)
      const off = !copy && item.project === null ? ' and off globally' : ''
      return { ok: true, message: `${verb} ${item.name} to ${where(project)}: on there${off}.`, undo, warning }
    }

    const clash = items.find((i) => i.kind === item.kind && i.name === item.name && i.project === project && i.scope === scope)
    if (clash) {
      backups.delete(undo.name)
      return fail('exists', `${where(project)} already has ${item.kind === 'mcp' ? 'an MCP server' : `a ${item.kind.slice(0, -1)}`} named ${item.name}. Remove or rename it first.`)
    }
    const next = {
      ...clone(item),
      project,
      scope,
      key: keyFor(item.kind, item.name, project, scope, agent.id),
      source: sourceFor(item.kind, item.name, project, scope, agent.id),
    }
    if (!copy) items = items.filter((i) => i !== item)
    items.push(next)
    return { ok: true, message: `${verb} ${item.name} to ${where(project)}.`, undo, warning }
  }

  const latestFor = (item) => LATEST[item.kind === 'plugins' ? item.plugin.id : item.kind === 'mcp' ? item.updateSource.label : item.name]

  function checkUpdates() {
    const statuses = {}
    for (const item of items) {
      const source = item.updateSource
      if (!source || source.type === 'manual') continue
      if (source.label === RATE_LIMITED) {
        statuses[item.key] = { status: 'unknown', latest: null, note: 'GitHub rate limit reached; check again later.' }
        continue
      }
      const latest = latestFor(item) ?? null
      if (latest === null) statuses[item.key] = { status: 'unknown', latest: null, note: NO_VERSION(source.label) }
      else statuses[item.key] = { status: latest === source.current ? 'current' : 'available', latest }
    }
    return { checkedAt: now(), statuses, errors: variant === 'empty' || agent.id !== 'claude' ? [] : [...CHECK_ERRORS] }
  }

  const short = (v) => (/^[0-9a-f]{12,}$/.test(v) ? v.slice(0, 7) : v)

  /** Updates one item in place; the same path serves 'update' and each step of 'updateAll'. */
  function updateOne(item, acceptCommand) {
    const source = item.updateSource
    if (!source) return fail('no_source', `${item.name} has no update source; it is a local file.`)
    if (source.type === 'manual') return fail('manual', `${item.name} is updated by ${source.label}: run ${source.note}.`)
    const latest = latestFor(item)
    if (!latest) return fail('unknown', `Could not reach ${source.label} for ${item.name}.`)
    if (latest === source.current) return { ok: true, message: `${item.name} is already up to date.` }
    if (item.kind === 'plugins' && item.plugin.id === NEEDS_APPROVAL && acceptCommand !== APPROVAL_SHA) {
      return {
        ok: false,
        reason: 'needs_approval',
        message: `${item.name} ${latest} runs a command from ${source.label} when it installs. Nothing runs until you approve it.`,
        confirm: { command: APPROVAL_COMMAND, action: { type: 'update', key: item.key, acceptCommand: APPROVAL_SHA } },
      }
    }
    const from = source.current
    if (item.kind === 'plugins') {
      backupBefore(USER_SETTINGS)
      item.plugin.version = latest
      source.current = latest
      return { ok: true, message: `Updated ${item.name} ${from} → ${latest}. Restart Claude Code to load the new version.` }
    }
    if (item.kind === 'mcp') {
      backupBefore(CLAUDE_JSON)
      item.mcp.target = npxContext7(latest)
      source.current = latest
      return { ok: true, message: `Updated ${item.name} to ${source.label} ${latest} (removed and added again in the same scope).` }
    }
    source.current = latest
    return { ok: true, message: `Updated ${item.name} from ${source.label} (${short(from)} → ${short(latest)}).` }
  }

  function updateAll(kind, keys) {
    const lines = []
    const skipped = []
    let updated = 0
    for (const key of keys) {
      const item = find(key)
      if (!item || item.kind !== kind) {
        lines.push(`${key}: not found; refresh and check again.`)
        continue
      }
      const result = updateOne(item)
      if (result.ok) updated++
      if (result.confirm) skipped.push(item.name)
      else lines.push(result.ok ? result.message.replace(/ Restart Claude Code to load the new version\.$/, '') : `${item.name}: ${result.message}`)
    }
    const what = kind === 'plugins' ? 'plugins' : kind === 'mcp' ? 'MCP servers' : kind
    const restart = kind === 'plugins' && updated > 0 ? '\nRestart Claude Code to load the new versions.' : ''
    const message = `Updated ${updated} of ${keys.length} ${what}.\n${lines.join('\n')}${restart}`
    const warning = skipped.length
      ? `${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} not updated: ${skipped.length === 1 ? 'it runs' : 'they run'} a command from the marketplace. Use Update on ${skipped.length === 1 ? 'it' : 'each'} to review the command.`
      : undefined
    return updated > 0 || keys.length === 0 ? { ok: true, message, warning } : { ok: false, reason: 'none_updated', message: [message, warning].filter(Boolean).join('\n') }
  }

  function run(action) {
    switch (action.type) {
      case 'refreshMarketplaces': {
        const names = [...new Set(items.filter((i) => i.kind === 'plugins').map((i) => i.plugin.id.slice(i.plugin.id.lastIndexOf('@') + 1)))]
        return { ok: true, message: `Refreshed ${names.length} marketplaces: ${names.join(', ')}.` }
      }
      case 'updateAll':
        return updateAll(action.kind, action.keys ?? [])
      case 'snapshot': {
        const at = now()
        const targets = files()
        const snapshot = clone(items)
        for (const target of targets) addBackup(target, at, snapshot)
        return { ok: true, message: `Backed up ${targets.length} settings files.` }
      }
      case 'restore': {
        const backup = backups.get(action.name)
        if (!backup) return fail('missing', 'That backup no longer exists. Refresh to see the current list.')
        const undo = backupBefore(backup.entry.target)
        items = clone(backup.items)
        return { ok: true, message: `Restored ${basename(backup.entry.target)} from ${new Date(backup.entry.at).toLocaleString()}.`, undo }
      }
    }
    const item = find(action.key)
    if (!item) return fail('missing', 'That item is gone; it may have changed on disk. The list is refreshed.')
    switch (action.type) {
      case 'move':
        if (!item.movable) return fail('not_movable', item.notMovableReason ?? `${item.name} cannot be moved.`)
        return move(item, action.to, action.copy)
      case 'setEnabled': {
        if (!item.plugin) return fail('invalid', 'Only plugins have a switch.')
        backupBefore(item.source)
        item.plugin.enabled = action.enabled
        return {
          ok: true,
          message: `Turned ${action.enabled ? 'on' : 'off'} ${item.name} in ${where(item.project)}.`,
          undo: { type: 'setEnabled', key: item.key, enabled: !action.enabled },
        }
      }
      case 'clearOverride': {
        if (!item.plugin || item.project === null) return fail('invalid', 'Only project plugins have an override.')
        const undo = backupBefore(item.source)
        items = items.filter((i) => i !== item)
        return { ok: true, message: `Cleared the override for ${item.name} in ${where(item.project)}; it follows Global again.`, undo }
      }
      case 'remove': {
        if (!item.removable) return fail('not_removable', `${item.name} cannot be removed here.`)
        const undo = backupBefore(item.source)
        items = items.filter((i) => i !== item)
        const trash = item.kind === 'skills' || item.kind === 'agents' ? ' It is in the trash and can be restored.' : ''
        return { ok: true, message: `Removed ${item.name} from ${where(item.project)}.${trash}`, undo }
      }
      case 'uninstall': {
        if (!item.plugin?.installed) return fail('not_installed', `${item.name} is not installed.`)
        backupBefore(USER_SETTINGS)
        const id = item.plugin.id
        items = linkSharedNames(items.filter((i) => !(i.kind === 'plugins' && i.plugin.id === id)))
        return { ok: true, message: `Uninstalled ${id}.`, warning: 'Uninstall cannot be undone here; reinstall it with claude plugin install.' }
      }
      case 'update':
        return updateOne(item, action.acceptCommand)
      default:
        return fail('unknown_action', `Unknown action "${action.type}".`)
    }
  }

  /** The class an action acts on; null for actions over every file (snapshot, restore). */
  function kindOf(action) {
    if (action.type === 'updateAll') return action.kind
    if (action.type === 'refreshMarketplaces') return 'plugins'
    if (action.type === 'snapshot' || action.type === 'restore') return null
    return find(action.key)?.kind ?? null
  }

  /** Refuses what the agent does not support, as a real provider would, before touching anything. */
  function refusal(action) {
    const kind = kindOf(action)
    const lists = kind ? [agent.supports[kind] ?? []] : Object.values(agent.supports)
    if (lists.some((list) => list.includes(action.type))) return null
    if (kind === null && action.key) return null // a missing item: run() reports it
    const what = kind ? `${kind === 'mcp' ? 'MCP servers' : kind}` : 'backups'
    return fail('unsupported', `${agent.name} does not support "${action.type}" for ${what} in this app.`)
  }

  function act(input) {
    const current = view().versions
    const sent = input?.versions ?? {}
    const stale = Object.keys(current).some((f) => sent[f] !== undefined && sent[f] !== current[f])
    if (stale) return { result: fail('stale', 'Your settings changed since this list was read. The list is refreshed; try again.'), view: viewAnswer() }
    const result = refusal(input.action) ?? run(input.action)
    if (result.ok && input.action.type !== 'snapshot' && input.action.type !== 'refreshMarketplaces') rev++
    return { result, view: viewAnswer() }
  }

  return { viewAnswer, act, checkUpdates }
}

export function createFixtureBackend({ variant = 'default', latency = 150, now = () => Date.now() } = {}) {
  const stores = new Map(AGENTS.map((agent) => [agent.id, createStore(agent, { variant, now })]))
  /** Without an agent, the first detected one, as the real backend does. */
  const defaultAgent = AGENTS.find((a) => a.detected).id
  const storeFor = (input) => stores.get(input?.agent ?? defaultAgent)
  const unknown = (input) => `Unknown agent "${input?.agent}".`

  function handle(name, input) {
    const store = storeFor(input)
    if (name === 'view.get') {
      if (variant === 'error') return { ok: false, error: `Could not read ${USER_SETTINGS}: Unexpected token } in JSON at position 812.` }
      return store ? store.viewAnswer() : { ok: false, error: unknown(input) }
    }
    if (name === 'action.run') {
      if (!store) return { result: { ok: false, reason: 'unknown_agent', message: unknown(input) }, view: { ok: false, error: unknown(input) } }
      return store.act(input)
    }
    if (name === 'updates.check') {
      if (!store) throw Object.assign(new Error(unknown(input)), { code: 'unknown_agent' })
      return store.checkUpdates()
    }
    throw Object.assign(new Error(`No handler named ${name}`), { code: 'unknown_method' })
  }

  /** Every request in order, as sent: { name, input }. */
  const requests = []

  return {
    requests,
    request(name, input) {
      requests.push({ name, input: clone(input ?? {}) })
      // The check goes to the network in the real backend, so it takes a little longer here too.
      const delay = name === 'updates.check' ? latency * 3 + 250 : latency
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(handle(name, input))
          } catch (error) {
            reject(error)
          }
        }, delay)
      })
    },
  }
}
