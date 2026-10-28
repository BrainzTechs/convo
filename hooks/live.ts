// Pure helpers for the coordinator feature: when convo is on, and (later) how
// live chats are told apart. No engine calls here, so every rule is a plain test.

const trimSlashes = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** Whether `path` is `parent` itself or anything inside it (`/a/momo` does not contain `/a/momopay`). */
export function isInside(parent: string, path: string): boolean {
  const a = trimSlashes(parent)
  const b = trimSlashes(path)
  return b === a || b.startsWith(a === '/' ? '/' : `${a}/`)
}

/** The folders convo stays off in, from a comma-separated setting: `~` expanded, only absolute paths kept. */
export function parseExclude(raw: unknown, home: string): string[] {
  if (typeof raw !== 'string') return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    let p = part.trim()
    if (p === '~' || p.startsWith('~/')) p = home ? home + p.slice(1) : ''
    if (!p.startsWith('/')) continue
    p = trimSlashes(p)
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Whether convo is on in this session. An excluded folder always wins; a
 * session nobody types into (`claude -p`, an agent run) is off unless
 * CONVO_FORCE=1 asks for it.
 */
export function decideActive(o: {
  isInteractive: boolean
  force: string | undefined
  cwd: string
  exclude: readonly string[]
}): { active: boolean; why: string } {
  const hit = o.exclude.find(p => isInside(p, o.cwd))
  if (hit !== undefined) return { active: false, why: `excluded folder ${hit}` }
  if (!o.isInteractive && o.force !== '1') return { active: false, why: 'not interactive' }
  return { active: true, why: '' }
}

/** What a chat's heartbeat file says: that it is alive, and what it is doing. */
export type Beat = {
  v: 1
  at: number
  state: 'working' | 'idle' | 'ended'
  since: number
  prompt?: string
  turns?: number
  interactive?: boolean
  holds?: string[]
  holdsUnknown?: number
}

/** A heartbeat file's text as a beat; `undefined` for the old bare timestamp, anything that is not JSON, or another version. */
export function parseBeat(text: string): Beat | undefined {
  try {
    const b: unknown = JSON.parse(text)
    if (typeof b !== 'object' || b === null || (b as { v?: unknown }).v !== 1) return undefined
    return b as Beat
  } catch {
    return undefined
  }
}

export const beatText = (b: Beat): string => JSON.stringify(b)
