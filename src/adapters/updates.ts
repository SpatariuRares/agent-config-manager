// The Http port over global fetch, for the on-demand update checks. Only runs when the user asks.
import type { Http, HttpResult } from '../core/ports.ts'

/** Http over global fetch, with a timeout. GitHub asks for a User-Agent. */
export function fetchHttp(timeoutMs = 10_000): Http {
  return {
    async getJson(url): Promise<HttpResult> {
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json', 'user-agent': 'agent-config-manager' },
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (!response.ok) {
          const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
          await response.body?.cancel()
          return { ok: false, status: response.status, error: `HTTP ${response.status}${rateLimited ? ': rate limit reached' : ''}`, rateLimited }
        }
        return { ok: true, status: response.status, json: await response.json() }
      } catch (error) {
        const timedOut = (error as Error).name === 'TimeoutError'
        return { ok: false, status: null, error: timedOut ? `no answer within ${timeoutMs / 1000}s` : (error as Error).message, rateLimited: false }
      }
    }
  }
}
