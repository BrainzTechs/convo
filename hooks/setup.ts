// The setup every request carries: what this project has not used lately,
// and their tokens. Built-in tools unused here are held back behind
// ToolSearch (their names stay listed; Claude loads one when it needs it);
// skills and agent types are measured only. register.ts records each
// session's use, reads the sizes Claude Code reports, answers tool.describe,
// and shows the result in the pane's Context section.

import type { Io } from './io.ts'
import type { Row } from './turns.ts'
import type { ConvoTrim } from '../types/index.d.ts'
import { S } from './state.ts'
import { git } from './git.ts'

const DAY = 24 * 60 * 60_000
/** How far back use counts. */
export const WINDOW_DAYS = 30
/** Agent types are known only from convo's own records: they count once a week of them exists. */
export const AGENT_DAYS = 7

/** Tools a session cannot do without, never counted as droppable. */
export const KEEP_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'ToolSearch',
  'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'BashOutput', 'KillShell',
])
/** Agent types always kept: the one Claude falls back on. */
export const KEEP_AGENTS = new Set(['general-purpose'])
/** Tools are held back only on a week of this project's use or more. */
export const HOLD_DAYS = 7

/** The keep setting's tool names: separated by commas or spaces. */
export const parseKeep = (s: unknown): Set<string> => new Set(typeof s === 'string' ? s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean) : [])

/**
 * Whether a built-in tool listed in front goes behind ToolSearch: with the
 * setting on, ToolSearch there to find it, a week of use to judge on, and the
 * tool neither core, kept by the person, nor used here.
 */
export function shouldHoldBack(tool: string, o: { on: boolean; toolSearch: boolean; days: number; used: ReadonlySet<string>; keep: ReadonlySet<string> }): boolean {
  return o.on && o.toolSearch && o.days >= HOLD_DAYS && !KEEP_TOOLS.has(tool) && !o.keep.has(tool) && !o.used.has(tool)
}

/** What one session used: names by kind, with the time each was last used. */
export type Usage = { started: number; tools: Record<string, number>; skills: Record<string, number>; agents: Record<string, number> }

export const emptyUsage = (started: number): Usage => ({ started, tools: {}, skills: {}, agents: {} })

/** A slash command's name from a command row's text: `<command-name>/x</command-name>` or a leading `/x`. */
export function commandName(text: string): string | undefined {
  const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text) ?? /^\/([\w:.-]+)/.exec(text.trim())
  return m?.[1]
}

/** Adds what a finished turn's rows used. */
export function addUsage(u: Usage, rows: readonly Row[], at: number): Usage {
  const out: Usage = { started: u.started, tools: { ...u.tools }, skills: { ...u.skills }, agents: { ...u.agents } }
  for (const r of rows) {
    for (const b of r.blocks) {
      if (b.type === 'tool_use') {
        out.tools[b.name] = at
        const i = (b.input ?? {}) as Record<string, unknown>
        if (b.name === 'Skill' && typeof i.skill === 'string') out.skills[i.skill] = at
        if (b.name === 'Agent' || b.name === 'Task') out.agents[typeof i.subagent_type === 'string' && i.subagent_type ? i.subagent_type : 'general-purpose'] = at
      } else if (b.type === 'text' && r.door === 'command') {
        const name = commandName(b.text)
        if (name) out.skills[name] = at
      }
    }
  }
  return out
}

/** Tool and skill names in turn files' tool lines and commands, as git grep prints them. */
export function namesFromHistory(toolLines: string, commandLines: string): { tools: string[]; skills: string[] } {
  const tools = new Set<string>()
  const skills = new Set<string>()
  for (const line of toolLines.split('\n')) {
    const m = /^- ([A-Za-z0-9_:.-]+) `(.*)`/.exec(line)
    if (!m?.[1]) continue
    tools.add(m[1])
    if (m[1] === 'Skill' && m[2]) skills.add(m[2].trim())
  }
  for (const line of commandLines.split('\n')) {
    const name = commandName(line)
    if (name) skills.add(name)
  }
  return { tools: [...tools], skills: [...skills] }
}

/** Whether `name` was used, a plugin skill under its short name too (`docx` for `anthropic-skills:docx`). */
const usedName = (used: ReadonlySet<string>, name: string): boolean => used.has(name) || used.has(name.slice(name.lastIndexOf(':') + 1))

export type SetupSizes = {
  /** Built-in tools listed in front, each with its description's length. */
  tools: { name: string; chars: number }[]
  /** Built-in tools convo held back, each with its description's length. */
  held?: { name: string; chars: number }[]
  /** /context's "System tools" tokens: shared among the tools by description length. */
  toolTokens: number
  skills: { name: string; tokens: number }[]
  agents: { name: string; tokens: number }[]
}

export type Used = { tools: ReadonlySet<string>; skills: ReadonlySet<string>; agents: ReadonlySet<string> }

