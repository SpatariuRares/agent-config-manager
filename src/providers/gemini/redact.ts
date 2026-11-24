// Secret-safe text for items: MCP targets and hook commands lose anything that looks like a credential.
// Env values and headers are never read into an item at all; this covers what hides in args, URLs and commands.

export const REDACTED = '<redacted>'

/** A name that holds a credential: API_KEY, --token, access_token, password, Authorization... */
const SECRET_NAME = /(key|token|secret|passw(or)?d|pwd|auth|bearer|credential|cookie|session)/i
/** Values that look like a credential whatever their name: well-known prefixes, or a long opaque string. */
const SECRET_VALUE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpsr]-|AIza|ya29\.|eyJ)|^[A-Za-z0-9+/_=-]{40,}$/

/** An absolute path is a path, however long. */
const looksSecret = (value: string) => !value.startsWith('/') && SECRET_VALUE.test(value)

/** Command-line words with secret values replaced: `--api-key x`, `--token=x`, `KEY=x`, and token-shaped words. */
export function redactWords(words: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = String(words[i])
    const assignment = /^(-{0,2}[A-Za-z_][\w.-]*)=(.*)$/s.exec(word)
    if (assignment && (SECRET_NAME.test(assignment[1]) || looksSecret(assignment[2]))) out.push(`${assignment[1]}=${REDACTED}`)
    else if (looksSecret(word)) out.push(REDACTED)
    else if (i > 0 && /^-{1,2}[\w-]+$/.test(String(words[i - 1])) && SECRET_NAME.test(String(words[i - 1])) && !word.startsWith('-')) out.push(REDACTED)
    else out.push(word)
  }
  return out
}

/** A URL without its user info, and with every query value redacted. */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    const cut = url.split(/[?#]/)[0]
    return cut === url ? cut : `${cut}?${REDACTED}`
  }
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  const keys = [...new Set(parsed.searchParams.keys())]
  const query = keys.map((key) => `${encodeURIComponent(key)}=${REDACTED}`).join('&')
  parsed.search = ''
  return `${parsed.toString()}${query ? `?${query}` : ''}`
}

/** A shell command (a hook) with secret words redacted; quoting and spacing kept where nothing changed. */
export function redactCommand(command: string): string {
  return command
    .split(/(\s+)/)
    .map((part, i, parts) => {
      if (/^\s*$/.test(part)) return part
      const previous = i >= 2 ? parts[i - 2] : ''
      return redactWords(previous ? [previous, part] : [part]).at(-1)!
    })
    .join('')
}
