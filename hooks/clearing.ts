// Clearing old tool output: the results of tool calls a few turns back,
// replaced in the context by a one-line stub that says what the call was and
// where git keeps it word for word. Pure: register.ts decides when, starts
// the compaction, and hands its messages here.
//
// Every message left alone is handed back by its `handle`, so the engine
// keeps it byte for byte. The prompt cache still has to take the conversation
// in again once: the request after a clearing reads its setup (system prompt,
// tools) from the cache and writes the rest, as measured live (a 138k request
// became a 29k read and a 34k write, then 85k reads). The cache finds an
// earlier prefix only a few blocks back from the request's end, and old
// output sits far from the end. So a clearing pays when the output it clears
// is a large share of the conversation.
//
// A mod can start a compaction its own hook answers only from turn.complete:
// Claude Code refuses one from prompt.submit, and one from a timer reaches no
// mod hook (a native summary runs). So clearing happens as a turn ends.

import type { SessionMessage } from 'claude-code'
import { messageTokens, tokensOf, turnStarts } from './checkpoint.ts'
import { toolNames } from './state.ts'

/** How every stub begins, so an output is never cleared twice. */
export const CLEARED = '[convo cleared'
/** The last turns are left whole: what Claude is working on now. */
export const KEEP_TURNS = 3
/** Outputs shorter than this stay: their stub would save little. */
export const MIN_CHARS = 1000
/** Tools whose output stays: a subagent's answer is already the distilled result. */
const KEPT_TOOLS = new Set(['Agent', 'Task', 'TodoWrite'])

/** Only a lot at once: the stretch after the first cleared output is cached again. */
export const MIN_TOKENS = 30_000
/**
 * And only when what is cached again is small beside what goes: re-caching
 * costs about 1.15× its tokens once (a write at 1.25× instead of a read at
 * 0.1×), each later request saves 0.1× the cleared tokens, so at 1.75 the
 * clearing has paid for itself within about 20 requests (the live run's:
 * about 4).
 */
export const RECACHE_RATIO = 1.75

export type ClearPlan = {
  /** tool_use_id → the stub that takes the output's place. */
  stubs: Map<string, string>
  /** The cleared outputs' tokens, less their stubs'. */
  tokens: number
  /** The first message that changes: everything before it stays cached. */
  first: number
  /** What is cached again after the clearing: the whole conversation, with the stubs in place. */
  recache: number
}

/** A call's input in a few words: its command, file, pattern or first string. */
export function briefInput(tool: string, input: Record<string, unknown> | undefined): string {
  const pick = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description']
  const s = input ? (pick.map(k => input[k]).find(v => typeof v === 'string') ?? Object.values(input).find(v => typeof v === 'string')) : undefined
  if (typeof s !== 'string' || !s.trim()) return tool
  const one = s.replace(/\s+/g, ' ').trim()
  return `${tool} ${one.length > 80 ? `${one.slice(0, 77)}…` : one}`
}

/** The line Claude reads in an output's place. */
export function stubFor(call: string, tokens: number, turn: number | undefined): string {
  const size = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  const where = turn !== undefined ? `${toolNames.turn} with n ${turn} reads it back` : `${toolNames.recall} finds it`
  return `${CLEARED} this output to save context: ${call}, ${size} tokens. It is kept word for word: ${where}.]`
}

/**
 * Which outputs to clear: every tool result before the last `keep` turns
 * that is long enough, not already a stub and not a kept tool's. `lastTurn`
 * is the number of the conversation's last turn, so each stub can name its
 * own; absent, the stubs point to recall instead.
 */
export function planClearing(messages: readonly SessionMessage[], o: { lastTurn?: number; keep?: number; minChars?: number } = {}): ClearPlan {
  const keep = o.keep ?? KEEP_TURNS
  const minChars = o.minChars ?? MIN_CHARS
  const starts = turnStarts(messages)
  const none: ClearPlan = { stubs: new Map(), tokens: 0, first: messages.length, recache: 0 }
  if (starts.length <= keep) return none
  const boundary = starts[starts.length - keep] ?? 0
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
  for (const m of messages) for (const u of m.toolUses) calls.set(u.tool_use_id, { tool: u.tool, input: u.input })
  const stubs = new Map<string, string>()
  let tokens = 0
  let first = messages.length
  let turnIndex = -1
  for (let i = 0; i < boundary; i++) {
    if (starts.includes(i)) turnIndex = starts.indexOf(i)
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    for (const r of m.toolResults ?? []) {
      const call = calls.get(r.tool_use_id)
      if (r.text.length < minChars || r.text.startsWith(CLEARED) || (call && KEPT_TOOLS.has(call.tool))) continue
      // Turns are numbered from the end: the conversation's last turn is lastTurn
      const turn = o.lastTurn !== undefined && turnIndex >= 0 ? o.lastTurn - (starts.length - 1 - turnIndex) : undefined
      const stub = stubFor(call ? briefInput(call.tool, call.input) : 'a tool call', tokensOf(r.text), turn !== undefined && turn >= 1 ? turn : undefined)
      stubs.set(r.tool_use_id, stub)
      tokens += tokensOf(r.text) - tokensOf(stub)
      first = Math.min(first, i)
    }
  }
  if (!stubs.size) return none
  const recache = messages.reduce((s, m) => s + messageTokens(m), 0) - tokens
  return { stubs, tokens, first, recache }
}

/**
 * The conversation with the plan's stubs in place. A message that changes is
 * built afresh from its text and results; every other one keeps its handle,
 * so the engine keeps it as it was, cache and all.
 */
export function applyClearing(messages: readonly SessionMessage[], plan: ClearPlan): SessionMessage[] {
  return messages.map(m => {
    if (m.role !== 'user' || !m.toolResults?.some(r => plan.stubs.has(r.tool_use_id))) return m
    return {
      role: 'user',
      text: m.text,
      toolUses: [],
      toolResults: m.toolResults.map(r => {
        const stub = plan.stubs.get(r.tool_use_id)
        return { tool_use_id: r.tool_use_id, text: stub ?? r.text, isError: r.isError }
      }),
    }
  })
}

/** Whether to clear now: a lot, and a large share of the conversation. */
export function shouldClear(plan: ClearPlan): boolean {
  return plan.stubs.size > 0 && plan.tokens >= MIN_TOKENS && plan.recache <= RECACHE_RATIO * plan.tokens
}
