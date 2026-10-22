// The token ledger: where this window's tokens go, and when the prompt cache
// missed. Pure: register.ts feeds it each model request's usage (turn.step),
// each finished turn's tool output, and /context's breakdown; the pane shows
// ledgerRows.

import type { ConvoLedger, ConvoMiss, ConvoTrim } from '../types/index.d.ts'
import type { PaneRow } from './view.ts'
import { wrapRow } from './view.ts'

/** One model request as turn.step reports it. */
export type Step = {
  /** 'main', or the subagent's id: each loop has its own cache. */
  loop: string
  model: string
  at: number
  uncached: number
  read: number
  write: number
  output: number
}

/** A request re-caching at least this many tokens can be a miss; less is the turn's own new messages. */
const MISS_TOKENS = 2000
/** Longer than this between two requests of a loop, and the cache may have expired. */
const PAUSE_MS = 5 * 60_000
/** Misses kept for the pane, newest last. */
const MISSES_KEPT = 20

export const emptyLedger = (since: number): ConvoLedger => ({
  since,
  requests: 0,
  uncached: 0,
  read: 0,
  write: 0,
  output: 0,
  misses: [],
  expected: 0,
  agents: { runs: 0, tokens: 0, models: [] },
  toolOutput: {},
  last: {},
})

const inputOf = (s: { uncached: number; read: number; write: number }): number => s.uncached + s.read + s.write

/**
 * Adds one request. A request is a cache miss when it re-caches a good part
 * of what the loop's last request already had cached: its cache reads fall
 * well short of that request's whole input, and it writes a lot. The likely
 * cause, in order: a compaction since (expected: counted, not listed), a
 * pause long enough for the cache to expire, another model, else the start of
 * the request changed (system prompt, tools, or an earlier message).
 */
export function addStep(l: ConvoLedger, s: Step, o: { compactedAt?: number; turn?: number } = {}): ConvoLedger {
  const out: ConvoLedger = { ...l, misses: [...l.misses], agents: { ...l.agents, models: [...l.agents.models] }, last: { ...l.last } }
  out.requests += 1
  out.uncached += s.uncached
  out.read += s.read
  out.write += s.write
  out.output += s.output
  if (s.loop !== 'main') {
    out.agents.tokens += inputOf(s) + s.output
    if (!out.agents.models.includes(s.model)) out.agents.models.push(s.model)
  }
  const prev = l.last[s.loop]
  // The main thread's first request in this window caches the whole conversation: expected, and worth knowing
  if (!prev && s.loop === 'main') out.warmup = (l.warmup ?? 0) + s.write
  if (prev && s.write >= MISS_TOKENS && s.read < 0.5 * prev.input) {
    if (s.loop === 'main' && o.compactedAt !== undefined && o.compactedAt >= prev.at) {
      out.expected += 1
    } else {
      const gap = s.at - prev.at
      const why = gap > PAUSE_MS ? `the cache expired after ${Math.round(gap / 60_000)} minutes idle` : s.model !== prev.model ? `the model changed to ${s.model}` : 'the start of the request changed (system prompt, tools or an earlier message)'
      const miss: ConvoMiss = { at: s.at, loop: s.loop, tokens: s.write, why, ...(o.turn !== undefined ? { turn: o.turn } : {}) }
      out.misses = [...out.misses, miss].slice(-MISSES_KEPT)
      out.missTokens = (l.missTokens ?? 0) + s.write
    }
  }
  out.last[s.loop] = { at: s.at, model: s.model, input: inputOf(s) }
  return out
}

/** A subagent that ran: counted once, when its turn ends. */
export const addAgentRun = (l: ConvoLedger): ConvoLedger => ({ ...l, agents: { ...l.agents, runs: l.agents.runs + 1 } })

/** A clearing of old tool output: `tokens` is what left the context. */
export function addClearing(l: ConvoLedger, c: { outputs: number; tokens: number }): ConvoLedger {
  const was = l.cleared ?? { times: 0, outputs: 0, tokens: 0 }
  return { ...l, cleared: { times: was.times + 1, outputs: was.outputs + c.outputs, tokens: was.tokens + c.tokens } }
}

