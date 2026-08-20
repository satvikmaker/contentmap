/**
 * Credential screening for anything written to disk or printed.
 *
 * Remote loaders are the first part of this tool that handles secrets, and the
 * two obvious ways to leak one are the cache file (which lives in the project
 * and gets committed) and a diagnostic printed into CI logs. Both are screened.
 *
 * Deliberately precise rather than broad. Generic entropy heuristics flag
 * content hashes, and this codebase writes sha1 and sha256 digests everywhere,
 * so a false positive would fail builds for no reason. Two signals are used
 * instead: well-known credential prefixes, and exact matches against the value
 * of an environment variable whose NAME looks secret. The second is the strong
 * one — it catches a bespoke token no pattern would recognise.
 */

export class SecretLeakError extends Error {
  override readonly name = 'SecretLeakError'
  readonly hint: string
  readonly path: string
  constructor(where: string, path: string, reason: string) {
    super(`Refusing to write a credential into ${where} (at ${path}: ${reason})`)
    this.path = path
    this.hint =
      'Move the value into a header function, which is evaluated per request and never persisted. Values read from the environment must not end up in loader output.'
  }
}

interface Pattern {
  readonly test: RegExp
  readonly reason: string
}

const PATTERNS: readonly Pattern[] = [
  { test: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/, reason: 'looks like a bearer token' },
  { test: /\bsk-[A-Za-z0-9]{16,}/, reason: 'looks like an API secret key' },
  { test: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/, reason: 'looks like a GitHub token' },
  { test: /\bgithub_pat_[A-Za-z0-9_]{20,}/, reason: 'looks like a GitHub fine-grained token' },
  { test: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: 'looks like a Slack token' },
  { test: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'looks like an AWS access key id' },
  { test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'is a private key' },
  { test: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, reason: 'looks like a JWT' }
]

const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|APIKEY|AUTH)/i

/** Environment values worth protecting, longest first so the longest wins. */
function secretEnvValues(): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(process.env)) {
    // Short values produce false positives; a four-character "token" is not one.
    if (value && value.length >= 8 && SECRET_NAME.test(name)) out.push(value)
  }
  return out.sort((a, b) => b.length - a.length)
}

export function findSecret(text: string, envValues: readonly string[]): string | undefined {
  for (const value of envValues) {
    if (text.includes(value)) return 'matches an environment variable that looks like a credential'
  }
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) return pattern.reason
  }
  return undefined
}

/**
 * Walk a value and throw if any string looks like a credential.
 *
 * A hit is an error rather than a redaction: silently dropping a value the
 * caller believes was persisted produces a build that works once and fails
 * mysteriously later.
 */
export function screenForSecrets(value: unknown, where: string): void {
  const envValues = secretEnvValues()
  walk(value, '$', where, envValues, new Set())
}

function walk(
  value: unknown,
  path: string,
  where: string,
  envValues: readonly string[],
  seen: Set<object>
): void {
  if (typeof value === 'string') {
    const reason = findSecret(value, envValues)
    if (reason) throw new SecretLeakError(where, path, reason)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, where, envValues, seen))
    return
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const reason = findSecret(key, envValues)
    if (reason) throw new SecretLeakError(where, `${path}.${key}`, reason)
    walk(item, `${path}.${key}`, where, envValues, seen)
  }
}

/**
 * Mask credentials in text destined for a terminal or a log.
 *
 * Printing is not persistence, so here a redaction is the right answer: the
 * message still explains what failed, without putting the token in CI output.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const value of secretEnvValues()) {
    if (value.length >= 8) out = out.split(value).join('[redacted]')
  }
  for (const pattern of PATTERNS) {
    out = out.replace(new RegExp(pattern.test.source, 'g'), '[redacted]')
  }
  return out
}
