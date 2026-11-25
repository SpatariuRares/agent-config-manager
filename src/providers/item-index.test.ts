// The item index through its interface: keys, the index a provider builds while it reads, lookup, GONE.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Item } from '../adapters/view.ts'
import { decodeKey, GONE, itemIndex, itemKey, kindOfKey } from './item-index.ts'

const item = (key: string, name = key): Item => ({
  key,
  agent: 'test',
  kind: kindOfKey(key) ?? 'skills',
  name,
  description: '',
  project: null,
  scope: 'user',
  source: '/x',
  movable: true,
  removable: true
})

test('a key is the kind, a colon and the JSON of its parts, and decodes back to both', () => {
  const key = itemKey('mcp', '/home/.codex/backups/config.toml.2026', 'web')
  assert.equal(key, 'mcp:["/home/.codex/backups/config.toml.2026","web"]')
  assert.deepEqual(decodeKey(key), { kind: 'mcp', parts: ['/home/.codex/backups/config.toml.2026', 'web'] })
  assert.deepEqual(decodeKey(itemKey('hooks', '/f', 'Stop', 0, null)), { kind: 'hooks', parts: ['/f', 'Stop', 0, null] })
  // Parts that hold the separators survive the round trip.
  assert.deepEqual(decodeKey(itemKey('skills', 'a:b"c]')), { kind: 'skills', parts: ['a:b"c]'] })
})

test('anything that is not a key this module built decodes to null', () => {
  for (const key of [undefined, null, 1, '', 'mcp', 'mcp:', 'nope:["x"]', 'skills:/abs/SKILL.md', 'mcp:{"a":1}', 'mcp:[{"a":1}]', 'mcp:[true]', 'mcp:["x"] ']) {
    assert.equal(decodeKey(key), null, String(key))
  }
})

test('the kind of a key is read from its prefix alone, so the router can refuse before any provider reads', () => {
  assert.equal(kindOfKey(itemKey('agents', '/a.md')), 'agents')
  assert.equal(kindOfKey('plugins:contract-probe'), 'plugins')
  for (const key of [undefined, 3, 'nope:["x"]', 'plain']) assert.equal(kindOfKey(key), null, String(key))
})

test('lookup finds an item and its ref by key, and refuses anything else with the one GONE refusal', () => {
  const index = itemIndex<{ file: string }>()
  index.add(item(itemKey('mcp', '/f', 'web')), { file: '/f' })
  index.add(item(itemKey('hooks', '/f', 0)))
  const built = index.build()
  assert.deepEqual(built.lookup(itemKey('mcp', '/f', 'web')), { ok: true, item: built.items[0], ref: { file: '/f' } })
  for (const key of [itemKey('mcp', '/f', 'gone'), 'mcp:["/f","web"', undefined, 7, itemKey('hooks', '/f', 0)]) {
    assert.deepEqual(built.lookup(key), GONE, String(key))
  }
  assert.deepEqual(GONE, { ok: false, reason: 'changed', message: 'That item is no longer there. The view was refreshed; try again.' })
})

test('an item without a ref is in the view and findable as an item, but has nothing a write could use', () => {
  const index = itemIndex<string>()
  index.add(item(itemKey('hooks', '/f', 0)))
  const built = index.build()
  assert.equal(built.items.length, 1)
  assert.equal(built.item(itemKey('hooks', '/f', 0))?.name, itemKey('hooks', '/f', 0))
  assert.equal(built.item(itemKey('hooks', '/f', 1)), undefined)
  assert.equal(built.lookup(itemKey('hooks', '/f', 0)).ok, false)
})

test('a key added twice keeps its first item and ref (a place reached twice is shown once)', () => {
  const index = itemIndex<number>()
  assert.equal(index.add(item(itemKey('skills', '/s'), 'first'), 1), true)
  assert.equal(index.add(item(itemKey('skills', '/s'), 'second'), 2), false)
  const built = index.build()
  assert.deepEqual(built.items.map((i) => i.name), ['first'])
  assert.deepEqual(built.lookup(itemKey('skills', '/s')), { ok: true, item: built.items[0], ref: 1 })
})

test('build sorts the items when given an order, stably, and keeps them as added otherwise', () => {
  const index = itemIndex<null>()
  for (const name of ['b', 'a', 'c', 'a2']) index.add(item(itemKey('skills', name), name), null)
  assert.deepEqual(index.build().items.map((i) => i.name), ['b', 'a', 'c', 'a2'])
  const byFirstLetter = (x: Item, y: Item) => x.name[0].localeCompare(y.name[0])
  assert.deepEqual(index.build(byFirstLetter).items.map((i) => i.name), ['a', 'a2', 'b', 'c'])
})