/** Tool output condensed as it arrived, in estimated tokens before and after. */
export function addCondensed(l: ConvoLedger, c: { outputs: number; before: number; after: number }): ConvoLedger {
  const was = l.condensed ?? { outputs: 0, before: 0, after: 0 }
  return { ...l, condensed: { outputs: was.outputs + c.outputs, before: was.before + c.before, after: was.after + c.after } }
}

/** Tool output a finished turn added to the context, by tool, in estimated tokens. */
export function addToolOutput(l: ConvoLedger, byTool: Readonly<Record<string, number>>): ConvoLedger {
  const toolOutput = { ...l.toolOutput }
  for (const [tool, n] of Object.entries(byTool)) toolOutput[tool] = (toolOutput[tool] ?? 0) + n
  return { ...l, toolOutput }
}

/** /context's categories as setup (sent with every request) and conversation, from its breakdown. */
export function readBreakdown(categories: readonly { name: string; tokens: number; kind?: string; isDeferred?: boolean }[]): Pick<ConvoLedger, 'setup' | 'conversation'> {
  const used = categories.filter(c => c.kind === 'used' && !c.isDeferred && c.tokens > 0)
  const isConversation = (name: string): boolean => /^messages$/i.test(name)
  const parts = used.filter(c => !isConversation(c.name)).map(c => [c.name, c.tokens] as [string, number]).sort((a, b) => b[1] - a[1])
  return { setup: { total: parts.reduce((t, [, n]) => t + n, 0), parts }, conversation: used.filter(c => isConversation(c.name)).reduce((t, c) => t + c.tokens, 0) }
}

