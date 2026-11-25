// Item keys and the key -> ref index, for every provider. A key is `<kind>:<JSON of its parts>`: the router reads
// the kind from the prefix, the provider that built the key reads its parts back with decodeKey, and the panel treats
// the whole key as opaque. A provider builds its view through an index while it reads (each item with the ref its
// writes need), and an action resolves the key it was sent through the same index: one lookup, one GONE refusal.
import type { ActionResult, Item, Kind } from '../adapters/view.ts'
import { isKind } from './types.ts'

/** One part of a key: a path, a name, a scope, an index; null for "global". */
export type KeyPart = string | number | null

/** Builds an item key: `<kind>:<JSON of parts>`. */
export const itemKey = (kind: Kind, ...parts: KeyPart[]): string => `${kind}:${JSON.stringify(parts)}`

/** A key's kind and parts, as itemKey got them. */
export interface DecodedKey {
  kind: Kind
  parts: KeyPart[]
}

const isPart = (value: unknown): value is KeyPart => value === null || typeof value === 'string' || typeof value === 'number'

/** The kind and parts of a key itemKey built, or null for anything else (a non-string, an unknown kind, no JSON parts). */
export function decodeKey(key: unknown): DecodedKey | null {
  const kind = kindOfKey(key)
  if (kind === null) return null
  let parts: unknown
  try {
    parts = JSON.parse((key as string).slice(kind.length + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parts) || !parts.every(isPart) || itemKey(kind, ...parts) !== key) return null
  return { kind, parts }
}

/**
 * The kind a key names, read from its prefix alone, or null when it names none. The router refuses with it before
 * any provider runs; whether the item is still there is the provider's lookup.
 */
export function kindOfKey(key: unknown): Kind | null {
  if (typeof key !== 'string' || !key.includes(':')) return null
  const kind = key.slice(0, key.indexOf(':'))
  return isKind(kind) ? kind : null
}

/** The one refusal for a key that names nothing in the view just read. */
export const GONE: ActionResult & { ok: false } = Object.freeze({
  ok: false,
  reason: 'changed',
  message: 'That item is no longer there. The view was refreshed; try again.'
})

/** An item the view shows, with what a write needs to act on it. */
export type Found<Ref> = { ok: true; item: Item; ref: Ref }

/** The items a provider read, and the way back from a key to its item and ref. */
export interface ItemIndex<Ref> {
  /** Every item, in view order. */
  readonly items: Item[]
  /** The item and its ref; GONE when the key names no item, or an item added without a ref. */
  lookup(key: unknown): Found<Ref> | (ActionResult & { ok: false })
  /** The item the key names, ref or not. */
  item(key: unknown): Item | undefined
}

/** What a provider adds its items to while it reads. */
export interface IndexBuilder<Ref> {
  /**
   * Adds an item, with the ref its writes need (none for a read-only item). A key already added keeps its first
   * item and ref, so a place read twice is shown once. Returns whether the item was added.
   */
  add(item: Item, ref?: Ref): boolean
  /** The index, its items sorted by `order` (stable) when one is given, else in the order added. */
  build(order?: (a: Item, b: Item) => number): ItemIndex<Ref>
}

export function itemIndex<Ref>(): IndexBuilder<Ref> {
  const items: Item[] = []
  const byKey = new Map<string, { item: Item; ref: Ref | undefined }>()
  return {
    add(item, ref) {
      if (byKey.has(item.key)) return false
      items.push(item)
      byKey.set(item.key, { item, ref })
      return true
    },
    build(order) {
      const sorted = order === undefined ? [...items] : [...items].sort(order)
      const entry = (key: unknown) => (typeof key === 'string' ? byKey.get(key) : undefined)
      return {
        items: sorted,
        lookup(key) {
          const found = entry(key)
          return found?.ref === undefined ? GONE : { ok: true, item: found.item, ref: found.ref }
        },
        item: (key) => entry(key)?.item
      }
    }
  }
}
