import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fakeCli, fakeFs, paths } from '../../core/test-support.ts'
import { createConfigServer } from './server.ts'

const TOKEN = 'test-token-0123456789'
let panelDir: string
let base: string
let host: string
let close: () => Promise<void>
const fs = fakeFs({
  '/home/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'a@m': true } })
})

before(async () => {
  panelDir = await mkdtemp(join(tmpdir(), 'ccm-panel-'))
  await writeFile(join(panelDir, 'index.html'), '<!doctype html><title>panel</title>')
  await writeFile(join(panelDir, 'app.js'), 'export {}')
  const server = createConfigServer({
    deps: { fs, cli: fakeCli(), paths, http: { getJson: async () => ({ ok: false as const, status: null, error: 'offline', rateLimited: false }) } },
    panelDir,
    token: TOKEN
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  host = `127.0.0.1:${port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})
after(async () => {
  await close()
  await rm(panelDir, { recursive: true, force: true })
})

const api = (name: string, init: { token?: string; host?: string; origin?: string; body?: string; method?: string; type?: string } = {}) =>
  fetch(`${base}/api/${name}`, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': init.type ?? 'application/json',
      host: init.host ?? host,
      ...(init.token === undefined ? { 'x-ccm-token': TOKEN } : init.token === '' ? {} : { 'x-ccm-token': init.token }),
      ...(init.origin ? { origin: init.origin } : {})
    },
    body: init.method === 'GET' ? undefined : (init.body ?? '{}')
  })

test('serves the panel files, with index.html at /', async () => {
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await page.text(), /<title>panel<\/title>/)
  const script = await fetch(`${base}/app.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type') ?? '', /javascript/)
})

test('never serves a file outside the panel folder', async () => {
  for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/missing.js']) {
    const answer = await fetch(`${base}${path}`)
    assert.equal(answer.status, 404, path)
  }
})

test('answers view.get with the view when the token is right', async () => {
  const answer = await api('view.get')
  assert.equal(answer.status, 200)
  const body = await answer.json()
  assert.equal(body.ok, true)
  assert.equal(body.view.items.find((i: { name: string }) => i.name === 'a').kind, 'plugins')
})

test('refuses the API without the token, or with a wrong one', async () => {
  assert.equal((await api('view.get', { token: '' })).status, 403)
  assert.equal((await api('view.get', { token: 'nope' })).status, 403)
})

test('refuses a request whose Host is not this server (DNS rebinding)', async () => {
  // fetch() will not send a custom Host, so this one goes through node:http.
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/view.get`,
      { method: 'POST', headers: { host: 'evil.example', 'x-ccm-token': TOKEN, 'content-type': 'application/json' } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(status, 403)
})

test('refuses a request from another origin', async () => {
  assert.equal((await api('view.get', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await api('view.get', { origin: base })).status, 200)
})

test('accepts only POST with a JSON body, and unknown requests are 404', async () => {
  assert.equal((await api('view.get', { method: 'GET' })).status, 405)
  assert.equal((await api('view.get', { type: 'text/plain' })).status, 415)
  assert.equal((await api('nope')).status, 404)
  assert.equal((await api('action.run', { body: '{ not json' })).status, 400)
})

test('refuses a body larger than 1 MiB', async () => {
  assert.equal((await api('action.run', { body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) })).status, 413)
})

test('runs an action and answers with its result and the fresh view', async () => {
  const view = await (await api('view.get')).json()
  const key = view.view.items.find((i: { name: string }) => i.name === 'a').key
  const answer = await api('action.run', {
    body: JSON.stringify({ action: { type: 'setEnabled', key, enabled: false }, versions: view.view.versions })
  })
  assert.equal(answer.status, 200)
  const body = await answer.json()
  assert.equal(body.result.ok, true)
  assert.equal(JSON.parse(fs.files['/home/.claude/settings.json']).enabledPlugins['a@m'], false)
})

test('refuses to start without a token', () => {
  assert.throws(() => createConfigServer({ deps: { fs, cli: fakeCli(), paths, http: { getJson: async () => ({ ok: false as const, status: null, error: '', rateLimited: false }) } }, panelDir, token: '' }), /token/)
})

test('accepts application/json exactly, with or without parameters, in any case', async () => {
  assert.equal((await api('view.get', { type: 'application/jsonx' })).status, 415)
  assert.equal((await api('view.get', { type: 'Application/JSON; charset=utf-8' })).status, 200)
})

test('serves the panel only under this server as Host, and never in a frame', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/`, { headers: { host: 'evil.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
  const page = await fetch(`${base}/`)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
})