/** Short token counts: 950, 12k, 1.2M. */
export function k(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 9_950_000 ? 0 : 1)}M`
  if (n >= 9_950) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** Names and sizes, largest first, a few of them. */
const listed = (xs: readonly [string, number][], most = 4): string => {
  const shown = xs.slice(0, most).map(([name, tokens]) => `${name} ${k(tokens)}`).join(', ')
  return xs.length > most ? `${shown} and ${xs.length - most} more` : shown
}

/** The setup's lines: what convo held back, and what it could also drop (measured only). */
export function trimRows(t: ConvoTrim | undefined): string[] {
  if (!t) return []
  const out: string[] = []
  if (t.held.length) out.push(`  held back ${k(t.heldTokens)} of tools unused here, behind ToolSearch: ${listed(t.held)}`)
  if (t.tokens < 1000) return out
  const n = (xs: readonly unknown[], one: string, many: string): string => `${xs.length} ${xs.length === 1 ? one : many}`
  const kinds = [t.tools.length ? n(t.tools, 'tool', 'tools') : '', t.skills.length ? n(t.skills, 'skill', 'skills') : '', t.agents.length ? n(t.agents, 'agent', 'agents') : ''].filter(Boolean).join(', ')
  const when = t.days >= 30 ? 'in the last 30 days' : t.days < 1 ? 'yet (convo has seen under a day here)' : `in the ${t.days === 1 ? 'day' : `${t.days} days`} convo has seen`
  out.push(`  could ${t.held.length ? 'also ' : ''}drop ${k(t.tokens)}: ${kinds} unused here ${when}${t.agentsCounted ? '' : ' (agents counted after a week)'}`)
  out.push(`    largest: ${listed([...t.tools, ...t.skills, ...t.agents].sort((a, b) => b[1] - a[1]), 5)}`)
  return out
}

/**
 * The pane's Context section: what every request carries (the setup, with
 * what convo held back), the conversation and what was cleared from it,
 * where it compacts, and the window's requests and cache.
 */
export function ledgerRows(l: ConvoLedger | undefined, width: number): PaneRow[] {
  if (!l || !l.requests) return []
  const rows: PaneRow[] = []
  const add = (text: string, tone?: PaneRow['tone']): void => {
    for (const t of wrapRow(text, width)) rows.push({ text: t, ...(tone ? { tone } : {}) })
  }
  const input = l.uncached + l.read + l.write
  add('')
  // The status line's cost is the session's, a resumed one's included: this window's share is what it rose by
  const cost = l.costUsd !== undefined ? l.costUsd - (l.costBase ?? 0) : undefined
  add(`Context · this window${cost !== undefined ? ` · $${cost.toFixed(2)}` : ''}`, 'title')
  if (l.brief) {
    const b = l.brief
    const what = [b.pins ? `${b.pins} pin${b.pins === 1 ? '' : 's'}` : '', b.decisions ? `${b.decisions} decision${b.decisions === 1 ? '' : 's'}` : '', b.tasks ? `${b.tasks} open task${b.tasks === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
    add(`  began with a brief from conversation ${b.from.slice(0, 8)}${what ? `: ${what}` : ''} (${k(b.tokens)})`, 'good')
  }
  if (l.setup?.total) add(`  every request carries ${k(l.setup.total)} of setup: ${l.setup.parts.slice(0, 3).map(([name, n]) => `${name.toLowerCase()} ${k(n)}`).join(', ')}`, 'dim')
  for (const r of trimRows(l.trim)) add(r, r.startsWith('  held back') ? 'good' : 'dim')
  const tools = Object.entries(l.toolOutput).sort((a, b) => b[1] - a[1])
  const toolTotal = tools.reduce((t, [, n]) => t + n, 0)
  if (l.conversation || toolTotal) {
    const conv = l.conversation ? `conversation now ${k(l.conversation)}` : ''
    const out = toolTotal ? `tool output added ${k(toolTotal)} (${tools.slice(0, 3).map(([t, n]) => `${t} ${k(n)}`).join(', ')})` : ''
    add(`  ${[conv, out].filter(Boolean).join('; ')}`, 'dim')
  }
  if (l.condensed?.outputs) {
    const c = l.condensed
    add(`  condensed ${k(c.before - c.after)} of tool output as it arrived (${c.outputs} output${c.outputs === 1 ? '' : 's'}, ${Math.round((100 * (c.before - c.after)) / Math.max(1, c.before))}% less); git keeps every word`, 'good')
  }
  if (l.cleared) {
    const c = l.cleared
    add(`  cleared ${k(c.tokens)} of old tool output from the context (${c.outputs} output${c.outputs === 1 ? '' : 's'}, ${c.times} time${c.times === 1 ? '' : 's'}); git keeps it`, 'good')
  }
  if (l.compactAt) add(`  compacts at ${k(l.compactAt)} with a keyframe (your setting)${l.autoCompactAt ? `; Claude Code's own limit ${k(l.autoCompactAt)}` : ''}`, 'dim')
  else if (l.autoCompactAt) add(`  compacts at Claude Code's limit, ${k(l.autoCompactAt)}, with a keyframe`, 'dim')
  add(`  ${k(input)} in over ${l.requests} request${l.requests === 1 ? '' : 's'}, ${k(l.output)} out`)
  const rate = input ? Math.round((100 * l.read) / input) : 0
  const misses = l.misses.length
  const warm = l.warmup && l.warmup >= MISS_TOKENS ? ` · ${k(l.warmup)} cached by the first request` : ''
  add(`  cache: ${rate}% read from cache${misses ? ` · ${misses} miss${misses === 1 ? '' : 'es'}, ${k(l.missTokens ?? 0)} re-cached` : ' · no misses'}${l.expected ? ` · ${l.expected} after compacting or clearing` : ''}${warm}`, misses ? 'warn' : 'good')
  for (const m of l.misses.slice(-3)) add(`    ${m.loop === 'main' ? (m.turn !== undefined ? `turn ${m.turn}` : 'a request') : 'a subagent'}: ${k(m.tokens)} re-cached, ${m.why}`, 'warn')
  if (l.agents.runs || l.agents.tokens) add(`  subagents: ${l.agents.runs} run${l.agents.runs === 1 ? '' : 's'}, ${k(l.agents.tokens)} tokens${l.agents.models.length ? ` (${l.agents.models.join(', ')})` : ''}`, 'dim')
  return rows
}
