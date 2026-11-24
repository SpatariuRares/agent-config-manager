// The only module that knows how the panel reaches its backend.
// Every backend answers three requests from src/adapters/view.ts:
//   'view.get'      -> ViewAnswer, with input AgentRequest { agent? }
//   'action.run'    -> ActionAnswer, with input ActionRequest { agent, action, versions }
//   'updates.check' -> UpdatesAnswer, with input AgentRequest { agent? } (network; sent only when the user asks)
// A backend is just { request(name, input): Promise<answer> }; the transport adds the selected agent
// and the versions, and turns transport failures into the same answer shapes, so the UI handles one
// kind of result.

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
 * The localhost server (src/adapters/http): the same requests as JSON over HTTP, each carrying the
 * session token the server printed in the page's URL fragment.
 */
export function httpBackend(baseUrl, token) {
  return {
    mode: 'http',
    async request(name, input) {
      const response = await fetch(new URL(`api/${encodeURIComponent(name)}`, baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ccm-token': token },
        body: JSON.stringify(input ?? {}),
      })
      if (response.status === 403) {
        throw Object.assign(new Error('The server refused this page. Open the link the server printed.'), { code: 'forbidden' })
      }
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http_error' })
      return response.json()
    },
    onTheme: () => undefined,
  }
}

/** The token from `#token=…`, kept for this tab so a reload still works; null when there is none. */
function sessionToken(hash) {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('token')
  try {
    if (fromHash) sessionStorage.setItem('ccm-token', fromHash)
    return fromHash || sessionStorage.getItem('ccm-token')
  } catch {
    return fromHash
  }
}

/** Opened without the server's link (and not as ?fixture): say how to open it, never show sample data. */
function noServerBackend() {
  return {
    mode: 'none',
    request: () =>
      Promise.reject(
        Object.assign(new Error('Open the panel from the link the server printed (run `npm start`); this page has no access token.'), {
          code: 'no_token',
        })
      ),
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

/** The agent the user picked last, kept per viewer; null when none was picked or storage is off. */
const AGENT_KEY = 'ccm.agent'
function storedAgent() {
  try {
    return localStorage.getItem(AGENT_KEY) || null
  } catch {
    return null
  }
}
function storeAgent(id) {
  try {
    localStorage.setItem(AGENT_KEY, id)
  } catch {
    /* storage unavailable: the choice just does not persist */
  }
}
function forgetAgent() {
  try {
    localStorage.removeItem(AGENT_KEY)
  } catch {
    /* nothing to forget */
  }
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

export function createTransport({ search = location.search, hash = location.hash, orca = globalThis.orca } = {}) {
  const params = new URLSearchParams(search)
  const token = params.has('fixture') ? null : sessionToken(hash)
  if (token && hash.includes('token=')) history.replaceState(null, '', location.pathname + location.search)
  const backend = params.has('fixture')
    ? fixtureBackend(params)
    : orca?.plugin?.request
      ? orcaBackend(orca)
      : token
        ? httpBackend(location.origin + '/', token)
        : noServerBackend()
  /** Versions of the last view read; every action sends them so stale writes are refused. */
  let versions = {}
  /**
   * The agent every request is for: the one the user picked last, else the one the backend chose
   * for the first view. Null until either is known; the backend then picks its first detected agent.
   */
  let agent = storedAgent()
  /** True once a view came back for `agent`, so a remembered id is known to still exist. */
  let confirmed = false
  const remember = (viewAnswer) => {
    if (!viewAnswer?.ok) return viewAnswer
    versions = viewAnswer.view.versions
    if (viewAnswer.view.agent) agent = viewAnswer.view.agent
    confirmed = true
    return viewAnswer
  }
  const forAgent = () => (agent ? { agent } : {})

  async function fetchView() {
    const asked = agent
    const answer = await backend.request('view.get', forAgent())
    // The user switched agents while this was in flight: hand it back untouched; the caller drops it.
    if (asked !== agent) return answer
    return remember(answer)
  }

  return {
    mode: backend.mode,
    onTheme: backend.onTheme,
    /** The agent requests are sent for, or null before the first view. */
    get agent() {
      return agent
    },
    /** Selects the agent for every later request and remembers it for this viewer. */
    setAgent(id) {
      if (!id || id === agent) return
      agent = id
      confirmed = false
      versions = {}
      storeAgent(id)
    },
    /** @returns {Promise<import('../src/adapters/view.ts').ViewAnswer>} */
    async getView() {
      try {
        const answer = await fetchView()
        if (answer?.ok || !agent || confirmed) return answer
        // The remembered agent could not be read. Ask for the backend's default to learn the agents:
        // an id it no longer knows is forgotten; a known one keeps its error and the switcher.
        const asked = agent
        const fallback = await backend.request('view.get', {})
        if (asked !== agent || !fallback?.ok) return answer
        if (fallback.view.agents?.some((a) => a.id === asked)) return { ...answer, agents: fallback.view.agents }
        forgetAgent()
        agent = null
        return remember(fallback)
      } catch (error) {
        return { ok: false, error: describe(error) }
      }
    },
    /** @returns {Promise<import('../src/adapters/view.ts').ActionAnswer>} */
    async runAction(action) {
      try {
        const answer = await backend.request('action.run', { agent, action, versions })
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
        const answer = await backend.request('updates.check', forAgent())
        if (!answer || typeof answer.statuses !== 'object') return { ok: false, error: 'The answer had no statuses.' }
        return { ok: true, answer }
      } catch (error) {
        return { ok: false, error: describe(error) }
      }
    },
  }
}
