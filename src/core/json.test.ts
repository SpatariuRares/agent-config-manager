import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readJson } from './json.ts'
import { fakeFs } from './test-support.ts'

test('a malformed JSON file is reported without quoting its content (it may hold secrets)', async () => {
  const problems: string[] = []
  const fs = fakeFs({ '/home/mcp.json': '{"env": {"TOKEN": ghp_SECRETVALUE123}}' })
  assert.deepEqual(await readJson(fs, '/home/mcp.json', problems), {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^\/home\/mcp\.json: not valid JSON/)
  assert.doesNotMatch(problems[0], /ghp_|SECRET/)
})
