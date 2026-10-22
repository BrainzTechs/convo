// Usage history: this project's tokens and cost by day, across sessions.
// Each session's record (setup.ts's usage/<session>.json) adds every model
// request's tokens and, from Claude Code's own cost figure, what each turn
// cost; days before convo kept them are read once from the turns git holds
// (tokens only). Pure but for nothing: register.ts gathers, this sums and
// words it. After ccusage-style trackers.

import { k } from './ledger.ts'

/** One day's use: turns, input tokens (uncached, read from the cache, written to it), output tokens, and the cost where known. */
export type DayTotals = { turns: number; uncached: number; read: number; write: number; output: number; usd?: number; sessions?: number; uncosted?: number }

export const emptyDay = (): DayTotals => ({ turns: 0, uncached: 0, read: 0, write: 0, output: 0 })

/** A day's key in the machine's own time zone: 2026-10-23. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Adds one model request to a day. */
export function addRequest(days: Record<string, DayTotals>, day: string, r: { uncached: number; read: number; write: number; output: number }): void {
  const d = (days[day] ??= emptyDay())
  d.uncached += r.uncached
  d.read += r.read
  d.write += r.write
  d.output += r.output
}

/** Adds one finished turn, and what it cost when Claude Code says. */
export function addTurn(days: Record<string, DayTotals>, day: string, usd: number | undefined): void {
  const d = (days[day] ??= emptyDay())
  d.turns += 1
  if (usd !== undefined && usd >= 0) d.usd = (d.usd ?? 0) + usd
  else d.uncosted = (d.uncosted ?? 0) + 1
}

/**
 * Days from turn files' front matter as git grep prints it (`session:`,
 * `at:`, `usage:` lines, file by file), leaving out the sessions convo has
 * its own record of.
 */
export function daysFromHistory(lines: string, skip: ReadonlySet<string>): Record<string, DayTotals> {
  const days: Record<string, DayTotals> = {}
  const seen = new Set<string>()
  const sessionsOn: Record<string, Set<string>> = {}
  let session = ''
  let at = 0
  let isAgent = false
  let turnId = ''
  for (const line of lines.split('\n')) {
    const t = /^turnId: (\S+)/.exec(line)
    if (t?.[1]) {
      turnId = t[1]
      session = ''
      at = 0
      isAgent = false
      continue
    }
    const s = /^session: (\S+)/.exec(line)
    if (s?.[1]) {
      session = s[1]
      continue
    }
    if (/^agent: /.test(line)) {
      isAgent = true
      continue
    }
    const a = /^at: (\S+)/.exec(line)
    if (a?.[1]) {
      at = Date.parse(a[1]) || 0
      continue
    }
    const u = /^usage: \{ in: (\d+), out: (\d+), cacheRead: (\d+), cacheWrite: (\d+) \}/.exec(line)
    // A turn file a fork shares with its parent is one turn, wherever it shows up
    if (!u || !at || skip.has(session) || (turnId && seen.has(turnId))) continue
    if (turnId) seen.add(turnId)
    const day = dayOf(at)
    addRequest(days, day, { uncached: Number(u[1]), output: Number(u[2]), read: Number(u[3]), write: Number(u[4]) })
    // A subagent's tokens are this project's spend; its turns are not the person's
    if (!isAgent) addTurn(days, day, undefined)
    ;(sessionsOn[day] ??= new Set()).add(session)
  }
  for (const [day, set] of Object.entries(sessionsOn)) if (days[day]) days[day].sessions = set.size
  return days
}

/** Days summed across records; each record that touched a day counts as a session on it. */
export function sumDays(records: readonly Record<string, DayTotals>[]): Record<string, DayTotals> {
  const out: Record<string, DayTotals> = {}
  for (const r of records) {
    for (const [day, d] of Object.entries(r)) {
      const o = (out[day] ??= { ...emptyDay(), sessions: 0 })
      o.turns += d.turns
      o.uncached += d.uncached
      o.read += d.read
      o.write += d.write
      o.output += d.output
      if (d.usd !== undefined) o.usd = (o.usd ?? 0) + d.usd
      if (d.uncosted) o.uncosted = (o.uncosted ?? 0) + d.uncosted
      o.sessions = (o.sessions ?? 0) + (d.sessions ?? 1)
    }
  }
  return out
}

const input = (d: DayTotals): number => d.uncached + d.read + d.write
const money = (usd: number): string => `$${usd.toFixed(2)}`

/** The last `n` days' totals, newest first, today included. */
export function lastDays(days: Record<string, DayTotals>, now: number, n: number): [string, DayTotals][] {
  const out: [string, DayTotals][] = []
  for (let i = 0; i < n; i++) {
    const day = dayOf(now - i * 24 * 60 * 60_000)
    const d = days[day]
    if (d && (d.turns || input(d))) out.push([day, d])
  }
  return out
}

/** The pane's line: the last seven days here. */
export function weekLine(days: Record<string, DayTotals>, now: number): string | undefined {
  const week = lastDays(days, now, 7)
  if (!week.length) return undefined
  const t = sumDays(week.map(([day, d]) => ({ [day]: d })))
  const all = Object.values(t).reduce((s, d) => ({ turns: s.turns + d.turns, input: s.input + input(d), read: s.read + d.read, usd: d.usd === undefined ? s.usd : (s.usd ?? 0) + d.usd, uncosted: s.uncosted + (d.uncosted ?? 0) }), { turns: 0, input: 0, read: 0, usd: undefined as number | undefined, uncosted: 0 })
  const cost = all.usd !== undefined ? `${money(all.usd)}${all.uncosted ? ` for the turns convo priced (${all.uncosted} from before it did)` : ''}, ` : ''
  return `  this project, last 7 days: ${cost}${all.turns} turn${all.turns === 1 ? '' : 's'}, ${k(all.input)} in (${all.input ? Math.round((100 * all.read) / all.input) : 0}% from cache)`
}

/** The context tool's table: the last fourteen days, one line each. */
export function historyText(days: Record<string, DayTotals>, now: number): string {
  const rows = lastDays(days, now, 14)
  if (!rows.length) return 'No use recorded in this project in the last 14 days.'
  return [
    'This project, by day (tokens in: from cache / written to it / uncached; cost where Claude Code reported it):',
    ...rows.map(([day, d]) => `  ${day}: ${d.usd !== undefined ? `${money(d.usd)}${d.uncosted ? ` (${d.uncosted} turn${d.uncosted === 1 ? '' : 's'} not priced)` : ''}, ` : ''}${d.turns} turn${d.turns === 1 ? '' : 's'}${d.sessions ? ` in ${d.sessions} session${d.sessions === 1 ? '' : 's'}` : ''}, ${k(input(d))} in (${k(d.read)} / ${k(d.write)} / ${k(d.uncached)}), ${k(d.output)} out`),
  ].join('\n')
}
