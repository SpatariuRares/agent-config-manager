import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from './main.ts'

test('start hands the parsed port and open flag to the server entry', async () => {
  const calls: [number, boolean][] = []
  const start = async (port: number, open: boolean) => {
    calls.push([port, open])
  }
  assert.equal(await main(['start', '--port', '5000', '--no-open'], { start }), 0)
  assert.equal(await main([], { start }), 0)
  assert.deepEqual(calls, [
    [5000, false],
    [4321, true]
  ])
})
