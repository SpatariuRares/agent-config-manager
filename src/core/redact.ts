// Secret-safe text: what a provider may show of MCP args and URLs, hook commands and CLI argv. Every provider uses
// these rules for items and for result messages. Env values and headers are never read into an item at all;
// this covers what hides in args, URLs and commands. A heuristic: it hides more than needed rather than less.

export const REDACTED = '<redacted>'

/** A name that holds a credential: API_KEY, --token, access_token, password, Authorization... */
const SECRET_NAME = /(key|token|secret|passw(or)?d|pwd|auth|bearer|credential|cookie|session)/i
/** Flags whose next word is a credential: any flag with a secret name, plus `-k`, `-H` and `--header`. */
const isSecretFlag = (word: string) => /^-{1,2}[\w-]+$/.test(word) && (/^(-k|-H|--header)$/.test(word) || SECRET_NAME.test(word))
/** Well-known token prefixes (OpenAI, Stripe, GitHub, GitLab, Slack, AWS, Google, JWT). */
const TOKEN_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|xox[abposr]-|AKIA|ASIA|AIza|ya29\.|eyJ)[A-Za-z0-9._+/=-]{8,}$/
const URL_LIKE = /^[a-z][\w+.-]*:\/\//i

/** Bits per character: a random token scores high, a word or a repeated letter low. */
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length)
  return bits
}

/** A value that looks like a credential whatever its name: a known token prefix, or a long high-entropy string. */
export function looksSecret(value: string): boolean {
  if (TOKEN_PREFIX.test(value)) return true
  // An absolute path or a package spec is not a token, however long.
  if (value.length < 32 || value.startsWith('/') || !/^[A-Za-z0-9+/_=.-]+$/.test(value)) return false
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value) && entropy(value) >= 3.5
}

/**
 * A URL path segment that is a token: a credential-like value (looksSecret, also on each `:`-separated part), or a
 * run of 20+ letters and digits that is not one lowercase word (`XXXXXXXXXXXXXXXXXXXXXXXX` in a Slack webhook).
 * Ordinary path words (`mcp`, `v1`, `sse`, `oauth-authorization-server`) stay readable.
 */
