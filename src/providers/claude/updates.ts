// The on-demand update check: asks GitHub, the npm registry and local marketplace checkouts whether each item
// with an update source has something newer. Only runs when the user asks; never writes anything.
import { isObject, type Json } from '../../core/json.ts'
import type { Http } from '../../core/ports.ts'
import type { UpdatesAnswer, UpdateStatus } from '../../adapters/view.ts'
import { readUpdateTargets } from './actions.ts'
import type { ClaudeDeps } from './ports.ts'
import { compareVersions, latestNpmVersion, type UpdateTarget } from './update-sources.ts'

const LATER = 'checked when you update'

/** Checks every item that has an update source. Never throws: what cannot be checked is unknown, with a reason. */
export async function checkClaudeUpdates(deps: ClaudeDeps & { http: Http }): Promise<UpdatesAnswer> {
  const checkedAt = (deps.clock ?? (() => new Date()))().getTime()
  const statuses: Record<string, UpdateStatus> = {}
  const errors: string[] = []
  try {
    const { targets } = await readUpdateTargets(deps)
    const byType = <T extends UpdateTarget['type']>(type: T) =>
      [...targets].filter((entry): entry is [string, Extract<UpdateTarget, { type: T }>] => entry[1].type === type)

    for (const [key, target] of byType('manual')) statuses[key] = { status: 'unknown', latest: null, note: target.source.note }

    // Skills: one tree call per repo, then each skill folder's tree sha against the lock's hash.
    const skills = byType('skills-cli')
    for (const repo of new Set(skills.map(([, target]) => target.repo))) {
      const tree = await repoTree(deps.http, repo)
      if (!tree.ok) errors.push(`GitHub: could not check ${repo}: ${tree.error}.`)
      for (const [key, target] of skills.filter(([, t]) => t.repo === repo)) {
        if (!tree.ok) {
          statuses[key] = { status: 'unknown', latest: null, note: tree.error }
          continue
        }
        const sha = tree.shas.get(target.folder)
        statuses[key] =
          sha === undefined
            ? { status: 'unknown', latest: null, note: `${target.folder || 'the repo root'} was not found in ${repo}` }
            : { status: sha === target.hash ? 'current' : 'available', latest: sha }
      }
    }

    // npm: one registry call per package.
    const packages = byType('npm')
    for (const pkg of new Set(packages.map(([, target]) => target.pkg))) {
      const latest = await latestNpmVersion(deps.http, pkg)
      if (!latest.ok) errors.push(`npm: could not check ${pkg}: ${latest.error}.`)
      for (const [key, target] of packages.filter(([, t]) => t.pkg === pkg)) {
        if (!latest.ok) {
          statuses[key] = { status: 'unknown', latest: null, note: latest.error }
          continue
        }
        const order = compareVersions(latest.version, target.version)
        statuses[key] =
          order === null
            ? { status: 'unknown', latest: latest.version, note: `${latest.version} cannot be compared with ${target.version}` }
            : { status: order > 0 ? 'available' : 'current', latest: latest.version }
      }
    }

    // Plugins: the marketplace's declared version, else the git checkout's files for the plugin, else unknown.
    const marketplaces = new Map<string, Promise<Marketplace | null>>()
    for (const [key, target] of byType('plugin')) {
      if (!marketplaces.has(target.marketplace)) marketplaces.set(target.marketplace, readMarketplace(deps, target.marketplace))
      statuses[key] = await checkPlugin(deps, target, await marketplaces.get(target.marketplace)!)
    }
  } catch (error) {
    errors.push(`The check stopped: ${String(error)}`)
  }
  return { checkedAt, statuses, errors }
}

type Tree = { ok: true; shas: Map<string, string> } | { ok: false; error: string }

async function repoTree(http: Http, repo: string): Promise<Tree> {
  const answer = await http.getJson(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`)
  if (!answer.ok) return { ok: false, error: answer.rateLimited ? 'rate limit reached; try again later' : answer.error }
  const body: Json = isObject(answer.json) ? answer.json : {}
  const shas = new Map<string, string>()
  if (typeof body.sha === 'string') shas.set('', body.sha)
  for (const entry of Array.isArray(body.tree) ? body.tree : []) {
    if (isObject(entry) && entry.type === 'tree' && typeof entry.path === 'string' && typeof entry.sha === 'string') {
      shas.set(entry.path, entry.sha)
    }
  }
  return { ok: true, shas }
}

interface Marketplace {
  /** The local checkout, when the marketplace comes from git. */
  gitDir: string | null
  plugins: Json[]
}

async function readMarketplace(deps: ClaudeDeps, name: string): Promise<Marketplace | null> {
  const parse = async (path: string): Promise<Json> => {
    try {
      const value = JSON.parse((await deps.fs.readText(path)) ?? '{}')
      return isObject(value) ? value : {}
    } catch {
      return {}
    }
  }
  const known = (await parse(`${deps.paths.claudeDir}/plugins/known_marketplaces.json`))[name]
  const dir =
    isObject(known) && typeof known.installLocation === 'string' ? known.installLocation : `${deps.paths.claudeDir}/plugins/marketplaces/${name}`
  const manifest = await parse(`${dir}/.claude-plugin/marketplace.json`)
  if (!Array.isArray(manifest.plugins)) return null
  const kind = isObject(known) && isObject(known.source) ? known.source.source : null
  return { gitDir: kind === 'github' || kind === 'git' ? dir : null, plugins: manifest.plugins.filter(isObject) }
}

/** Claude Code may append the commit to a declared version (`1.0.0-5cec67167672`); that suffix is not a pre-release. */
const declared = (version: string) => version.replace(/-[0-9a-f]{7,40}$/, '')

async function checkPlugin(deps: ClaudeDeps, target: Extract<UpdateTarget, { type: 'plugin' }>, market: Marketplace | null): Promise<UpdateStatus> {
  const unknown: UpdateStatus = { status: 'unknown', latest: null, note: LATER }
  const entry = market?.plugins.find((plugin) => plugin.name === target.name)
  if (market === null || entry === undefined) return unknown

  if (typeof entry.version === 'string' && target.version !== null) {
    const order = compareVersions(entry.version, declared(target.version))
    if (order !== null) return { status: order > 0 ? 'available' : 'current', latest: entry.version }
    if (entry.version === target.version) return { status: 'current', latest: entry.version }
  }

  // A plugin inside a git marketplace: compare its folder's tree at the installed commit and at HEAD.
  const path = typeof entry.source === 'string' && entry.source.startsWith('./') ? entry.source.slice(2).replace(/\/$/, '') : null
  if (market.gitDir === null || path === null || path === '' || path.split('/').includes('..') || target.commit === null) return unknown
  if (!/^[0-9a-f]{4,64}$/.test(target.commit)) return unknown
  const answer = await deps.cli.git(['rev-parse', 'HEAD', `${target.commit}:${path}`, `HEAD:${path}`], market.gitDir)
  const [head, installed, latest] = answer.output.split('\n').map((line) => line.trim())
  if (!answer.ok || !head || !installed || !latest) return unknown
  return { status: installed === latest ? 'current' : 'available', latest: head.slice(0, 12) }
}
