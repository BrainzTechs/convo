// Pure helpers for the coordinator feature: when convo is on, and how live
// chats are told apart. No engine calls here, so every rule is a plain test.

/** A session that has written no heartbeat for this long is gone. */
export const GONE_MS = 180_000

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

/** Another chat running in the coordinator's folder or below it, as its heartbeat file and its project folder tell. */
export type Peer = { sid: string; cwd: string; repo: string; mtimeMs: number; beat?: Beat }

/** Whether a chat is one the coordinator should show: alive, someone types into it, inside its folder, and not itself. */
export function isPeer(p: Peer, o: { coordCwd: string; selfSid: string; now: number }): boolean {
  return (
    isInside(o.coordCwd, p.cwd) &&
    o.now - p.mtimeMs < GONE_MS &&
    p.beat?.state !== 'ended' &&
    p.beat?.interactive !== false &&
    p.sid !== o.selfSid
  )
}

/** Working chats first, then the one started most recently; a chat without a beat goes by its file's time. */
export function ordered(peers: readonly Peer[]): Peer[] {
  const working = (p: Peer): number => (p.beat?.state === 'working' ? 1 : 0)
  return [...peers].sort((a, b) => working(b) - working(a) || (b.beat?.since ?? b.mtimeMs) - (a.beat?.since ?? a.mtimeMs))
}

/** A peer's folder as the coordinator names it: `.` for its own, worktrees as `wt <name>` (`backend/wt agent-a1b2`). */
export function relName(coordCwd: string, cwd: string): string {
  if (!isInside(coordCwd, cwd)) return cwd
  const root = trimSlashes(coordCwd)
  const rel = trimSlashes(cwd).slice(root === '/' ? 1 : root.length + 1)
  if (rel === '') return '.'
  return `/${rel}`.replace('/.claude/worktrees/', '/wt ').slice(1)
}

/**
 * Whether a chat is using `folder`: one works in it or below it, or holds it
 * (or a folder around it) for itself or a subagent. A folder merely under a
 * chat's own folder is free unless that chat has a subagent worktree whose
 * path is unknown, which could be this one.
 */
export function inUse(folder: string, peers: readonly Peer[]): boolean {
  return peers.some(p => {
    if (isInside(folder, p.cwd)) return true
    if ((p.beat?.holds ?? []).some(h => isInside(folder, h) || isInside(h, folder))) return true
    return isInside(p.cwd, folder) && (p.beat?.holdsUnknown ?? 0) > 0
  })
}

const OUTSIDE_CONVO = new Set(['cli', 'claude-desktop'])

/**
 * The session a transcript's first lines belong to, when it is a chat a person
 * types into (not an SDK run) inside `coordCwd`. `head` is cut at a byte
 * limit, so a last line may be torn: a line that does not parse is skipped.
 */
export function isUnseenHead(head: string, coordCwd: string): { sid: string } | undefined {
  for (const line of head.split('\n')) {
    let j: unknown
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof j !== 'object' || j === null) continue
    const { entrypoint, cwd, sessionId } = j as { entrypoint?: unknown; cwd?: unknown; sessionId?: unknown }
    if (typeof entrypoint === 'string' && OUTSIDE_CONVO.has(entrypoint) && typeof cwd === 'string' && typeof sessionId === 'string' && isInside(coordCwd, cwd)) return { sid: sessionId }
  }
  return undefined
}

/** How long, short, as the peers text says it: "41s", "3m", "2h", "1d". */
const lasted = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/**
 * What the peers tool tells Claude: a block for each live chat (where it runs, working or idle and for how
 * long, its prompt, its newest 3 turn subjects, the files it touched), the folders in use, and how many
 * chats here convo does not record. Each block names its folder from the coordinator, as the Live tab does; the folders in use are absolute paths.
 */
export function peersText(o: { coordCwd: string; peers: Peer[]; details: Map<string, { subjects: string[]; files: string[] }>; unseen: number; now: number }): string {
  const lines: string[] = []
  for (const p of o.peers) {
    const b = p.beat
    const state = b?.state === 'working' || b?.state === 'idle' ? `${b.state} ${lasted(o.now - b.since)}` : 'alive'
    lines.push(`${relName(o.coordCwd, p.cwd)}  ${p.sid.slice(0, 8)}  ${state}`)
    if (b?.prompt) lines.push(`  Prompt: ${b.prompt.length > 300 ? `${b.prompt.slice(0, 299)}…` : b.prompt}`)
    const d = o.details.get(p.sid)
    const subjects = d?.subjects.slice(0, 3) ?? []
    if (subjects.length) lines.push('  Last turns:', ...subjects.map(s => `    ${s}`))
    const files = d?.files ?? []
    if (files.length) lines.push(`  Files: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ` (+${files.length - 12} more)` : ''}`)
    lines.push('')
  }
  if (!o.peers.length) lines.push('No other chats are running here right now.', '')
  // Absolute paths here: Claude sets them against `git worktree list` to say what can be removed
  const used = [...new Set(o.peers.flatMap(p => [p.cwd, ...(p.beat?.holds ?? [])]))]
  const unknown = o.peers.flatMap(p => {
    const n = p.beat?.holdsUnknown ?? 0
    return n > 0 ? [`(and possibly any worktree under ${p.cwd}: ${n} ${n === 1 ? 'subagent' : 'subagents'} with a worktree)`] : []
  })
  lines.push(`In use: ${used.length ? [used.join(', '), ...unknown].join(' ') : 'nothing'}`)
  if (o.unseen > 0) lines.push(o.unseen === 1 ? "1 chat here isn't recorded by convo." : `${o.unseen} chats here aren't recorded by convo.`)
  return lines.join('\n')
}
