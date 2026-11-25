// Gemini CLI's writes. Every change goes through the `gemini` CLI by argv, as a guarded change: version check of
// each file the CLI will touch, a backup of it, the CLI, then a re-read of the file to prove the change happened,
// since several gemini subcommands print an error and still exit 0. Restore and snapshot are the router's, from
// geminiBackups; reinstalling an extension from its install record is this provider's restore hook.
import { createHash } from 'node:crypto'
import type { Action, ActionRequest, ActionResult } from '../../adapters/view.ts'
import {
  admitMcp,
  guardedChange,
  isObject,
  itemKey,
  optionLikeRefusal,
  redactUrl,
  shellQuote,
  tilde,
  unreadable,
  urlHasSecret,
  type Admitted,
  type BackupPlan,
  type Change,
  type Clock,
  type FileSystem,
  type Json,
  type ProviderDeps,
  type RestoreRequest,
  type Step
} from '../toolkit.ts'
import { GEMINI_ADD, GEMINI_ADD_TEAM } from './mcp-add.ts'
import { projectSettings, settingsOf, type GeminiPaths } from './paths.ts'
import { extensionEnabled, geminiMcpConfig, readSetup, rulesFor, stripComments, type Extension, type McpServer, type Setup } from './read.ts'

type Done = ActionResult & { ok: true }
type Refused = ActionResult & { ok: false }

export const done = (message: string, undo?: Action, warning?: string): Done => ({ ok: true, message, ...(undo ? { undo } : {}), ...(warning ? { warning } : {}) })
export const refuse = (reason: string, message: string): Refused => ({ ok: false, reason, message })
const GONE = refuse('changed', 'That item is no longer there. The view was refreshed; try again.')

/** A JSON (or JSONC) file as an object; null when it exists but is not one. */
async function objectAt(fs: FileSystem, file: string, comments: boolean): Promise<Json | null> {
  const text = await fs.readText(file)
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

/** A guarded change of Gemini CLI's files: the view's versions, Gemini's backup store, ~ in messages. */
export const change = (ctx: Context, files: string[], steps: Change['steps'], unversioned?: string[]) =>
  guardedChange(
    { fs: ctx.deps.fs, exec: ctx.deps.exec, store: ctx.paths.backups, clock: ctx.clock, say: ctx.say },
    { files, versions: ctx.versions, steps, ...(unversioned ? { unversioned } : {}) }
  )

/** One `gemini <argv>` run in `cwd` (never a shell), about `subject`, with its post-condition on `file`. */
export const gemini = (argv: string[], subject: string, cwd: string | null, file: string, holds: (fs: FileSystem, output: string) => Promise<boolean>, options?: { timeoutMs?: number; closeStdin?: boolean }): Step => ({
  effect: { kind: 'cli', command: 'gemini', argv, cwd, ...(options ? { options } : {}) },
  about: subject,
  check: { file, holds }
})

/** The question Gemini CLI asks on stdin before it accepts new permissions (requestConsentNonInteractive). */
const CONSENT_PROMPT = /Do you want to (continue|trust this folder)|\[Y\/n\]|\[y\/N\]/

/**
 * What restore and snapshot work with (the router runs them): every file the CLI writes for the actions offered
 * here. Gemini CLI has no trash here; an extension's install record restores by reinstalling it (reinstallExtension).
 */
export async function geminiBackups(deps: ProviderDeps, paths: GeminiPaths): Promise<BackupPlan> {
  const setup = await readSetup(deps.fs, paths)
  const ctx = (versions: Record<string, string>) => contextOf(deps, paths, versions)
  return {
    owner: 'Gemini CLI',
    store: paths.backups,
    files: [paths.settings, ...setup.projects.map(projectSettings), paths.enablement, paths.mcpEnablement],
    entryFolders: [],
    say: (path) => tilde(paths.home, path),
    restoreOwn: (restore) => (isInstallRecord(paths, restore.target) ? reinstallExtension(ctx(restore.versions), restore) : null)
  }
}

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
    if (place?.broken) return unreadable(ctx.say(server.file))
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
  if ((await objectAt(ctx.deps.fs, paths.enablement, false)) === null) return unreadable(ctx.say(paths.enablement))
  // `--scope user` writes a rule for the home folder, `--scope workspace` one for the folder it runs in.
  const argv = ['extensions', enabled ? 'enable' : 'disable', '--scope', project === null ? 'user' : 'workspace', extension.name]
  const ran = await change(ctx, [paths.enablement], [
    gemini(argv, extension.name, project, paths.enablement, async (fs) => {
      const now = await objectAt(fs, paths.enablement, false)
      return now !== null && extensionEnabled(now, extension.name, folder) === enabled
    })
  ])
  if (!ran.ok) return ran
  const after = (await objectAt(ctx.deps.fs, paths.enablement, false)) ?? {}
  // A rule for a folder replaces the rules of the folders inside it (Override.isChildOf).
  const cleared = setup.projects.filter(
    (other) => other !== project && rulesFor(setup.enablement, extension.name, other).length > 0 && rulesFor(after, extension.name, other).length === 0
  )
  const warning = cleared.length > 0 ? `Gemini CLI also cleared the ${extension.name} override in ${cleared.map(ctx.say).join(', ')}.` : undefined
  return done(`Turned ${extension.name} ${enabled ? 'on' : 'off'} ${where}. Restart Gemini CLI sessions to apply it.`, { type: 'setEnabled', key, enabled: !enabled }, warning)
}

