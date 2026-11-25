// Gemini CLI's writes. Every change goes through the `gemini` CLI by argv, after a version check of each file the
// CLI will touch and a backup of it; then the file is read again to prove the change happened, since several
// gemini subcommands print an error and still exit 0. The only direct writes are restore and snapshot (backups).
import { createHash } from 'node:crypto'
import type { Action, ActionRequest, ActionResult } from '../../adapters/view.ts'
import {
  admitMcp,
  backUp,
  backupTarget,
  isObject,
  isTrashName,
  itemKey,
  listBackups,
  optionLikeRefusal,
  redactCommand,
  redactUrl,
  restoreFile,
  shellQuote,
  tilde,
  urlHasSecret,
  versionOf,
  type Admitted,
  type Clock,
  type Json,
  type ProviderDeps
} from '../toolkit.ts'
import { GEMINI_ADD, GEMINI_ADD_TEAM } from './mcp-add.ts'
import { projectSettings, settingsOf, type GeminiPaths } from './paths.ts'
import { extensionEnabled, geminiMcpConfig, readSetup, rulesFor, stripComments, type Extension, type McpServer, type Setup } from './read.ts'

type Done = ActionResult & { ok: true }
type Refused = ActionResult & { ok: false }

export const done = (message: string, undo?: Action, warning?: string): Done => ({ ok: true, message, ...(undo ? { undo } : {}), ...(warning ? { warning } : {}) })
export const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message })
const CHANGED = refuse('changed', 'A Gemini CLI settings file changed since it was read. Refresh and try again.')
const GONE = refuse('changed', 'That item is no longer there. The view was refreshed; try again.')

/** The last lines of a CLI's output, for messages, with anything secret-looking redacted. */
const tail = (output: string) => redactCommand(output.trim().split('\n').slice(-3).join(' ').slice(0, 400))

/**
 * How a message names a run: the subcommand and what it acted on (`gemini mcp add for context7`). Never the whole
 * argv: its values (args, urls, descriptions) can hold tokens.
 */
const named = (argv: string[], subject: string) => `gemini ${argv.slice(0, 2).join(' ')} for ${subject}`

