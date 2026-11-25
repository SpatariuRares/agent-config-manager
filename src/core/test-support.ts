// Shared test doubles for the core and every provider.
import { posix } from 'node:path'
import type { CliResult, CommandRunner, FileSystem } from './ports.ts'

/**
 * An in-memory FileSystem over a flat path -> text map; directories are implied by paths.
 * Paths are normalized like a real disk (`//` and `..`), so aliases reach the same file.
 * `links` maps a symlink path to its text (absolute, or relative to the link's folder).
 */
export function fakeFs(
  files: Record<string, string>,
  links: Record<string, string> = {}
): FileSystem & { files: Record<string, string>; links: Record<string, string> } {
  const norm = (path: string) => posix.normalize(path).replace(/(.)\/$/, '$1')
  /** Follows every link on the way, like the kernel does. */
  const resolve = (path: string): string => {
    let current = norm(path)
    for (let hops = 0; hops < 20; hops++) {
      const link = Object.keys(links).find((key) => current === key || current.startsWith(`${key}/`))
      if (link === undefined) return current
      const text = links[link]
      const target = text.startsWith('/') ? text : posix.join(posix.dirname(link), text)
      current = norm(target + current.slice(link.length))
    }
    return current
  }
  const hasFiles = (dir: string) => Object.keys(files).some((key) => key === dir || key.startsWith(`${dir}/`))
  const occupied = (path: string) => norm(path) in links || hasFiles(resolve(path))
  /** Moves or copies everything at `src` (a link, a file, or a folder of files and links) to `dst`. */
  const transfer = (src: string, dst: string, keep: boolean) => {
    if (occupied(dst)) throw Object.assign(new Error(`${dst} already exists`), { code: 'EEXIST' })
    const from = norm(src)
    const to = resolve(posix.dirname(dst)) + '/' + posix.basename(dst)
    if (from in links) {
      links[to] = links[from]
      if (!keep) delete links[from]
      return
    }
    const root = resolve(from)
    if (!hasFiles(root)) throw Object.assign(new Error(`${src} does not exist`), { code: 'ENOENT' })
    for (const key of Object.keys(files)) {
      if (key !== root && !key.startsWith(`${root}/`)) continue
      files[to + key.slice(root.length)] = files[key]
      if (!keep) delete files[key]
    }
    for (const key of Object.keys(links)) {
      if (!key.startsWith(`${root}/`)) continue
      links[to + key.slice(root.length)] = links[key]
      if (!keep) delete links[key]
    }
  }
  return {
    files,
    links,
    async readText(path) {
      return files[resolve(path)] ?? null
    },
    async writeText(path, text) {
      files[resolve(path)] = text
    },
    async realPath(path) {
      const target = resolve(path)
      return hasFiles(target) ? target : null
    },
    async listEntries(dir) {
      const prefixes = [...new Set([`${norm(dir)}/`, `${resolve(dir)}/`])]
      const names = [...Object.keys(files), ...Object.keys(links)]
        .flatMap((path) => prefixes.filter((prefix) => path.startsWith(prefix)).map((prefix) => path.slice(prefix.length)))
        .map((rest) => rest.split('/')[0])
      return [...new Set(names)].sort()
    },
    async linkTarget(path) {
      return links[norm(path)] ?? null
    },
    async move(src, dst) {
      transfer(src, dst, false)
    },
    async copy(src, dst) {
      transfer(src, dst, true)
    }
  }
}

type Reply = (command: string, argv: readonly string[], cwd: string | null) => CliResult | Promise<CliResult>

/**
 * A CommandRunner that runs nothing. `find` knows only `commands` (name -> path). Every run is recorded in
 * `calls` as `<command> <argv...> @ <cwd or ->`; it answers with `reply`, else success for a known command
 * and "not found" for any other.
 */
export function fakeExec(options: { commands?: Record<string, string>; reply?: Reply } = {}): CommandRunner & { calls: string[] } {
  const commands = options.commands ?? {}
  const calls: string[] = []
  const known = (name: string) => name.startsWith('/') || Object.hasOwn(commands, name)
  return {
    calls,
    async find(name) {
      return Object.hasOwn(commands, name) ? commands[name] : null
    },
    async run(command, argv, cwd) {
      calls.push(`${[command, ...argv].join(' ')} @ ${cwd ?? '-'}`)
      if (options.reply) return options.reply(command, argv, cwd)
      return known(command) ? { ok: true, output: '' } : { ok: false, output: `The ${command} command was not found.` }
    }
  }
}
