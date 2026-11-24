// The only module that knows how the panel reaches its backend.
// Every backend answers three requests from src/adapters/view.ts:
//   'view.get'      -> ViewAnswer
//   'action.run'    -> ActionAnswer, with input ActionRequest { action, versions }
//   'updates.check' -> UpdatesAnswer (network; sent only when the user asks)
// A backend is just { request(name, input): Promise<answer> }; the transport adds versions and turns
// transport failures into the same answer shapes, so the UI handles one kind of result.

import { createFixtureBackend } from './fixture.js'

/** Inside Orca: the global `orca` HTML panels get; requests reach the worker's `orca.panels.handle`. */
function orcaBackend(orca) {
  return {
    mode: 'orca',
    request: (name, input) => orca.plugin.request(name, input),
    onTheme: (handler) => (typeof orca.on === 'function' ? orca.on('theme', handler) : undefined),
  }
}

/**
 * Seam for the localhost server (not built yet): the same requests as JSON over HTTP.
 * Wire it in createTransport once the server exists, e.g. when the page is served from it.
 */
export function httpBackend(baseUrl) {
  return {
    mode: 'http',
    async request(name, input) {
      const response = await fetch(new URL(`api/${encodeURIComponent(name)}`, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input ?? {}),
      })
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http_error' })
      return response.json()
    },
    onTheme: () => undefined,
  }
}

function fixtureBackend(params) {
  const latency = Number(params.get('latency') ?? 150)
  const backend = createFixtureBackend({ variant: params.get('fixture') || 'default', latency: Number.isFinite(latency) ? latency : 150 })
  // Tests read the requests the panel sent; the fixture is never loaded inside Orca.
  globalThis.ccmFixture = backend
  return { mode: 'fixture', request: backend.request, onTheme: () => undefined }
}

const HINTS = {
  timeout: 'The plugin worker took too long to answer.',
  unavailable: 'The plugin worker is not running. Reload the plugin.',
  unknown_method: 'The plugin worker does not answer this request. Reload the plugin.',
}

function describe(error) {
  const code = error?.code
  const text = error?.message || (typeof error === 'string' ? error : '') || 'Unknown error'
  return HINTS[code] ? `${HINTS[code]} (${code})` : text
}

export function createTransport({ search = location.search, orca = globalThis.orca } = {}) {
  const params = new URLSearchParams(search)
  const backend = !params.has('fixture') && orca?.plugin?.request ? orcaBackend(orca) : fixtureBackend(params)
  /** Versions of the last view read; every action sends them so stale writes are refused. */
  let versions = {}
  const remember = (viewAnswer) => {
    if (viewAnswer?.ok) versions = viewAnswer.view.versions
    return viewAnswer
  }

  return {
    mode: backend.mode,
    onTheme: backend.onTheme,
    /** @returns {Promise<import('../src/adapters/view.ts').ViewAnswer>} */
    async getView() {
      try {
        return remember(await backend.request('view.get', {}))
      } catch (error) {
        return { ok: false, error: describe(error) }
      }
    },
    /** @returns {Promise<import('../src/adapters/view.ts').ActionAnswer>} */
    async runAction(action) {
      try {
        const answer = await backend.request('action.run', { action, versions })
        remember(answer.view)
        return answer
      } catch (error) {
        const message = describe(error)
        return { result: { ok: false, reason: 'transport', message: `The action did not run: ${message}` }, view: { ok: false, error: message } }
      }
    },
    /** @returns {Promise<{ ok: true, answer: import('../src/adapters/view.ts').UpdatesAnswer } | { ok: false, error: string }>} */
    async checkUpdates() {
      try {
        const answer = await backend.request('updates.check', {})
        if (!answer || typeof answer.statuses !== 'object') return { ok: false, error: 'The answer had no statuses.' }
        return { ok: true, answer }
      } catch (error) {
        return { ok: false, error: describe(error) }
      }
    },
  }
}
