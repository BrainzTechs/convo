// Subagents as they run: what each is doing now, what it has cost so far,
// and whether it looks stuck. Fed by register.ts from the agent.spawn,
// turn.step, session.append and turn.complete events and the engine's agent
// list; the pane's Agents tab draws it. Pure: no engine calls here.

import type { ConvoAgent } from '../types/index.d.ts'
import { k } from './ledger.ts'

/** Tool calls kept per agent for its open row, newest last. */
export const RECENT = 8
/** No request or tool result for this long, while running: it looks stuck. */
export const STUCK_MS = 5 * 60_000
/** One tool call running this long: it looks stuck. */
export const LONG_CALL_MS = 5 * 60_000
/** The same call this many times in a row: it looks stuck. */
export const REPEATS = 3
/** Finished agents kept in the list. */
export const KEEP_DONE = 12

export function spawned(o: { id: string; type: string; task: string; parent?: string; background: boolean; model?: string; turn?: number; at: number }): ConvoAgent {
  return {
    id: o.id,
    type: o.type || 'agent',
    task: o.task.trim() || '(no description)',
    ...(o.parent ? { parent: o.parent } : {}),
    background: o.background,
    ...(o.model ? { model: o.model } : {}),
    ...(o.turn !== undefined ? { turn: o.turn } : {}),
    started: o.at,
    lastAt: o.at,
    status: 'running',
    requests: 0,
    tools: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    read: 0,
    usd: 0,
    recent: [],
    repeat: 0,
  }
}

/** One model request the agent made, with what it cost (the session's cost rose by `usd`). */
export function stepped(a: ConvoAgent, u: { uncached: number; read: number; write: number; output: number; usd?: number; model?: string }, at: number): ConvoAgent {
  return { ...a, requests: a.requests + 1, tokensIn: a.tokensIn + u.uncached + u.read + u.write, read: a.read + u.read, tokensOut: a.tokensOut + u.output, usd: a.usd + Math.max(0, u.usd ?? 0), ...(u.model ? { model: u.model } : {}), lastAt: at }
}

/** What a tool call is about, in a few words: the command, the file, the pattern. */
export function callDetail(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = ['command', 'pattern', 'file_path', 'url', 'query', 'path', 'description', 'prompt', 'skill']
  const s = pick.map(key => i[key]).find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? Object.values(i).find((v): v is string => typeof v === 'string') ?? ''
  const one = s.replace(/\s+/g, ' ').trim()
  const cut = one.length > 60 ? `${one.slice(0, 59)}…` : one
  return tool === 'Bash' || tool === 'Grep' || tool === 'Glob' ? (cut ? `"${cut}"` : '') : cut
}

/** A tool call the agent made. */
export function called(a: ConvoAgent, tool: string, input: unknown, at: number): ConvoAgent {
  const line = `${tool} ${callDetail(tool, input)}`.trim()
  const same = a.recent.at(-1) === line
  return { ...a, now: { tool, detail: callDetail(tool, input), since: at }, recent: [...a.recent, line].slice(-RECENT), repeat: same ? a.repeat + 1 : 0, lastAt: at }
}

/** A tool call's result came back. */
export function returned(a: ConvoAgent, isError: boolean, at: number): ConvoAgent {
  const { now: _done, ...rest } = a
  return { ...rest, tools: a.tools + 1, errors: a.errors + (isError ? 1 : 0), lastAt: at }
}

/** The agent ended: its answer, a failure, or stopped. */
export function finished(a: ConvoAgent, status: 'done' | 'failed' | 'killed', at: number): ConvoAgent {
  const { now: _done, ...rest } = a
  return { ...rest, status, ended: a.ended ?? at, lastAt: at }
}

/** The engine's word for an agent's state, as the list says it; undefined leaves ours. */
export function statusOf(engine: string): ConvoAgent['status'] | undefined {
  if (engine === 'completed') return 'done'
  if (engine === 'failed') return 'failed'
  if (engine === 'killed') return 'killed'
  if (engine === 'waiting' || engine === 'idle') return 'waiting'
  if (engine === 'running' || engine === 'pending') return 'running'
  return undefined
}

