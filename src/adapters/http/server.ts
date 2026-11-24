// The localhost transport: serves the panel and answers the panel contract (../view.ts) as JSON.
// It changes the user's Claude Code setup, and any web page the user opens can send requests to
// 127.0.0.1, so every API request must carry the session token in a custom header (which a cross-site
// page cannot send without a CORS preflight this server never grants), name this server as its Host
// (no DNS rebinding), and come from no other origin.
import { timingSafeEqual } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'
import { actionQueue, buildView, runAction, type BackendDeps } from '../backend.ts'
import { checkUpdates } from '../updates.ts'
import type { Http } from '../../core/ports.ts'
import type { ActionRequest } from '../view.ts'

export interface ConfigServerOptions {
  deps: BackendDeps & { http: Http }
  /** The folder holding the panel's index.html and modules. */
  panelDir: string
  /** The secret the page sends back in `x-ccm-token`. */
  token: string
}

const MAX_BODY = 1024 * 1024
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
}

export function createConfigServer({ deps, panelDir, token }: ConfigServerOptions): Server {
  if (token.length < 16) throw new Error('The server needs a random token of at least 16 characters.')
  // Changes run one at a time: each reads files, checks their versions, then writes.
  const serialized = actionQueue()
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
    'view.get': () => buildView(deps),
    'action.run': (input) => serialized(() => runAction(deps, input as ActionRequest)),
    // A check only reads (files, GitHub, npm), so it runs outside the queue; only on demand.
    'updates.check': () => checkUpdates(deps)
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      // Only this server's own names: a rebound DNS name cannot read the page or the API.
      if (!hosts().includes(request.headers.host ?? '')) return send(response, 403, 'Wrong host')
      if (url.pathname.startsWith('/api/')) return await api(request, response, url.pathname.slice(5))
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Method not allowed')
      return await serveFile(response, url.pathname)
    } catch (error) {
      // The terminal gets the details; the response never carries paths.
      console.error(error)
      send(response, 500, 'Internal error')
    }
  })

  function hosts(): string[] {
    const port = (server.address() as { port: number } | null)?.port
    return [`127.0.0.1:${port}`, `localhost:${port}`]
  }

  async function api(request: IncomingMessage, response: ServerResponse, name: string) {
    const origin = request.headers.origin
    if (origin !== undefined && !hosts().some((h) => origin === `http://${h}`)) return send(response, 403, 'Wrong origin')
    if (!sameSecret(String(request.headers['x-ccm-token'] ?? ''), token)) return send(response, 403, 'Missing or wrong token')
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined
    if (handler === undefined) return send(response, 404, 'Unknown request')
    if (request.method !== 'POST') return send(response, 405, 'Use POST')
    const mediaType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json') return send(response, 415, 'Send JSON')

    const body = await readBody(request)
    if (body === null) return send(response, 413, 'Body too large')
    let input: unknown
    try {
      input = body === '' ? {} : JSON.parse(body)
    } catch {
      return send(response, 400, 'Invalid JSON')
    }
    const answer = await handler(input)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(answer))
  }

  async function serveFile(response: ServerResponse, pathname: string) {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return send(response, 404, 'Not found')
    }
    const root = await realpath(panelDir)
    const wanted = join(root, decoded === '/' ? 'index.html' : decoded)
    // Resolve links too, then require the file to sit inside the panel folder.
    const real = await realpath(wanted).catch(() => null)
    if (real === null || !real.startsWith(root + sep)) return send(response, 404, 'Not found')
    const content = await readFile(real).catch(() => null)
    if (content === null) return send(response, 404, 'Not found')
    response.writeHead(200, {
      'content-type': TYPES[extname(real)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Never inside another site's frame.
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'"
    })
    response.end(content)
  }

  return server
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) tooLarge = true
      else chunks.push(chunk)
    })
    request.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}