function secretSegment(segment: string): boolean {
  let text = segment
  try {
    text = decodeURIComponent(segment)
  } catch {
    // Not valid percent-encoding: check it as written.
  }
  if (text === '') return false
  if (looksSecret(text) || text.split(':').some((part) => part !== text && looksSecret(part))) return true
  return (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some((run) => !/^[a-z]+$/.test(run))
}

/** A path with every token-like segment replaced by REDACTED. */
const redactPath = (path: string) => path.split('/').map((segment) => (secretSegment(segment) ? REDACTED : segment)).join('/')
const pathHasSecret = (path: string) => path.split('/').some(secretSegment)

/** Whether a URL carries a credential: user info, a token-like path segment, a secret-named query key, or a token-shaped query value. */
export function urlHasSecret(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return (
      /\/\/[^/@\s]+@/.test(url) ||
      pathHasSecret(url.split(/[?#]/)[0]) ||
      [...url.matchAll(/[?&]([^=&#]*)=([^&#]*)/g)].some(([, k, v]) => SECRET_NAME.test(k) || looksSecret(v))
    )
  }
  if (parsed.username || parsed.password) return true
  if (pathHasSecret(parsed.pathname)) return true
  if ([...parsed.searchParams].some(([key, value]) => SECRET_NAME.test(key) || looksSecret(value))) return true
  return SECRET_NAME.test(parsed.hash)
}

/**
 * A URL without its user info and fragment, with every token-like path segment and every query value redacted.
 * Unchanged when it has none of them.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    const cut = url.split(/[?#]/)[0]
    const path = redactPath(cut)
    return cut === url ? path : `${path}?${REDACTED}`
  }
  const secretPath = pathHasSecret(parsed.pathname)
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash && !secretPath) return url
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const keys = [...new Set(parsed.searchParams.keys())]
  const query = keys.map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join('&')
  parsed.search = ''
  // Without search and hash, the path ends the URL; REDACTED is put in as text (the URL API would encode it).
  const whole = parsed.toString()
  const path = secretPath ? redactPath(parsed.pathname) : parsed.pathname
  return `${whole.slice(0, whole.length - parsed.pathname.length)}${path}${query ? `?${query}` : ''}`
}

/** A `${VAR}` reference: names an environment variable, holds no value. */
const REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g
const isReferenceOnly = (text: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text)
/** A header that carries a credential, and what follows its colon (up to a quote or the end of the line). */
const SECRET_HEADER = /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie)(\s*:\s*)([^'"\n]*)/gi
/** An HTTP auth scheme and the word after it: the credential. */
const AUTH_SCHEME = /\b(Bearer|Basic)(\s+)([^\s'"]+)/gi
/**
 * The pieces of a value, in order: a URL (kept whole), a `${VAR}` reference, or a word between separators
 * (whitespace, `=`, `:`, `,`, `;`, quotes, JSON punctuation, parentheses, `<`, `>`). A `$` that starts a reference ends a word.
 */
const PIECE = /[a-z][\w+.-]*:\/\/[^\s'"<>`]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:[^\s=:,;'"`{}[\]<>()$]|\$(?!\{))+/gi

/** One piece of a value is a credential: token-shaped, or a known token prefix after a `/` (`${HOME}/ghp_...`). */
const pieceIsSecret = (piece: string) => looksSecret(piece) || (piece.includes('/') && piece.split('/').some((part) => TOKEN_PREFIX.test(part)))

type Scanned = { text: string; secret: boolean }

/** A parsed JSON value with every credential redacted: a literal under a secret-named key, or one found by scanValue. */
function scanJson(value: unknown, depth: number, key: string | null): { value: unknown; secret: boolean } {
  if (typeof value === 'string') {
    if (key !== null && SECRET_NAME.test(key) && value !== '' && value !== REDACTED && !isReferenceOnly(value)) return { value: REDACTED, secret: true }
    const scanned = scanValue(value, depth + 1)
    return { value: scanned.text, secret: scanned.secret }
  }
  if (Array.isArray(value)) {
    const parts = value.map((entry) => scanJson(entry, depth, null))
    return { value: parts.map((part) => part.value), secret: parts.some((part) => part.secret) }
  }
  if (value !== null && typeof value === 'object') {
    const parts = Object.entries(value).map(([name, entry]) => [name, scanJson(entry, depth, name)] as const)
    return { value: Object.fromEntries(parts.map(([name, part]) => [name, part.value])), secret: parts.some(([, part]) => part.secret) }
  }
  return { value, secret: false }
}

/**
 * Every word inside a value, checked and redacted: a credential header (`Authorization: x`), an auth scheme and
 * its token (`Bearer x`, `Basic x`), then each piece (URL, word around separators and `${VAR}` references).
 * A value that parses as a JSON object or array is checked field by field. `${VAR}` references are never secret.
 */
function scanValue(value: string, depth = 0): Scanned {
  const trimmed = value.trim()
  if (depth < 8 && /^[{[]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const scanned = scanJson(parsed, depth, null)
      return scanned.secret ? { text: JSON.stringify(scanned.value), secret: true } : { text: value, secret: false }
    } catch {
      // Not JSON: scanned as text.
    }
  }
  let secret = false
  const text = value
    .replace(SECRET_HEADER, (whole, name: string, colon: string, rest: string) => {
      const left = rest.replace(REFERENCE, '').replace(/\b(Bearer|Basic)\b/gi, '').replaceAll(REDACTED, '').trim()
      if (left === '') return whole
      secret = true
      return `${name}${colon}${REDACTED}`
    })
    .replace(AUTH_SCHEME, (whole, scheme: string, space: string, token: string) => {
      if (isReferenceOnly(token) || token.startsWith(REDACTED)) return whole
      secret = true
      return `${scheme}${space}${REDACTED}`
    })
    .replace(PIECE, (piece) => {
      if (URL_LIKE.test(piece)) {
        if (!urlHasSecret(piece)) return piece
        secret = true
        return redactUrl(piece)
      }
      if (isReferenceOnly(piece) || !pieceIsSecret(piece)) return piece
      secret = true
      return REDACTED
    })
  return { text, secret }
}

/** Whether a value holds a credential anywhere inside it (every word checked; `${VAR}` references never count). */
export function textHasSecret(value: string): boolean {
  return scanValue(value).secret
}

/** One word after `previous`: what may be shown, and whether it hid a credential. */
function redactWord(previous: string | null, word: string): Scanned {
  const assignment = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/s.exec(word)
  if (assignment) {
    const [, name, value] = assignment
    if (SECRET_NAME.test(name) || looksSecret(value)) return { text: `${name}=${REDACTED}`, secret: true }
    if (URL_LIKE.test(value) && !/\s/.test(value)) return { text: `${name}=${redactUrl(value)}`, secret: urlHasSecret(value) }
    const scanned = scanValue(value)
    return { text: scanned.text === value ? word : `${name}=${scanned.text}`, secret: scanned.secret }
  }
  if (previous !== null && isSecretFlag(previous) && !word.startsWith('-') && !word.includes(REDACTED)) return { text: REDACTED, secret: true }
  if (looksSecret(word)) return { text: REDACTED, secret: true }
  if (URL_LIKE.test(word) && !/\s/.test(word)) return { text: redactUrl(word), secret: urlHasSecret(word) }
  return scanValue(word)
}

/** Command-line words with credentials replaced: `--api-key x`, `--token=x`, `-H x`, `KEY=x`, token-shaped words, URLs. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((word, i) => redactWord(i > 0 ? String(args[i - 1]) : null, String(word)).text)
}

/** Whether redactArgs would hide a credential in these words (a URL counts only when urlHasSecret says so). */
export function argsHaveSecret(args: readonly string[]): boolean {
  return args.some((word, i) => redactWord(i > 0 ? String(args[i - 1]) : null, String(word)).secret)
}

/** Shell words, a quoted string kept whole with what touches it, and the spaces between them. */
const SHELL_TOKEN = /\s+|(?:[^\s'"]+|'[^']*'?|"[^"]*"?)+/g

/**
 * A shell command (a hook) with credentials redacted: `Authorization: x` and `Bearer x` first, then every word as
 * in redactArgs, looking inside quotes. Spacing and quoting are kept where nothing changed.
 */
export function redactCommand(command: string): string {
  const text = command
    .replace(/\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie)(\s*:\s*)[^'"\n]*/gi, `$1$2${REDACTED}`)
    .replace(/\b(Bearer|Basic)(\s+)(?!<redacted>)[^\s'"]+/gi, `$1$2${REDACTED}`)
  let previous: string | null = null
  return (text.match(SHELL_TOKEN) ?? []).map((token) => {
    if (/^\s+$/.test(token)) return token
    const quote = /^(['"]).*\1$/s.exec(token)?.[1]
    const inner = quote ? token.slice(1, -1) : token
    const { text: shown } = redactWord(previous, inner)
    previous = inner
    return shown === inner ? token : quote ? `${quote}${shown}${quote}` : shown
  }).join('')
}
