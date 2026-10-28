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