async function uninstallExtension(ctx: Context, extension: Extension) {
  // The install record says where the extension came from. Backed up before the uninstall deletes it, it is what
  // the undo reinstalls from (reinstallExtension), when `gemini extensions install` can use it. The view has no
  // version of it, so it is backed up without a version check.
  const recordFile = `${extension.dir}/${INSTALL_RECORD}`
  const record = await ctx.deps.fs.readText(recordFile)
  const reinstallable = record !== null && reinstallArgv(record) !== null
  const argv = ['extensions', 'uninstall', extension.name]
  const ran = await change(
    ctx,
    reinstallable ? [ctx.paths.enablement, recordFile] : [ctx.paths.enablement],
    [gemini(argv, extension.name, null, extension.dir, async (fs) => (await fs.realPath(extension.dir)) === null)],
    [recordFile]
  )
  if (!ran.ok) return ran
  const source = extension.install.source
  const again = source ? ` To install it again: ${shellQuote(['gemini', 'extensions', 'install', source.startsWith('/') ? source : redactUrl(source)])}` : ''
  return done(`Uninstalled ${extension.name}.${again}`, ran.restore(recordFile))
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
async function reinstallExtension(ctx: Context, { name, target, text, acceptCommand }: RestoreRequest): Promise<ActionResult> {
  const { fs } = ctx.deps
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
  // stdin is closed: a question the install still asks (trusting a local folder) ends the run instead of hanging.
  const install = gemini(argv, extension, null, target, async (fs) => (await fs.readText(target)) !== null, { timeoutMs: 120_000, closeStdin: true })
  const ran = await change(ctx, [ctx.paths.enablement], [{ ...install, hint: `To try it in a terminal: ${command}` }])
  if (!ran.ok) return ran
  return done(`Reinstalled ${extension} with ${command}.`)
}

async function updateExtension(ctx: Context, extension: Extension) {
  const { type, source } = extension.install
  if (source === null || (type !== 'git' && type !== 'github-release')) {
    return refuse('unsupported', `${extension.name} was installed from ${type ?? 'an unknown source'}; Gemini CLI updates only git and GitHub release extensions.`)
  }
  const argv = ['extensions', 'update', extension.name]
  const manifestFile = `${extension.dir}/gemini-extension.json`
  const versionNow = async (fs: FileSystem) => {
    const manifest = await objectAt(fs, manifestFile, false)
    return manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
  }
  const upToDate = (output: string) => /up to date|No extensions to update/i.test(output)
  let printed = ''
  const updated = async (fs: FileSystem, output: string) => {
    printed = output
    const version = await versionNow(fs)
    return (version !== null && version !== extension.version) || upToDate(output)
  }
  // Gemini CLI 0.35.3 has no flag to approve an update's new permissions (`extensions update` takes only a name
  // or --all; only `extensions install` has --consent), and asks on stdin. With stdin closed, that question ends
  // the run at once instead of hanging until the timeout; this app never answers it for the user.
  const update = gemini(argv, extension.name, null, manifestFile, updated, { timeoutMs: 120_000, closeStdin: true })
  const ran = await change(ctx, [ctx.paths.enablement], [{ ...update, hint: `To see why, run this in a terminal: ${shellQuote(['gemini', ...argv])}` }])
  // The question can come with any exit code: a failed run, or one that exits 0 having changed nothing.
  if (!ran.ok && CONSENT_PROMPT.test(ran.reason === 'cli-failed' ? ran.output : printed)) {
    return refuse(
      'needs-consent',
      `${extension.name} asks to approve new permissions, and this app never approves them for you. To review and approve them, run this in a terminal: ${shellQuote(['gemini', ...argv])}`
    )
  }
  if (!ran.ok) return ran
  const version = await versionNow(ctx.deps.fs)
  if (version !== null && version !== extension.version) return done(`Updated ${extension.name} from ${extension.version ?? '?'} to ${version}.`)
  return done(`${extension.name} is already up to date.`)
}

// ------------------------------------------------------------------------------------------------------- MCP

const mcpState = async (fs: FileSystem, paths: GeminiPaths, name: string) => {
  const state = await objectAt(fs, paths.mcpEnablement, false)
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
  if ((await mcpState(ctx.deps.fs, paths, server.name)) === null) return unreadable(ctx.say(paths.mcpEnablement))
  // The CLI looks the name up in the settings of the folder it runs in, so a project's server runs there.
  const argv = ['mcp', enabled ? 'enable' : 'disable', server.name]
  const ran = await change(ctx, [paths.mcpEnablement], [
    gemini(argv, server.name, server.project, paths.mcpEnablement, async (fs) => (await mcpState(fs, paths, server.name)) === enabled)
  ])
  if (!ran.ok) return ran
  return done(
    `Turned ${server.name} ${enabled ? 'on' : 'off'}.`,
    { type: 'setEnabled', key, enabled: !enabled },
    'Gemini CLI turns MCP servers on and off by name, everywhere: every server with this name follows.'
  )
}

export const scopeArg = (project: string | null) => (project === null ? 'user' : 'project')

/** Whether the settings file (JSON with comments) has an MCP server of this name. */
export const hasServer = async (fs: FileSystem, file: string, name: string) => {
  const settings = await objectAt(fs, file, true)
  return settings !== null && isObject(settings.mcpServers) && isObject(settings.mcpServers[name])
}

/** `gemini mcp add|remove` of `name` in `file`, proven by a re-read: the server is there after an add, gone after a remove. */
export const mcpStep = (argv: string[], name: string, project: string | null, file: string, present: boolean) =>
  gemini(argv, name, project, file, async (fs) => (await hasServer(fs, file, name)) === present)

async function removeMcp(ctx: Context, server: McpServer) {
  const argv = ['mcp', 'remove', '--scope', scopeArg(server.project), server.name]
  const ran = await change(ctx, [server.file], [mcpStep(argv, server.name, server.project, server.file, false)])
  if (!ran.ok) return ran
  return done(`Removed ${server.name} from ${ctx.say(server.file)}.`, ran.restore(server.file))
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
  if (destinationPlace?.broken) return unreadable(ctx.say(file))
  if (await hasServer(ctx.deps.fs, file, server.name)) return refuse('exists', `${place} already has an MCP server named ${server.name}. Rename or remove one of them first.`)

  const add = mcpStep(addArgv(admitted.server, destination), server.name, destination, file, true)
  const remove = mcpStep(['mcp', 'remove', '--scope', scopeArg(server.project), server.name], server.name, server.project, server.file, false)
  const ran = await change(ctx, copy ? [file] : [file, server.file], copy ? [add] : [add, remove])
  if (!ran.ok) return ran
  const destinationKey = itemKey('mcp', destination, server.name)
  if (copy) return done(`Copied ${server.name} to ${place}.`, { type: 'remove', key: destinationKey })
  return done(`Moved ${server.name} to ${place}.`, { type: 'move', key: destinationKey, to: { project: server.project, scope: 'project' }, copy: false })
}