/** What the setup could drop: what was not used, less what is always kept, largest first. */
export function setupSavings(sizes: SetupSizes, used: Used, o: { days: number; sessions: number; agentsCounted: boolean }): ConvoTrim {
  const chars = sizes.tools.reduce((s, t) => s + t.chars, 0)
  const share = (c: number): number => (chars ? Math.round((sizes.toolTokens * c) / chars) : 0)
  const byTokens = (a: [string, number], b: [string, number]): number => b[1] - a[1]
  const tools = sizes.tools.filter(t => !KEEP_TOOLS.has(t.name) && !used.tools.has(t.name)).map(t => [t.name, share(t.chars)] as [string, number]).sort(byTokens)
  // What held-back tools would take in front: their length at the rate the tools still listed take
  const held = (sizes.held ?? []).map(t => [t.name, share(t.chars)] as [string, number]).sort(byTokens)
  const skills = sizes.skills.filter(s => !usedName(used.skills, s.name)).map(s => [s.name, s.tokens] as [string, number]).sort(byTokens)
  const agents = o.agentsCounted ? sizes.agents.filter(a => !KEEP_AGENTS.has(a.name) && !used.agents.has(a.name)).map(a => [a.name, a.tokens] as [string, number]).sort(byTokens) : []
  const sum = (xs: [string, number][]): number => xs.reduce((s, [, n]) => s + n, 0)
  return { tokens: sum(tools) + sum(skills) + sum(agents), tools, skills, agents, held, heldTokens: sum(held), days: o.days, sessions: o.sessions, agentsCounted: o.agentsCounted }
}

// ── Records on disk ─────────────────────────────────────────────────────
// One file per session in the project's history folder (usage/<session>.json),
// so two sessions never write the same file; and usage/git.json, filled once
// from the turns git holds.

const usageDir = (): string => `${S.root}/usage`

/** Writes this session's record. */
export async function saveUsage(io: Io, sid: string, u: Usage): Promise<void> {
  await io.fs.write(`${usageDir()}/${sid}.json`, JSON.stringify(u))
}

/** Reads a session's record, if it has one. */
export async function loadUsage(io: Io, sid: string): Promise<Usage | undefined> {
  const p = `${usageDir()}/${sid}.json`
  if (!(await io.fs.exists(p))) return undefined
  try {
    return JSON.parse(await io.fs.read(p)) as Usage
  } catch {
    return undefined
  }
}

/** Fills usage/git.json from the turns of branches active in the window, once per project. */
export async function backfillUsage(io: Io, now: number): Promise<void> {
  const p = `${usageDir()}/git.json`
  if (await io.fs.exists(p)) return
  const since = now - WINDOW_DAYS * DAY
  const refs = await git(io, ['for-each-ref', '--format=%(committerdate:unix) %(objectname)', 'refs/heads/'])
  const tips = [...new Set((refs.ok ? refs.out.split('\n') : []).map(l => l.split(' ')).filter(([t]) => Number(t) * 1000 >= since).map(([, h]) => h ?? ''))].filter(Boolean).slice(0, 200)
  const first = await git(io, ['log', '--all', `--since=${Math.floor(since / 1000)}`, '--format=%ct'])
  const times = (first.ok ? first.out.split('\n') : []).map(Number).filter(n => n > 0)
  const started = times.length ? Math.min(...times) * 1000 : now
  let names = { tools: [] as string[], skills: [] as string[] }
  if (tips.length) {
    const tools = await git(io, ['grep', '-h', '-I', '-E', '^- [A-Za-z0-9_:.-]+ `', ...tips, '--'])
    const commands = await git(io, ['grep', '-h', '-I', '-A1', '^## Command', ...tips, '--'])
    names = namesFromHistory(tools.ok ? tools.out : '', commands.ok ? commands.out : '')
  }
  const u = emptyUsage(started)
  for (const t of names.tools) u.tools[t] = now
  for (const s of names.skills) u.skills[s] = now
  await io.fs.write(p, JSON.stringify(u))
}

/** Everything used in the window across this project's records, how many sessions, how many days, and whether agents count. */
export async function usedInWindow(io: Io, now: number, current: Usage): Promise<{ used: Used; days: number; sessions: number; agentsCounted: boolean }> {
  const since = now - WINDOW_DAYS * DAY
  const tools = new Set<string>()
  const skills = new Set<string>()
  const agents = new Set<string>()
  let earliest = current.started
  let earliestAgents = current.started
  let sessions = 0
  const add = (u: Usage, isGit: boolean): void => {
    for (const [n, at] of Object.entries(u.tools)) if (at >= since) tools.add(n)
    for (const [n, at] of Object.entries(u.skills)) if (at >= since) skills.add(n)
    for (const [n, at] of Object.entries(u.agents)) if (at >= since) agents.add(n)
    earliest = Math.min(earliest, Math.max(u.started, since))
    if (!isGit) earliestAgents = Math.min(earliestAgents, Math.max(u.started, since))
  }
  const dir = usageDir()
  const files = (await io.fs.exists(dir)) ? await io.fs.list(dir) : []
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue
    const p = `${dir}/${f.name}`
    try {
      if ((await io.fs.stat(p)).mtimeMs < since) continue
      const u = JSON.parse(await io.fs.read(p)) as Usage
      const isGit = f.name === 'git.json'
      add(u, isGit)
      if (!isGit) sessions += 1
    } catch {
      // A record half written by another session is read next time
    }
  }
  add(current, false)
  return {
    used: { tools, skills, agents },
    days: Math.max(0, Math.round((now - earliest) / DAY)),
    sessions,
    agentsCounted: now - earliestAgents >= AGENT_DAYS * DAY,
  }
}