const live = (a: ConvoAgent): boolean => a.status === 'running' || a.status === 'waiting'

/** Why a running agent looks stuck, or undefined. */
export function stuckOf(a: ConvoAgent, now: number): string | undefined {
  if (a.status !== 'running') return undefined
  if (a.now && now - a.now.since > LONG_CALL_MS) return `in ${a.now.tool} for ${dur(now - a.now.since)}`
  if (a.repeat + 1 >= REPEATS) return `the same call ${a.repeat + 1} times in a row: ${a.recent.at(-1) ?? ''}`
  if (now - a.lastAt > STUCK_MS) return `nothing new for ${dur(now - a.lastAt)}`
  return undefined
}

/** "40s", "2m10s", "1h05m". */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const money = (usd: number): string => (usd < 0.005 ? '<$0.01' : `~$${usd.toFixed(2)}`)

/** The status line while any agent runs: how many, what they have cost, and how many look stuck. */
export function statusLine(agents: readonly ConvoAgent[], now: number): string | undefined {
  const running = agents.filter(live)
  if (!running.length) return undefined
  const usd = running.reduce((s, a) => s + a.usd, 0)
  const stuck = running.filter(a => stuckOf(a, now)).length
  return `${running.length} agent${running.length === 1 ? '' : 's'} running · ${money(usd)}${stuck ? ` · ${stuck} look${stuck === 1 ? 's' : ''} stuck` : ''}`
}

/** The list as the pane keeps it: every live agent, and the newest finished ones. */
export function trimmed(agents: readonly ConvoAgent[]): ConvoAgent[] {
  const done = agents.filter(a => !live(a)).sort((a, b) => (b.ended ?? b.lastAt) - (a.ended ?? a.lastAt)).slice(0, KEEP_DONE)
  const keep = new Set([...agents.filter(live), ...done].map(a => a.id))
  return agents.filter(a => keep.has(a.id))
}

/** In the order the pane lists them: live first (oldest first), then finished (newest first); each one's own subagents under it. */
export function ordered(agents: readonly ConvoAgent[]): { a: ConvoAgent; depth: number }[] {
  const ids = new Set(agents.map(a => a.id))
  const rank = (a: ConvoAgent): number => (live(a) ? a.started : Number.MAX_SAFE_INTEGER - (a.ended ?? a.lastAt))
  const sorted = [...agents].sort((a, b) => rank(a) - rank(b))
  const out: { a: ConvoAgent; depth: number }[] = []
  const walk = (parent: string | undefined, depth: number): void => {
    for (const a of sorted.filter(x => (x.parent && ids.has(x.parent) ? x.parent : undefined) === parent)) {
      out.push({ a, depth })
      if (depth < 4) walk(a.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

/** The second line of an agent's row: how long, how much, and how it runs. */
export function agentFacts(a: ConvoAgent, now: number): string {
  return [
    dur((a.ended ?? now) - a.started),
    `${a.requests} request${a.requests === 1 ? '' : 's'}`,
    a.tools ? `${a.tools} tool call${a.tools === 1 ? '' : 's'}${a.errors ? ` (${a.errors} failed)` : ''}` : '',
    a.tokensIn ? `${k(a.tokensIn)} in` : '',
    a.requests ? money(a.usd) : '',
    a.background ? 'background' : '',
  ].filter(Boolean).join(' · ')
}

/** The toast an agent's end is worth: a background one finishing, any one failing. */
export function endToast(a: ConvoAgent, now: number): string | undefined {
  const facts = `${a.requests} request${a.requests === 1 ? '' : 's'} · ${money(a.usd)} · ${dur((a.ended ?? now) - a.started)}`
  if (a.status === 'failed') return `convo: subagent "${a.task}" failed (${facts})`
  if (a.status === 'killed') return `convo: subagent "${a.task}" was stopped (${facts})`
  if (a.status === 'done' && a.background) return `convo: subagent "${a.task}" finished (${facts}); its work lands in your next turn`
  return undefined
}
