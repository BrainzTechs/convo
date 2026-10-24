// How warm the prompt cache is: how long until the conversation's cached
// prefix expires, and what the next request costs either side of that.
// From the main thread's last request (when, its input, its output) and the
// cache's lifetime; priced with the same list-price units as subagents
// (agents.ts weightOf) at the rate the session's requests have cost. Pure.

import { tierOf } from './agents.ts'
import { k } from './ledger.ts'

export type Ttl = '5m' | '1h'
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
/** Below this many tokens a cold send costs little: no warning, no toast. */
export const WORTH_TOKENS = 20_000

export type Warmth = {
  state: 'warm' | 'cooling' | 'cold'
  /** Until it expires (warm, cooling), or since it did (cold). */
  ms: number
  ttl: Ttl
  /** Where the lifetime came from: convo's setting, a request seen warm past five minutes, or the plan. */
  ttlFrom: 'setting' | 'seen' | 'plan'
  /** What the next request sends again: the last one's input and output. */
  tokens: number
  /** What that costs read from the cache, and written to it again; absent while no rate is known. */
  warmUsd?: number
  coldUsd?: number
}

/**
 * The cache's lifetime: convo's setting when given; else an hour once a
 * request was seen reading the cache after more than five idle minutes; else
 * by the plan (a subscription, whose rate-limit windows the session reports,
 * caches for an hour; an API key for five minutes).
 */
export function ttlOf(o: { setting?: string; seenHour: boolean; subscription: boolean }): { ttl: Ttl; from: Warmth['ttlFrom'] } {
  if (o.setting === '5m' || o.setting === '1h') return { ttl: o.setting, from: 'setting' }
  if (o.seenHour) return { ttl: '1h', from: 'seen' }
  return { ttl: o.subscription ? '1h' : '5m', from: 'plan' }
}

/** The warmth now, from the main thread's last request. */
export function warmthOf(last: { at: number; model: string; input: number; output?: number }, now: number, ttl: { ttl: Ttl; from: Warmth['ttlFrom'] }, rate: number): Warmth {
  const life = TTL_MS[ttl.ttl]
  const idle = Math.max(0, now - last.at)
  const tokens = last.input + (last.output ?? 0)
  // A fifth of the lifetime, at most five minutes: the hour's last five, the five minutes' last one
  const soon = Math.min(5 * 60_000, life / 5)
  const state: Warmth['state'] = idle >= life ? 'cold' : life - idle <= soon ? 'cooling' : 'warm'
  const tier = tierOf(last.model)
  const priced = rate > 0 ? { warmUsd: tokens * 0.1 * tier * rate, coldUsd: tokens * 1.25 * tier * rate } : {}
  return { state, ms: state === 'cold' ? idle - life : life - idle, ttl: ttl.ttl, ttlFrom: ttl.from, tokens, ...priced }
}

/** "38m", "4m20s", "50s". */
export function left(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return `${m}m${String(s % 60).padStart(2, '0')}s`
  if (m < 120) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const money = (usd: number): string => (usd < 0.005 ? '<$0.01' : `~$${usd.toFixed(2)}`)

/** The Context tab's two lines, and how they read. */
export function warmthRows(w: Warmth): { text: string; tone: 'good' | 'warn' | 'dim' }[] {
  const from = w.ttlFrom === 'setting' ? 'your setting' : w.ttlFrom === 'seen' ? 'seen' : 'by plan'
  const head = w.state === 'cold'
    ? `  prompt cache: cold for ${left(w.ms)} (${w.ttl} cache, ${from})`
    : `  prompt cache: ${w.state === 'cooling' ? 'cooling' : 'warm'} · goes cold in ${left(w.ms)} (${w.ttl} cache, ${from})`
  const cost = (usd: number | undefined): string => (usd !== undefined ? ` (${money(usd)})` : '')
  const next = w.state === 'cold'
    ? `    the next send writes ${k(w.tokens)} to the cache again${cost(w.coldUsd)} instead of reading it${cost(w.warmUsd)}`
    : `    a send now reads ${k(w.tokens)} from the cache${cost(w.warmUsd)}; once cold it re-caches it${cost(w.coldUsd)}`
  const worth = w.tokens >= WORTH_TOKENS
  return [
    { text: head, tone: w.state === 'warm' ? 'good' : worth ? 'warn' : 'dim' },
    { text: next, tone: 'dim' },
  ]
}

/** The toast for a cache that has just gone cold, when the next send would cost a lot more for it. */
export function coldToast(w: Warmth): string | undefined {
  if (w.state !== 'cold' || w.tokens < WORTH_TOKENS) return undefined
  return `the prompt cache went cold: your next message writes ${k(w.tokens)} to it again${w.coldUsd !== undefined ? ` (${money(w.coldUsd)} instead of ${money(w.warmUsd ?? 0)})` : ''}`
}
