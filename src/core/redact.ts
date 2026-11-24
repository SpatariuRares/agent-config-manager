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

/** Whether a URL carries a credential: user info, a secret-named query key, or a token-shaped query value. */
export function urlHasSecret(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return /\/\/[^/@\s]+@/.test(url) || [...url.matchAll(/[?&]([^=&#]*)=([^&#]*)/g)].some(([, k, v]) => SECRET_NAME.test(k) || looksSecret(v))
  }
  if (parsed.username || parsed.password) return true
  if ([...parsed.searchParams].some(([key, value]) => SECRET_NAME.test(key) || looksSecret(value))) return true
  return SECRET_NAME.test(parsed.hash)
}

/** A URL without its user info and fragment, and with every query value redacted. Unchanged when it has none. */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    const cut = url.split(/[?#]/)[0]
    return cut === url ? cut : `${cut}?${REDACTED}`
  }
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return url
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const keys = [...new Set(parsed.searchParams.keys())]
  const query = keys.map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join('&')
  parsed.search = ''
  return `${parsed.toString()}${query ? `?${query}` : ''}`
}

/** One word after `previous`: what may be shown, and whether it hid a credential. */
function redactWord(previous: string | null, word: string): { text: string; secret: boolean } {
  const assignment = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/s.exec(word)
  if (assignment) {
    const [, name, value] = assignment
    if (SECRET_NAME.test(name) || looksSecret(value)) return { text: `${name}=${REDACTED}`, secret: true }
    if (URL_LIKE.test(value)) return { text: `${name}=${redactUrl(value)}`, secret: urlHasSecret(value) }
    return { text: word, secret: false }
  }
  if (previous !== null && isSecretFlag(previous) && !word.startsWith('-') && !word.includes(REDACTED)) return { text: REDACTED, secret: true }
  if (looksSecret(word)) return { text: REDACTED, secret: true }
  if (URL_LIKE.test(word)) return { text: redactUrl(word), secret: urlHasSecret(word) }
  return { text: word, secret: false }
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
