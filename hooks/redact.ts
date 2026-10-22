// Secret masking: everything convo writes to disk or hands back to Claude
// passes through `mask`. Two kinds of rule: token shapes recognised on
// their own, and `key = value` pairs whose key names a secret and whose
// value looks like one (so `const token = getToken(req)` stays as written).

const R = '[REDACTED]'

/** Credentials recognisable by their shape alone. */
const SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, // OpenAI project and service keys
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI and similar
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe secret and restricted keys
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bSK[0-9a-f]{32}\b/g, // Twilio API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  // A private key block, or what is left of one when the output was cut before its END line
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

/** Credentials inside a larger string: the part kept, then what is masked. */
const PARTS: [RegExp, string][] = [
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, `$1${R}`], // Slack webhooks
  [/((?<![\w+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{0,128}:)[^\s@/]{1,256}@/gi, `$1${R}@`], // scheme://user:password@host, user optional
  [/(\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${R}`],
  [/(\b(?:AccountKey|SharedAccessKey|sig)=)[^;&\s"']+/g, `$1${R}`], // Azure connection strings and SAS
]

/**
 * A key naming a secret (with any prefix: DB_PASSWORD, github_token,
 * "api_key" in JSON), then `:` or `=` but not `==`, then the value: quoted
 * whole, or unquoted up to a delimiter.
 */
const PAIR =
  /((?<![\w.-])[\w.-]{0,64}?(?:password|passwd|pwd|_pass|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)s?["']?[ \t]{0,8}(?::=|:|=(?!=))[ \t]{0,8})("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s"',;(){}\[\]]{1,512})/gi

const PLACEHOLDER = /^(?:\$\{.*\}|<.*>|\*+|x+|\.\.\.|…|\[REDACTED\]|null|none|true|false|undefined|string|number|boolean|required|optional)$/i

/** Whether a value after a secret-named key looks like an actual secret, not code or prose. */
function looksSecret(value: string, next: string): boolean {
  const quoted = /^["']/.test(value)
  const v = quoted ? value.slice(1, -1) : value
  if (!v || PLACEHOLDER.test(v) || v.startsWith('$')) return false
  if (quoted) return v.length >= 4
  // A call, a member chain or a type is code: getToken(req), process.env.X, string
  if (next === '(' || next === '.' || /^[A-Za-z_$][\w$]*\.[A-Za-z_$]/.test(v)) return false
  if (v.length >= 20) return true
  return v.length >= 6 && /\d/.test(v) && /[A-Za-z]/.test(v)
}

/** Replaces common credential formats with a placeholder. */
export function mask(s: string): string {
  let out = s
  for (const re of SHAPES) out = out.replace(re, R)
  for (const [re, to] of PARTS) out = out.replace(re, to)
  return out.replace(PAIR, (whole: string, key: string, value: string, offset: number, all: string) => {
    if (!looksSecret(value, all.charAt(offset + whole.length))) return whole
    const q = /^["']/.test(value) ? value.charAt(0) : ''
    return `${key}${q}${R}${q}`
  })
}