/** A JSON (or JSONC) file as an object; null when it exists but is not one. */
async function objectAt(deps: ProviderDeps, file: string, comments: boolean): Promise<Json | null> {
  const text = await deps.fs.readText(file)
  if (text === null) return {}
  try {
    const value = JSON.parse(comments ? stripComments(text) : text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export interface Context {
  deps: ProviderDeps
  paths: GeminiPaths
  clock: Clock
  versions: Record<string, string>
  say: (path: string) => string
}

/** Refuses when any file changed since the view read it; otherwise backs up each one that exists. */
export async function guard(ctx: Context, files: string[]): Promise<{ ok: true; backups: Map<string, string> } | Refused> {
  const texts = new Map<string, string | null>()
  for (const file of files) {
    const text = await ctx.deps.fs.readText(file)
    if (versionOf(text) !== (ctx.versions[file] ?? '')) return CHANGED
    texts.set(file, text)
  }
  const backups = new Map<string, string>()
  for (const [file, text] of texts) {
    if (text !== null) backups.set(file, await backUp(ctx.deps.fs, ctx.paths.backups, file, text, ctx.clock))
  }
  return { ok: true, backups }
}

/** Runs `gemini <argv>` (never a shell) in `cwd`; a failure becomes a refusal naming the command and its subject. */
export async function gemini(
  ctx: Context,
  argv: string[],
  subject: string,
  cwd: string | null,
  options?: { timeoutMs?: number; closeStdin?: boolean }
): Promise<{ ok: true; output: string } | Refused> {
  const result = await ctx.deps.exec.run('gemini', argv, cwd, options)
  if (!result.ok) return refuse('cli', `${named(argv, subject)} failed: ${tail(result.output) || 'no output'}`)
  return { ok: true, output: result.output }
}

/** The question Gemini CLI asks on stdin before it accepts new permissions (requestConsentNonInteractive). */
const CONSENT_PROMPT = /Do you want to (continue|trust this folder)|\[Y\/n\]|\[y\/N\]/

export const unchanged = (argv: string[], subject: string, file: string, output: string, say: (path: string) => string) =>
  refuse('cli', `${named(argv, subject)} did not change ${say(file)}: ${tail(output) || 'no output'}`)

const restoreOf = (backup: string | undefined): Action | undefined => (backup ? { type: 'restore', name: backup.slice(backup.lastIndexOf('/') + 1) } : undefined)

/** Every file this app may change for Gemini CLI: the ones the CLI writes for the actions it offers. */
const writable = (paths: GeminiPaths, setup: Setup) => [paths.settings, ...setup.projects.map(projectSettings), paths.enablement, paths.mcpEnablement]

/** What every write here works with: the deps, the paths, the view's versions, and `say` for paths in messages. */
export const contextOf = (deps: ProviderDeps, paths: GeminiPaths, versions: Record<string, string>): Context => ({
  deps,
  paths,
  clock: deps.clock ?? (() => new Date()),
  versions,
  say: (path) => tilde(paths.home, path)
})

export async function geminiAction(deps: ProviderDeps, paths: GeminiPaths, request: ActionRequest): Promise<ActionResult> {
  const ctx = contextOf(deps, paths, request.versions)
  const { action } = request
  const setup = await readSetup(deps.fs, paths)

  if (action.type === 'snapshot') {
    const backups: string[] = []
    for (const file of writable(paths, setup)) {
      const text = await deps.fs.readText(file)
      if (text !== null) backups.push(await backUp(deps.fs, paths.backups, file, text, ctx.clock))
    }
    return done(`Backed up ${backups.length} Gemini CLI settings file${backups.length === 1 ? '' : 's'}.`)
  }
  if (action.type === 'restore') {
    const target = isTrashName(action.name) ? null : backupTarget(paths.backups, action.name)
    if (target === null) return refuse('unknown-backup', `${action.name} is not a known backup.`)
    if (isInstallRecord(paths, target)) return reinstallExtension(ctx, action.name, target, action.acceptCommand)
    const allowed = writable(paths, setup)
    const restored = await restoreFile(deps.fs, paths.backups, { name: action.name, version: request.versions[target] ?? '' }, ctx.clock, async (file) =>
      allowed.includes(file) ? null : refuse('refused', `${ctx.say(file)} is not a file this app changes for Gemini CLI.`)
    )
    if (!restored.ok) return restored
    return done(`Restored ${ctx.say(target)} from its backup.`, restoreOf(restored.backup))
  }

  const key = (action as { key?: unknown }).key
  const ref = typeof key === 'string' ? setup.refs.get(key) : undefined
  if (ref === undefined || typeof key !== 'string') return GONE

  if (ref.kind === 'plugins') {
    const { extension, project } = ref
    const named = optionLikeRefusal(extension.name, 'The extension name')
    if (named) return refuse('refused', named.output)
    if (action.type === 'setEnabled') return toggleExtension(ctx, setup, key, extension, project, ref.enabled, action.enabled)
    if (action.type === 'uninstall' && project === null) return uninstallExtension(ctx, extension)
    if (action.type === 'update' && project === null) return updateExtension(ctx, extension)
    return refuse('unsupported', `Gemini CLI cannot do "${action.type}" on ${extension.name} there; use its Global item.`)
  }
  if (ref.kind === 'mcp') {
    const { server } = ref
    const named = optionLikeRefusal(server.name, 'The server name')
    if (named) return refuse('refused', named.output)
    const place = setup.places.find((p) => p.file === server.file)
    if (place?.broken) return refuse('unreadable', `${ctx.say(server.file)} is not valid JSON; it was left untouched.`)
    if (action.type === 'setEnabled') return toggleMcp(ctx, key, server, ref.blocked, ref.enabled, action.enabled)
    if (action.type === 'remove') return removeMcp(ctx, server)
    if (action.type === 'move') return moveMcp(ctx, setup, server, action.to, action.copy)
  }
  return refuse('unsupported', `Gemini CLI cannot do "${action.type}" on that item here.`)
}

// ------------------------------------------------------------------------------------------------- extensions

async function toggleExtension(ctx: Context, setup: Setup, key: string, extension: Extension, project: string | null, current: boolean, enabled: boolean) {
  const { paths } = ctx
  const folder = project ?? paths.home
  const where = project === null ? 'globally' : `in ${ctx.say(project)}`
  if (current === enabled) return done(`${extension.name} is already ${enabled ? 'on' : 'off'} ${where}.`)
  if ((await objectAt(ctx.deps, paths.enablement, false)) === null) return refuse('unreadable', `${ctx.say(paths.enablement)} is not valid JSON; it was left untouched.`)
  const guarded = await guard(ctx, [paths.enablement])
  if (!guarded.ok) return guarded
  // `--scope user` writes a rule for the home folder, `--scope workspace` one for the folder it runs in.
  const argv = ['extensions', enabled ? 'enable' : 'disable', '--scope', project === null ? 'user' : 'workspace', extension.name]
  const ran = await gemini(ctx, argv, extension.name, project)
  if (!ran.ok) return ran
  const after = await objectAt(ctx.deps, paths.enablement, false)
  if (after === null || extensionEnabled(after, extension.name, folder) !== enabled) return unchanged(argv, extension.name, paths.enablement, ran.output, ctx.say)
  // A rule for a folder replaces the rules of the folders inside it (Override.isChildOf).
  const cleared = setup.projects.filter(
    (other) => other !== project && rulesFor(setup.enablement, extension.name, other).length > 0 && rulesFor(after, extension.name, other).length === 0
  )
  const warning = cleared.length > 0 ? `Gemini CLI also cleared the ${extension.name} override in ${cleared.map(ctx.say).join(', ')}.` : undefined
  return done(`Turned ${extension.name} ${enabled ? 'on' : 'off'} ${where}. Restart Gemini CLI sessions to apply it.`, { type: 'setEnabled', key, enabled: !enabled }, warning)
}

async function uninstallExtension(ctx: Context, extension: Extension) {
  const guarded = await guard(ctx, [ctx.paths.enablement])
  if (!guarded.ok) return guarded
  // The install record says where the extension came from. Backed up before the uninstall deletes it, it is what
  // the undo reinstalls from (reinstallExtension), when `gemini extensions install` can use it.
  const recordFile = `${extension.dir}/${INSTALL_RECORD}`
  const record = await ctx.deps.fs.readText(recordFile)
  const reinstallable = record !== null && reinstallArgv(record) !== null
  const recordBackup = reinstallable ? await backUp(ctx.deps.fs, ctx.paths.backups, recordFile, record, ctx.clock) : null
  const argv = ['extensions', 'uninstall', extension.name]
  const ran = await gemini(ctx, argv, extension.name, null)
  if (!ran.ok) return ran
  if ((await ctx.deps.fs.realPath(extension.dir)) !== null) return unchanged(argv, extension.name, extension.dir, ran.output, ctx.say)
  const source = extension.install.source
  const again = source ? ` To install it again: ${shellQuote(['gemini', 'extensions', 'install', source.startsWith('/') ? source : redactUrl(source)])}` : ''
  return done(`Uninstalled ${extension.name}.${again}`, restoreOf(recordBackup ?? undefined))
}

/** The file in an extension folder that records its source (ExtensionManager, `gemini extensions install`). */
const INSTALL_RECORD = '.gemini-extension-install.json'

/** Whether a backup target is an extension's install record: restoring it reinstalls the extension. */
const isInstallRecord = (paths: GeminiPaths, target: string) => {
  const inside = target.startsWith(`${paths.extensionsDir}/`) ? target.slice(paths.extensionsDir.length + 1) : ''
  return /^[^/]+\/\.gemini-extension-install\.json$/.test(inside) && !inside.startsWith('.')
}

/**
 * `gemini extensions install <source> [--ref r] [--auto-update] [--pre-release] --consent` for an install record,
 * or null when the record cannot be reinstalled that way: a linked extension (`gemini extensions link`), no source,
 * a source with a credential in it (it would show in the command), or a value that would be read as an option.
 * `--consent` accepts the extension's permissions; it only runs once the user approved this exact command.
 */
function reinstallArgv(text: string): string[] | null {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(record) || !['git', 'github-release', 'local'].includes(String(record.type))) return null
  const { source, ref } = record
  if (typeof source !== 'string' || source === '' || source.startsWith('-') || urlHasSecret(source)) return null
  if (ref !== undefined && (typeof ref !== 'string' || ref === '' || ref.startsWith('-'))) return null
  return [
    'extensions',
    'install',
    source,
    ...(typeof ref === 'string' ? ['--ref', ref] : []),
    ...(record.autoUpdate === true ? ['--auto-update'] : []),
    ...(record.allowPreRelease === true ? ['--pre-release'] : []),
    '--consent'
  ]
}

/**
 * Restoring a backup of an install record: reinstalls the extension from it. Without the approval of this exact
 * command (`acceptCommand` = its sha256), nothing runs and the answer asks for it.
 */
async function reinstallExtension(ctx: Context, name: string, target: string, acceptCommand: string | undefined): Promise<ActionResult> {
  const { fs } = ctx.deps
  const text = (await listBackups(fs, ctx.paths.backups)).includes(name) ? await fs.readText(`${ctx.paths.backups.dir}/${name}`) : null
  if (text === null) return refuse('unknown-backup', `${name} is not a known backup.`)
  const argv = reinstallArgv(text)
  const dir = target.slice(0, target.lastIndexOf('/'))
  const extension = dir.slice(dir.lastIndexOf('/') + 1)
  if (argv === null) return refuse('unsupported', `${name} records no source that gemini extensions install can use, so ${extension} cannot be reinstalled from it.`)
  if ((await fs.realPath(dir)) !== null) return refuse('exists', `${ctx.say(dir)} is there already: ${extension} is installed.`)
  const command = shellQuote(['gemini', ...argv])
  const sha = createHash('sha256').update(command).digest('hex')
  if (acceptCommand !== sha) {
    return {
      ok: false,
      reason: 'needs-confirmation',
      message: `Reinstalling ${extension} runs this command, which accepts the extension's permissions for you. Review it, then confirm.`,
      confirm: { command, action: { type: 'restore', name, acceptCommand: sha } }
    }
  }
  const guarded = await guard(ctx, [ctx.paths.enablement])
  if (!guarded.ok) return guarded
  // stdin is closed: a question the install still asks (trusting a local folder) ends the run instead of hanging.
  const result = await ctx.deps.exec.run('gemini', argv, null, { timeoutMs: 120_000, closeStdin: true })
  if (!result.ok) return refuse('cli', `${named(argv, extension)} failed: ${tail(result.output) || 'no output'}. To try it in a terminal: ${command}`)
  if ((await fs.readText(target)) === null) return unchanged(argv, extension, target, result.output, ctx.say)
  return done(`Reinstalled ${extension} with ${command}.`)
}

async function updateExtension(ctx: Context, extension: Extension) {
  const { type, source } = extension.install
  if (source === null || (type !== 'git' && type !== 'github-release')) {
    return refuse('unsupported', `${extension.name} was installed from ${type ?? 'an unknown source'}; Gemini CLI updates only git and GitHub release extensions.`)
  }
  const guarded = await guard(ctx, [ctx.paths.enablement])
  if (!guarded.ok) return guarded
  const argv = ['extensions', 'update', extension.name]
  // Gemini CLI 0.35.3 has no flag to approve an update's new permissions (`extensions update` takes only a name
  // or --all; only `extensions install` has --consent), and asks on stdin. With stdin closed, that question ends
  // the run at once instead of hanging until the timeout; this app never answers it for the user.
  const result = await ctx.deps.exec.run('gemini', argv, null, { timeoutMs: 120_000, closeStdin: true })
  if (CONSENT_PROMPT.test(result.output)) {
    return refuse(
      'needs-consent',
      `${extension.name} asks to approve new permissions, and this app never approves them for you. To review and approve them, run this in a terminal: ${shellQuote(['gemini', ...argv])}`
    )
  }
  if (!result.ok) {
    return refuse('cli', `${named(argv, extension.name)} failed: ${tail(result.output) || 'no output'}. To see why, run this in a terminal: ${shellQuote(['gemini', ...argv])}`)
  }
  const ran = { output: result.output }
  const manifest = await objectAt(ctx.deps, `${extension.dir}/gemini-extension.json`, false)
  const version = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
  if (version !== null && version !== extension.version) return done(`Updated ${extension.name} from ${extension.version ?? '?'} to ${version}.`)
  if (/up to date|No extensions to update/i.test(ran.output)) return done(`${extension.name} is already up to date.`)
  return refuse('cli', `${named(argv, extension.name)} did not update it: ${tail(ran.output) || 'no output'}`)
}

// ------------------------------------------------------------------------------------------------------- MCP

const mcpState = async (ctx: Context, name: string) => {
  const state = await objectAt(ctx.deps, ctx.paths.mcpEnablement, false)
  if (state === null) return null
  const entry = state[name.toLowerCase().trim()]
  return !(isObject(entry) && entry.enabled === false)
}

async function toggleMcp(ctx: Context, key: string, server: McpServer, blocked: string | null, current: boolean, enabled: boolean) {
  const { paths } = ctx
  if (enabled && blocked !== null) {
    return refuse('refused', `${server.name} is kept off by ${blocked} in settings.json; this app does not edit that list.`)
  }
  if (current === enabled) return done(`${server.name} is already ${enabled ? 'on' : 'off'}.`)
  if ((await mcpState(ctx, server.name)) === null) return refuse('unreadable', `${ctx.say(paths.mcpEnablement)} is not valid JSON; it was left untouched.`)
  const guarded = await guard(ctx, [paths.mcpEnablement])
  if (!guarded.ok) return guarded
  // The CLI looks the name up in the settings of the folder it runs in, so a project's server runs there.
  const argv = ['mcp', enabled ? 'enable' : 'disable', server.name]
  const ran = await gemini(ctx, argv, server.name, server.project)
  if (!ran.ok) return ran
  if ((await mcpState(ctx, server.name)) !== enabled) return unchanged(argv, server.name, paths.mcpEnablement, ran.output, ctx.say)
  return done(
    `Turned ${server.name} ${enabled ? 'on' : 'off'}.`,
    { type: 'setEnabled', key, enabled: !enabled },
    'Gemini CLI turns MCP servers on and off by name, everywhere: every server with this name follows.'
  )
}

export const scopeArg = (project: string | null) => (project === null ? 'user' : 'project')

export const hasServer = async (ctx: Context, file: string, name: string) => {
  const settings = await objectAt(ctx.deps, file, true)
  return settings !== null && isObject(settings.mcpServers) && isObject(settings.mcpServers[name])
}

async function removeMcp(ctx: Context, server: McpServer) {
  const guarded = await guard(ctx, [server.file])
  if (!guarded.ok) return guarded
  const argv = ['mcp', 'remove', '--scope', scopeArg(server.project), server.name]
  const ran = await gemini(ctx, argv, server.name, server.project)
  if (!ran.ok) return ran
  if (await hasServer(ctx, server.file, server.name)) return unchanged(argv, server.name, server.file, ran.output, ctx.say)
  return done(`Removed ${server.name} from ${ctx.say(server.file)}.`, restoreOf(guarded.backups.get(server.file)))
}

type AdmittedServer = Extract<Admitted, { ok: true }>['server']

/**
 * Argv encoding: env and header entries `gemini mcp add` would change. It splits each -e value at "=" and drops
 * empty ones, and trims header values; such entries are refused rather than written changed. Null when none.
 */
export function argvLimits(server: AdmittedServer): string | null {
  const env = Object.entries(server.env ?? {}).filter(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === '' || value.includes('='))
  if (env.length > 0) {
    return `"${server.name}" has env entries gemini mcp add cannot write as they are (${env.map(([key]) => key).join(', ')}): it splits each at "=" and drops empty values.`
  }
  const headers = Object.entries(server.headers ?? {}).filter(([key, value]) => !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || key.startsWith('-') || value.trim() === '' || value !== value.trim())
  if (headers.length > 0) {
    return `"${server.name}" has headers gemini mcp add cannot write as they are (${headers.map(([key]) => key).join(', ')}): it trims values and drops empty ones.`
  }
  return null
}

/**
 * `gemini mcp add` for an admitted server, a move's or an import's: options first (each takes one value), then
 * name and command (args after `--`) or url.
 */
export function addArgv(server: AdmittedServer, project: string | null): string[] {
  const { rest } = server
  const options = [
    ...(typeof rest.timeout === 'number' ? [`--timeout=${rest.timeout}`] : []),
    ...(rest.trust === true ? ['--trust'] : []),
    ...(typeof rest.description === 'string' && rest.description !== '' ? [`--description=${rest.description}`] : [])
  ]
  const env = Object.entries(server.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  const headers = Object.entries(server.headers ?? {}).flatMap(([key, value]) => ['-H', `${key}: ${value}`])
  const tail = server.transport === 'stdio' ? [server.command!, ...(server.args?.length ? ['--', ...server.args] : [])] : [server.url!]
  return ['mcp', 'add', '--scope', scopeArg(project), '--transport', server.transport, ...options, ...env, ...headers, server.name, ...tail]
}

async function moveMcp(ctx: Context, setup: Setup, server: McpServer, to: { project: string | null; scope?: string }, copy: boolean) {
  const destination = to?.project ?? null
  const place = destination === null ? 'Global' : ctx.say(destination)
  if (destination !== null && !setup.projects.includes(destination)) return refuse('unknown-project', `${destination} is not a project Gemini CLI knows.`)
  if (destination !== null && to.scope === 'local') {
    return refuse('refused', 'Gemini CLI has no only-me settings for a project: its .gemini/settings.json is shared. Choose Team.')
  }
  if (destination === server.project) return refuse('same-place', `"${server.name}" is already there.`)
  const admitted = admitMcp(geminiMcpConfig(server.name, server.config), destination === null ? GEMINI_ADD : GEMINI_ADD_TEAM)
  if (!admitted.ok) return admitted.reason === 'secret' ? admitted : refuse('not-movable', admitted.message)
  const limits = argvLimits(admitted.server)
  if (limits !== null) return refuse('not-movable', limits)
  const optionLike = optionLikeRefusal(admitted.server.command ?? admitted.server.url ?? '', 'The command or url')
  if (optionLike) return refuse('refused', optionLike.output)
  const file = settingsOf(ctx.paths, destination)
  const destinationPlace = setup.places.find((p) => p.file === file)
  if (destinationPlace?.broken) return refuse('unreadable', `${ctx.say(file)} is not valid JSON; it was left untouched.`)
  if (await hasServer(ctx, file, server.name)) return refuse('exists', `${place} already has an MCP server named ${server.name}. Rename or remove one of them first.`)

  const guarded = await guard(ctx, copy ? [file] : [file, server.file])
  if (!guarded.ok) return guarded
  const add = addArgv(admitted.server, destination)
  const added = await gemini(ctx, add, server.name, destination)
  if (!added.ok) return added
  if (!(await hasServer(ctx, file, server.name))) return unchanged(add, server.name, file, added.output, ctx.say)
  const destinationKey = itemKey('mcp', destination, server.name)
  if (copy) return done(`Copied ${server.name} to ${place}.`, { type: 'remove', key: destinationKey })

  const remove = ['mcp', 'remove', '--scope', scopeArg(server.project), server.name]
  const removed = await gemini(ctx, remove, server.name, server.project)
  const back: Action = { type: 'move', key: destinationKey, to: { project: server.project, scope: 'project' }, copy: false }
  if (!removed.ok || (await hasServer(ctx, server.file, server.name))) {
    const why = removed.ok ? tail(removed.output) || 'no output' : removed.message
    return done(`Copied ${server.name} to ${place}.`, { type: 'remove', key: destinationKey }, `It is still in ${ctx.say(server.file)}: ${why}`)
  }
  return done(`Moved ${server.name} to ${place}.`, back)
}
