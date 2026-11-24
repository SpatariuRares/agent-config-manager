// JSON config files: parsing that never throws, and the opaque versions that let a write notice a concurrent change.
import type { FileSystem } from './ports.ts'

export type Json = Record<string, any>

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** FNV-1a of the file text: cheap, stable, and enough to notice that the file changed. '' for a missing file. */
export function versionOf(text: string | null): string {
  if (text === null) return ''
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}-${hash.toString(16)}`
}

/** The parsed object, or null when the text is not a JSON object. */
export function parseObject(text: string): Json | null {
  try {
    const value = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** A JSON object file: {} when it is missing; {} plus a line in `problems` when it cannot be read as an object. */
export async function readJson(fs: FileSystem, path: string, problems: string[] = []): Promise<Json> {
  const text = await fs.readText(path)
  if (text === null) return {}
  try {
    const value = JSON.parse(text)
    if (isObject(value)) return value
    problems.push(`${path}: expected a JSON object`)
    return {}
  } catch (error) {
    problems.push(`${path}: ${(error as Error).message}`)
    return {}
  }
}
