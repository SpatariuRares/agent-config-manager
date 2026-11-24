// In-memory backend for the panel outside Orca (and for the Playwright tests).
// It answers the same contract as the worker: 'view.get' -> ViewAnswer, 'action.run' -> ActionAnswer.
// The data is synthetic; nothing here reads or writes the real disk.

const HOME = '/Users/you'
const P_STORE = `${HOME}/code/storefront`
const P_API = `${HOME}/code/api-gateway`
const P_NOTES = `${HOME}/code/notes`
const PROJECTS = [P_API, P_NOTES, P_STORE]

const USER_SETTINGS = `${HOME}/.claude/settings.json`
const CLAUDE_JSON = `${HOME}/.claude.json`

const settingsFile = (project, scope) =>
  project === null ? USER_SETTINGS : `${project}/.claude/${scope === 'local' ? 'settings.local.json' : 'settings.json'}`

function sourceFor(kind, name, project, scope) {
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
}

function keyFor(kind, name, project, scope) {
  const source = sourceFor(kind, name, project, scope)
  const shared = kind === 'plugins' || kind === 'mcp' || kind === 'hooks'
  return shared ? `${kind}:${source}#${project ?? '~'}#${name}` : `${kind}:${source}`
}

const none = () => ({ skills: [], agents: [], commands: [], hooks: [], mcpServers: [] })

function plugin(id, version, enabled, contributes = {}, project = null, scope = 'user') {
  const name = id.slice(0, id.lastIndexOf('@'))
  return {
    key: keyFor('plugins', id, project, scope),
    kind: 'plugins',
    name,
    description: '',
    project,
    scope,
    source: sourceFor('plugins', id, project, scope),
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
  }
}

function simple(kind, name, description, project = null, scope = project ? 'project' : 'user', extra = {}) {
  return {
    key: keyFor(kind, name, project, scope),
    kind,
    name,
    description,
    project,
    scope,
    source: sourceFor(kind, name, project, scope),
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
    simple('skills', 'pdf', 'Extract text and tables from PDF files, fill forms, merge and split documents. Use when the user works with any .pdf file.'),
    simple('skills', 'docx', 'Create and edit Word documents with tracked changes, comments and styles.'),
    simple('skills', 'tdd', 'Test-driven development: write the failing test first, make it pass, then refactor while the tests stay green. Use when the user asks for red-green-refactor or wants integration tests before the fix.'),
    simple('skills', 'grilling', 'Stress-test a plan by asking hard questions one at a time.'),
    simple('skills', 'humanize-writing', 'Remove signs of AI-generated writing: inflated significance, formulaic structure, hedging and robotic rhythm.'),
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
    simple('mcp', 'context7', '', null, 'user', { mcp: { transport: 'http', target: 'https://mcp.context7.com/mcp' } }),
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

const clone = (value) => JSON.parse(JSON.stringify(value))
const basename = (path) => path.split('/').filter(Boolean).pop()
const where = (project) => (project ? basename(project) : 'Global')

export function createFixtureBackend({ variant = 'default', latency = 150, now = () => Date.now() } = {}) {
  let items = variant === 'empty' ? [] : seedItems()
  let rev = 1
  let seq = 0
  /** name -> { entry, items } */
  const backups = new Map()

  const t0 = now()
  if (variant !== 'empty') {
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
    const set = new Set([USER_SETTINGS, CLAUDE_JSON])
    for (const item of items) if (item.kind !== 'skills' && item.kind !== 'agents') set.add(item.source)
    return [...set].sort()
  }

  function view() {
    return {
      items: clone(items),
      projects: [...PROJECTS],
      versions: Object.fromEntries(files().map((f) => [f, `r${rev}`])),
      backups: [...backups.values()].map((b) => b.entry).sort((a, b) => b.at - a.at),
      problems: variant === 'empty' ? [] : [`${P_API}/.claude/settings.local.json: "enabledPlugins" names agent-sdk-dev@old-market, which is not installed.`],
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
        else items.push(plugin(id, item.plugin.version, true, item.plugin.contributes))
        if (!copy) items = items.filter((i) => i !== item)
        linkSharedNames(items)
        return { ok: true, message: `${verb} ${item.name} to Global: on everywhere${copy ? '' : `, override in ${where(item.project)} cleared`}.`, undo, warning }
      }
      if (existing) items = items.filter((i) => i !== existing)
      items.push(plugin(id, item.plugin.version, true, item.plugin.contributes, project, scope))
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
    const next = { ...clone(item), project, scope, key: keyFor(item.kind, item.name, project, scope), source: sourceFor(item.kind, item.name, project, scope) }
    if (!copy) items = items.filter((i) => i !== item)
    items.push(next)
    return { ok: true, message: `${verb} ${item.name} to ${where(project)}.`, undo, warning }
  }

  function run(action) {
    switch (action.type) {
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
      default:
        return fail('unknown_action', `Unknown action "${action.type}".`)
    }
  }

  function handle(name, input) {
    if (name === 'view.get') {
      if (variant === 'error') return { ok: false, error: `Could not read ${USER_SETTINGS}: Unexpected token } in JSON at position 812.` }
      return viewAnswer()
    }
    if (name === 'action.run') {
      const current = view().versions
      const sent = input?.versions ?? {}
      const stale = Object.keys(current).some((f) => sent[f] !== undefined && sent[f] !== current[f])
      if (stale) return { result: fail('stale', 'Your settings changed since this list was read. The list is refreshed; try again.'), view: viewAnswer() }
      const result = run(input.action)
      if (result.ok && input.action.type !== 'snapshot') rev++
      return { result, view: viewAnswer() }
    }
    throw Object.assign(new Error(`No handler named ${name}`), { code: 'unknown_method' })
  }

  return {
    request(name, input) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(handle(name, input))
          } catch (error) {
            reject(error)
          }
        }, latency)
      })
    },
  }
}
