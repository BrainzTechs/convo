// convo: every Claude Code conversation kept as git history.
//
// Each turn becomes one commit on `session/<id>` in a bare repo of its own at
// ~/.claude/convo/<project>/repo.git (private to the user); subagents get
// `agent/<session>/<id>` branches, forks and rewinds branch at the turn they
// came from, and compaction is answered with a keyframe built from git.
// Claude reads the history back through four tools: recall, turn, branches
// and merge; a fifth shows convo's pane beside the chat, which this file also
// draws from the view view.ts builds.
//
// Old tool output is cleared from the context, once a lot has piled up, by a
// compaction that keeps every other message as it was.
//
// A finished turn is written to a spool file and committed by a background
// timer, so turns never wait on git. The exceptions run where the engine is
// already busy: a compaction's keyframe, a merge Claude asked for, and a
// session switch's flush. A spool left behind by a session that ended early
// is committed by the next one.


import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { Io } from './io.ts'
import { messageTokens, tailStart, tokensOf, turnStarts } from './checkpoint.ts'
import { KEPT_DOORS, assembleTurn, refs, toBlocks, turnDir, type Row } from './turns.ts'
import { S, agentBase, agentRows, agentSession, agentsByToolUse, finishedAgents, lateAgents, resume, resumed, startText, agentCwds, worktreeAgents } from './state.ts'
import { transcriptOf, transcripts } from './rows.ts'
import { ensureRepo, projectRoot } from './repo.ts'
import { adoptOrphans, enqueue, flush, heartbeat } from './spool.ts'
import { SUMMARY_OPENING, noticeCompaction, recordCompaction, rowsFor, useSession } from './session.ts'
import { permit } from './permission.ts'
import { REFRESH_TURNS, briefSource, buildCheckpoint, buildOwed, refreshRecords } from './keyframes.ts'
import { BRIEF_DAYS, renderBrief } from './brief.ts'
import { branchList, mergeBranch, readTurn, recall, registerTools } from './tools.ts'
import { buildView, emptyView, type PaneRow } from './view.ts'
import { addAgentRun, addClearing, addCondensed, addStep, addToolOutput, emptyLedger, k, ledgerRows, readBreakdown } from './ledger.ts'
import { applyClearing, planClearing, shouldClear } from './clearing.ts'
import { condense } from './condense.ts'
import { mask } from './redact.ts'
import { addUsage, backfillUsage, emptyUsage, loadUsage, parseKeep, projectDays, saveUsage, setupSavings, shouldHoldBack, usedInWindow, type Usage } from './setup.ts'
import { addRequest, addTurn, dayOf, historyText, sumDays, weekLine } from './spend.ts'
import type { ConvoAgent, ConvoEntry, ConvoLedger, ConvoLive, ConvoUi, ConvoView } from '../types/index.d.ts'
import { coldToast, ttlOf, warmthOf } from './warmth.ts'
import { HANDBACK, called, endToast, finished, priced, returned, spawned, statusLine, statusOf, stepped, stuckOf, trimmed, weightOf } from './agents.ts'
import { panelNodes, type Action, type PanelButton } from './panel.ts'
import { buildTimeline, toolsLine, turnDetail } from './timeline.ts'
import { revOf } from './git.ts'
import { withTrailers } from './lineage.ts'
import { decideActive, parseExclude } from './live.ts'
import { collectLive } from './peers.ts'

/**
 * The engine as convo's modules use it. Claude Code follows `$` only into
 * functions of this file (2.1.296 and earlier refuse a module that hands it
 * across an import), so each call is spelled out here and the modules get
 * this in its place.
 */
function ioOf($: EngineInterface): Io {
  return {
    process: { run: (argv, init) => $.process.run(argv, init) },
    fs: {
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
      read: path => $.fs.read(path),
      stat: path => $.fs.stat(path),
      write: (path, text) => $.fs.write(path, text),
    },
    model: { complete: request => $.model.complete(request) },
    session: { messages: () => $.session.messages() },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    tool: { check: query => $.tool.check(query), register: spec => $.tool.register(spec) },
    ui: { ask: (question, options) => $.ui.ask(question, options), log: (text, options) => $.ui.log(text, options) },
  }
}

// ── The pane beside the chat ─────────────────────────────────────────
const PANE = 'convo'
const VIEW = { plugin: 'convo', key: 'view' } as const
/** What the published view was built from: the history's move count and, when checked, its refs. */
let published = { moved: -1, sid: '', refs: '', empty: false }

/**
 * Rebuilds the pane's view when the history moved: this process's commits
 * (S.moved) at once, another session's (a fork growing) when `look` reads
 * the refs. The view lives in session state; the pane redraws on its write.
 */
async function publish($: EngineInterface, look = false): Promise<void> {
  try {
    if (!S.gitOk) {
      await $.state.set(VIEW, emptyView(S.sid, S.offWhy || 'it has not started'))
      return
    }
    const io = ioOf($)
    // /resume and /clear switch the session with no event of their own: the tick notices, so the pane follows at once
    const id = await $.session.id().catch(() => S.sid)
    if (id && S.sid && id !== S.sid) await useSession(io, id)
    let refsNow = published.refs
    if (look) {
      const r = await io.process.run(['git', `--git-dir=${S.repo}`, 'for-each-ref', '--format=%(objectname)', 'refs/heads/'], { timeoutMs: 10_000 })
      refsNow = r.stdout
    }
    // A session with nothing of its own yet is looked at again on the slow tick: a resumed transcript may fill in after it
    // and a session's state starts empty, so the view is written again when the state lost it
    const shown = (await $.state.get(VIEW).catch(() => undefined))?.value
    if (published.moved === S.moved && published.sid === S.sid && published.refs === refsNow && !(look && published.empty) && shown?.sid === S.sid) return
    const at = { moved: S.moved, sid: S.sid }
    const view = await buildView(io, S.sid)
    lastTurns = view.turns
    turnsSince = 0
    await $.state.set(VIEW, view)
    published = { ...at, refs: look ? refsNow : published.refs, empty: !view.tip }
  } catch (err) {
    $.ui.log(`convo: the pane's view was not rebuilt: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

// ── The pane's tabs, and what its buttons do ─────────────────────────
const UI = { plugin: 'convo', key: 'ui' } as const

/** A pressed button: switch tab, open or close a turn (reading its detail from git), or put a prompt in the box. */
async function act($: EngineInterface, a: Action): Promise<void> {
  try {
    const ui: ConvoUi = (await $.state.get(UI)).value ?? { tab: 'history' }
    if (a.kind === 'tab') {
      await $.state.set(UI, { ...ui, tab: a.tab })
      // The Live tab opens on fresh rows, not on those of the last 15 s tick
      if (a.tab === 'live') void liveTick($, true)
    } else if (a.kind === 'fill') {
      await $.prompt.fill({ text: a.text, mode: 'replace' })
    } else if (ui.open === a.id) {
      await $.state.set(UI, { tab: ui.tab })
    } else {
      await $.state.set(UI, { tab: ui.tab, open: a.id })
      // An agent's or a peer's row opens on what the tab already holds
      if (a.id.startsWith('agent:') || a.id.startsWith('peer:')) return
      const detail = a.path && a.tip ? await turnDetail(ioOf($), a.tip, a.path) : undefined
      const now: ConvoUi = (await $.state.get(UI)).value ?? { tab: 'history' }
      if (now.open === a.id) await $.state.set(UI, { ...now, detail: detail ?? { asked: '', answer: '(not found in git yet: it is committed a moment after the turn ends)', tools: [], files: [] } })
    }
  } catch (err) {
    $.ui.log(`convo: the pane's ${a.kind} did not go through: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

// ── The other chats in this folder ───────────────────────────────────
// The Live tab. Nothing is scanned unless the pane is open: every 30 s a cheap scan keeps the tab's count
// (heartbeat files only), and every 15 s, while the Live tab is showing, the rows are read in full.
const LIVE = { plugin: 'convo', key: 'live' } as const
/** Whether convo's pane is placed beside the chat. */
let paneOpen = false
/** A tick still under way: a peer's git read can take 20 s, so the next tick waits for it. */
let liveBusy = false
/** The person's home folder, where session.start found it. */
let liveHome = ''

async function liveTick($: EngineInterface, full: boolean): Promise<void> {
  if (!paneOpen || liveBusy || !S.active) return
  liveBusy = true
  try {
    if (full && ((await $.state.get(UI)).value ?? { tab: 'history' }).tab !== 'live') return
    const prev: ConvoLive | undefined = (await $.state.get(LIVE).catch(() => undefined))?.value
    const live = await collectLive(ioOf($), { home: liveHome, coordCwd: S.cwd, selfSid: S.sid, projectsDir: S.projectsDir, now: Date.now(), full, ...(prev ? { prev } : {}) })
    // A cheap pass redraws only when the count moved
    if (full || live.working !== (prev?.working ?? 0)) await $.state.set(LIVE, live)
  } catch (err) {
    $.ui.log(`convo: the Live tab was not refreshed: ${String(err).slice(0, 200)}`, { to: 'debug' })
  } finally {
    liveBusy = false
  }
}

// ── Subagents as they run ────────────────────────────────────────────
// Each one's progress, kept from its events (agents.ts says what is kept);
// the session's state holds the list for the pane and across a reload.
const AGENTS = { plugin: 'convo', key: 'agents' } as const
const runs = new Map<string, ConvoAgent>()
/** Handback calls under way, whose results are not tool calls of the agent's. */
const handbacks = new Set<string>()
let runsDirty = false
/** What the session's requests have cost since convo started counting, against their price in list-price units (agents.ts weightOf). */
const pricing = { since: undefined as number | undefined, weight: 0, rate: 0 }
/** convo's own status line ("writing a keyframe…"), which goes before the agents' summary. */
let statusBase: string | undefined
let statusShown: string | undefined

const isLive = (a: ConvoAgent): boolean => a.status === 'running' || a.status === 'waiting'

const liveRun = (id: string): boolean => {
  const a = runs.get(id)
  return a !== undefined && isLive(a)
}

/** Worktree subagents still running whose folder is not known: the heartbeat only counts them. One given a folder is a hold instead. */
const worktreesRunning = (): number => [...worktreeAgents].filter(id => !agentCwds.has(id) && liveRun(id)).length

/** The folders running subagents were told to work in. */
const agentFolders = (): string[] => [...agentCwds].filter(([id]) => liveRun(id)).map(([, dir]) => dir)

/** The project folder this chat works in when it is not where it started (a worktree it moved into); none when it is the same. */
async function holdsOf($: EngineInterface): Promise<string[]> {
  try {
    const root = await $.session.root()
    return [...new Set([...(root && root !== S.cwd ? [root] : []), ...agentFolders()])]
  } catch {
    return agentFolders()
  }
}

/** The heartbeat in the background: a chat's state change never waits on a file write. */
function beatNow(io: Io): void {
  void heartbeat(io).catch(() => undefined)
}

function setRun(a: ConvoAgent): void {
  runs.set(a.id, a)
  runsDirty = true
}

/** The status line (Claude Code names convo before it): convo's own message when it has one, else the running agents' summary. */
function showStatus($: EngineInterface, base?: string | null): void {
  if (base !== undefined) statusBase = base ?? undefined
  const agents = statusLine([...runs.values()], Date.now())
  const text = statusBase ?? agents
  if (text === statusShown) return
  statusShown = text
  $.ui.status(text)
}

/** The rate the session's requests have cost, in dollars a list-price unit: an agent's cost is its requests at it. */
async function refreshRate($: EngineInterface): Promise<void> {
  const cost = (await $.session.usage().catch(() => undefined))?.cost?.usd
  if (cost === undefined) return
  // A cost lower than where counting began started over (/clear): counting does too
  if (pricing.since === undefined || cost < pricing.since) {
    pricing.since = cost
    pricing.weight = 0
  }
  if (pricing.weight > 0) pricing.rate = (cost - pricing.since) / pricing.weight
}

// ── How warm the prompt cache is ─────────────────────────────────────
// The Context tab counts down to the cached prefix expiring and prices the
// next send either side of it (warmth.ts); a toast when it has gone cold.
/** A request was seen reading the cache after more than five idle minutes: it lasts an hour here. */
let seenHour = false
/** The main thread's last request whose going cold was a toast already. */
let coldToastFor: number | undefined

/** Every 30 s: the cache's lifetime and the rate into the ledger, the countdown redrawn, and a toast once it is cold. */
async function tickCache($: EngineInterface): Promise<void> {
  try {
    const main = ledger?.last.main
    if (!ledger || !main) return
    await refreshRate($)
    const limits = (await $.session.usage().catch(() => undefined))?.rateLimits ?? []
    const ttl = ttlOf({ setting: settings.cacheTtl, seenHour, subscription: limits.some(r => /five_hour|seven_day/.test(r.kind)) })
    const cache = { ...ttl, rate: pricing.rate }
    const was = ledger.cache
    if (!was || was.ttl !== cache.ttl || was.from !== cache.from || Math.abs(was.rate - cache.rate) > was.rate * 0.01) {
      ledger = { ...ledger, cache }
      await saveLedger($)
    }
    const w = warmthOf(main, Date.now(), ttl, pricing.rate)
    if (w.state === 'cold' && coldToastFor !== main.at) {
      coldToastFor = main.at
      const toast = coldToast(w)
      if (toast) $.ui.toast(toast)
    }
    $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.log(`convo: the cache's warmth not shown: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

/** An agent that ended: kept as ended, and a toast when it is worth one. */
function endRun($: EngineInterface, a: ConvoAgent, how: 'done' | 'failed' | 'killed', answer?: string): void {
  if (!isLive(a)) return
  const done = finished(a, how, Date.now(), answer)
  const ended = pricing.rate > 0 ? priced(done, pricing.rate) : done
  setRun(ended)
  const toast = endToast(ended, Date.now())
  if (toast) $.ui.toast(toast)
}

/** Every 2 s while any agent runs: the engine's word on each one's state, stuck warnings, and the pane's copy. */
async function tickAgents($: EngineInterface): Promise<void> {
  try {
    const any = [...runs.values()].some(isLive)
    if (any) {
      await refreshRate($)
      // Every agent at the one rate, so their costs compare (the rate settles as the session's requests add up);
      // until a rate is known (just after a reload), an agent keeps the cost it had
      if (pricing.rate > 0) for (const a of runs.values()) runs.set(a.id, priced(a, pricing.rate))
      const list = await $.agent.list().catch(() => [])
      for (const info of list) {
        const a = runs.get(info.id)
        const word = statusOf(info.status)
        if (!a || !word || word === a.status) continue
        if (word === 'done' || word === 'failed' || word === 'killed') endRun($, a, word)
        else setRun({ ...a, status: word })
      }
      const now = Date.now()
      for (const a of runs.values()) {
        const stuck = stuckOf(a, now)
        if (stuck && !a.warned) {
          setRun({ ...a, warned: true })
          $.ui.toast(`subagent "${a.task}" looks stuck: ${stuck}`)
        }
      }
    }
    // While any runs, its elapsed time and current call change by the second: the pane is written each tick
    if (runsDirty || any) {
      runsDirty = false
      const kept = trimmed([...runs.values()])
      for (const id of [...runs.keys()]) if (!kept.some(a => a.id === id)) runs.delete(id)
      await $.state.set(AGENTS, kept)
    }
    showStatus($)
  } catch (err) {
    $.ui.log(`convo: subagents not followed: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

/** A subagent's history, read from its branch when the branch moved. */
let agentSeen: { agent: string; tip: string; history: ConvoEntry[] } | undefined
async function agentHistory(io: Io, agent: string): Promise<Pick<ConvoView, 'turns' | 'history' | 'tip'>> {
  const owner = agentSession.get(agent) ?? S.sid
  const tip = (await revOf(io, refs.agent(owner, agent))) ?? ''
  if (!tip) return { turns: 0, history: [] }
  if (agentSeen?.agent !== agent || agentSeen.tip !== tip) agentSeen = { agent, tip, history: await buildTimeline(io, tip) }
  return { turns: agentSeen.history.filter(x => x.kind === 'turn').length, history: agentSeen.history, tip }
}

// ── The token ledger ─────────────────────────────────────────────────
const LEDGER = { plugin: 'convo', key: 'ledger' } as const
/** This window's ledger; kept in session state too, so a reload of convo picks it up. */
let ledger: ConvoLedger | undefined
/** The number the main turn under way will get, for naming a cache miss. */
let turnNow: number | undefined
/** Turns on this line as the pane last counted them, and main turns finished since (still on their way to git). */
let lastTurns = 0
let turnsSince = 0

/** Writes the ledger where the pane reads it. */
async function saveLedger($: EngineInterface): Promise<void> {
  if (ledger) await $.state.set(LEDGER, ledger)
}

/** Tool output a turn's rows hold, by tool, in estimated tokens (3.5 characters a token). */
function toolOutputOf(rows: readonly Row[]): Record<string, number> {
  const names = new Map<string, string>()
  for (const r of rows) for (const b of r.blocks) if (b.type === 'tool_use') names.set(b.id, b.name)
  const out: Record<string, number> = {}
  for (const r of rows) {
    for (const b of r.blocks) {
      if (b.type !== 'tool_result') continue
      const name = names.get(b.toolUseId) ?? 'other'
      out[name] = (out[name] ?? 0) + Math.ceil(b.text.length / 3.5)
    }
  }
  return out
}

// ── What the setup could drop (measured only) ─────────────────────────
/** Built-in tools listed in front, each with its description's length; kept in the store, as tool.describe fires once a process. */
let toolSizes: Record<string, number> = {}
let toolSizesDirty = false
/**
 * Built-in tools convo held back behind ToolSearch in this process, each with its description's length. Kept in the
 * session's state too: Claude Code describes its tools once a process, so after a reload no tool.describe says it again.
 */
const heldTools: Record<string, number> = {}
const HELD = { plugin: 'convo', key: 'held' } as const
/** What the hold-back is judged on, read as the session starts; until then nothing is held back. */
let holdOn: { used: ReadonlySet<string>; days: number } | undefined
/** Whether ToolSearch is there to find a held-back tool: seen listed, here or in an earlier process. */
let toolSearchSeen = false
/**
 * /context's system tools tokens per character of the tools' descriptions, from a session that reported them: with
 * tools held back, Claude Code's breakdown leaves the system tools out, and convo estimates them at this rate.
 */
let toolRate: number | undefined
/** Tokens a character of tool description takes, until a /context breakdown has measured it: about four characters a token. */
const TOOL_RATE_GUESS = 0.25

/** The settings (/config, under convo), as the module was loaded with them. */
const settings = { compactAt: 0, clearOldOutput: true, holdBackTools: true, keepTools: new Set<string>(), condenseOutput: true, neverCondense: new Set<string>(), brief: true, cacheTtl: '' }

// ── The brief a new conversation starts with ─────────────────────────
// The first prompt of an empty conversation (a new session, or after /clear)
// carries where this project's last conversation left off, from the records
// convo keeps; those are brought up to date in the background every ten turns.
/** Sessions already briefed, or found not empty, in this process. */
const briefed = new Set<string>()
/** Main turns since the records were last brought up to date, and whether that is under way. */
let turnsSinceRefresh = 0
let refreshing = false

/** The brief for this prompt, when it opens an empty conversation and an earlier one here has notes. */
async function briefFor($: EngineInterface): Promise<string | undefined> {
  if (!settings.brief || briefed.has(S.sid)) return undefined
  briefed.add(S.sid)
  if ((await $.session.messages()).length) return undefined
  const src = await briefSource(ioOf($), S.sid, Date.now(), BRIEF_DAYS)
  const b = src ? renderBrief(src) : undefined
  if (!src || !b) return undefined
  ledger = { ...(ledger ?? emptyLedger(Date.now())), brief: { from: src.sid, ...b.counts, tokens: tokensOf(b.text) } }
  forNextCommit.brief = src.sid.slice(0, 8)
  await saveLedger($)
  return b.text
}

// ── Condensing tool output as it arrives ─────────────────────────────
// A long log reaches Claude as its errors and failures, the rest counted
// (condense.ts says how). The original is recorded for git as always, and kept
// beside it (outputs/<tool_use_id>.txt) so the turn tool reads it back at once.

/** Where condensed results' originals wait for the turn tool. */
const outputsDir = (): string => `${S.root}/outputs`

/** A tool result's text, when it is text alone; undefined when it holds an image or a document. */
function resultTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const c of content as { type?: unknown; text?: unknown }[]) {
    if (c?.type !== 'text') return undefined
    texts.push(String(c.text ?? ''))
  }
  return texts.join('\n')
}

/**
 * A tool-result row with its long results condensed, or undefined to append
 * it as it came. The tool and its input come from the loop's response rows.
 */
async function condensedRow(io: Io, agentId: string | undefined, content: readonly { type: string; [k: string]: unknown }[]): Promise<{ type: string; [k: string]: unknown }[] | undefined> {
  const calls = new Map<string, { name: string; input: unknown }>()
  for (const r of rowsFor(agentId)) for (const b of r.blocks) if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input })
  let changed = false
  const out: { type: string; [k: string]: unknown }[] = []
  for (const b of content) {
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
    const call = calls.get(id)
    const text = b.type === 'tool_result' && call ? resultTextOf(b.content) : undefined
    const c = text !== undefined && call ? condense({ tool: call.name, input: call.input, text, id, never: settings.neverCondense }) : undefined
    if (!c || text === undefined || !/^[\w-]{6,}$/.test(id)) {
      out.push(b)
      continue
    }
    await io.fs.write(`${outputsDir()}/${id}.txt`, mask(text))
    condensedNow.outputs += 1
    condensedNow.before += Math.ceil(c.before / 3.5)
    condensedNow.after += Math.ceil(c.after / 3.5)
    // And for the turn's own commit, by loop
    const loop = agentId ?? 'main'
    const t = condensedInTurn.get(loop) ?? { outputs: 0, before: 0, after: 0 }
    condensedInTurn.set(loop, { outputs: t.outputs + 1, before: t.before + Math.ceil(c.before / 3.5), after: t.after + Math.ceil(c.after / 3.5) })
    out.push({ ...b, content: c.text })
    changed = true
  }
  return changed ? out : undefined
}
/** Condensed in the turn under way, by loop ('main' or a subagent's id): its commit says so. */
const condensedInTurn = new Map<string, { outputs: number; before: number; after: number }>()
/** What the turn's commit records beside its files: the main turn's cost, a clearing since the last one, its brief. */
const forNextCommit: { usd?: number; cleared?: string; brief?: string } = {}

/** Condensed since the ledger last counted: added to it as each turn ends. */
const condensedNow = { outputs: 0, before: 0, after: 0 }
/** This session's use of tools, skills and agent types, and the session it belongs to. */
let usage: Usage = emptyUsage(Date.now())
let usageSid = ''
/** Other sessions' days in this project, read with the window. */
let others: Awaited<ReturnType<typeof projectDays>> = []
/** What the project used in the window, read from the records at most every ten minutes. */
let window: { at: number; w: Awaited<ReturnType<typeof usedInWindow>> } | undefined

/** This session's use record, started or picked up again when the session changed (/clear, /resume, a fork). */
async function usageFor(sid: string): Promise<Usage> {
  if (usageSid !== sid) {
    usageSid = sid
    usage = (await loadUsage(ioOfStatic, sid)) ?? emptyUsage(Date.now())
    window = undefined
  }
  return usage
}
/** The Io the usage records go through; set at session start. */
let ioOfStatic: Io
/** The session's cost as Claude Code had it at the last main turn: what each turn cost is what it rose by. */
let lastCostUsd: number | undefined

/**
 * A finished turn in the ledger: the tool output it added, a subagent's run,
 * and for the main thread the setup and conversation sizes /context reports
 * (counted locally, no tokens spent), the status line's cost, and what the
 * setup could drop.
 */
async function countTurn($: EngineInterface, agentId: string | undefined, rows: readonly Row[]): Promise<void> {
  try {
    let l = addToolOutput(ledger ?? emptyLedger(Date.now()), toolOutputOf(rows))
    if (condensedNow.outputs) {
      l = addCondensed(l, condensedNow)
      condensedNow.outputs = condensedNow.before = condensedNow.after = 0
    }
    const now = Date.now()
    if (S.gitOk) {
      usage = addUsage(await usageFor(S.sid), rows, now)
      await saveUsage(ioOfStatic, S.sid, usage)
    }
    if (agentId) l = addAgentRun(l)
    else {
      turnsSince += 1
      const u = await $.session.usage({ breakdown: 'summary' })
      const categories = u.context.breakdown?.categories ?? []
      l = { ...l, ...readBreakdown(categories), ...(u.cost ? { costUsd: u.cost.usd } : {}) }
      // This turn in the project's history: what the session's cost rose by since the last one
      if (S.gitOk) {
        const usd = u.cost?.usd
        const was = lastCostUsd ?? l.costBase
        // A cost lower than the last one started over (/clear, another session in this process): this turn cost all of it
        const turnUsd = usd !== undefined && was !== undefined ? (usd >= was ? usd - was : usd) : undefined
        addTurn((usage.days ??= {}), dayOf(now), turnUsd)
        forNextCommit.usd = turnUsd
        lastCostUsd = usd
        await saveUsage(ioOfStatic, S.sid, usage)
      }
      if (S.gitOk) {
        if (toolSizesDirty) {
          toolSizesDirty = false
          await $.store.set('tool-sizes', toolSizes)
          await $.state.set(HELD, { ...heldTools })
        }
        if (!window || now - window.at > 10 * 60_000) {
          // Judged on this project's use: what git holds from before convo kept records is read first, once
          await backfillUsage(ioOfStatic, now).catch(err => $.ui.log(`convo: no use history from git: ${String(err).slice(0, 200)}`, { to: 'debug' }))
          window = { at: now, w: await usedInWindow(ioOfStatic, now, usage) }
          others = await projectDays(ioOfStatic, S.sid, emptyUsage(now))
        }
        else window = { at: window.at, w: { ...window.w, used: { tools: new Set([...window.w.used.tools, ...Object.keys(usage.tools)]), skills: new Set([...window.w.used.skills, ...Object.keys(usage.skills)]), agents: new Set([...window.w.used.agents, ...Object.keys(usage.agents)]) } } }
        l.history = weekLine(sumDays([...others, usage.days ?? {}]), now)
        const b = u.context.breakdown
        l.compactAt = settings.compactAt || undefined
        l.autoCompactAt = u.context.breakdown?.autoCompactThreshold
        const frontChars = Object.values(toolSizes).reduce((s, n) => s + n, 0)
        let toolTokens = categories.find(c => /^system tools$/i.test(c.name))?.tokens ?? 0
        if (toolTokens > 0 && frontChars > 0) {
          const r = toolTokens / frontChars
          if (r !== toolRate) {
            toolRate = r
            await $.store.set('tool-rate', r)
          }
        } else if (frontChars) {
          // Left out of the breakdown: estimated at the rate an earlier session measured (or about four characters a token, before any did), and said so
          toolTokens = Math.round((toolRate ?? TOOL_RATE_GUESS) * frontChars)
          if (l.setup) l.setup = { total: l.setup.total + toolTokens, parts: [...l.setup.parts, ['System tools (estimated)', toolTokens] as [string, number]].sort((a, b) => b[1] - a[1]) }
        }
        l.trim = setupSavings({
          tools: Object.entries(toolSizes).map(([name, chars]) => ({ name, chars })),
          held: Object.entries(heldTools).map(([name, chars]) => ({ name, chars })),
          toolTokens,
          skills: (b?.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens })),
          agents: (b?.agents ?? []).map(a => ({ name: a.agentType, tokens: a.tokens })),
        }, window.w.used, window.w)
      }
    }
    ledger = l
    await saveLedger($)
  } catch (err) {
    $.ui.log(`convo: the ledger missed a turn: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

// ── Clearing old tool output ─────────────────────────────────────────
// Tool output a few turns back is replaced in the context by a stub naming
// the call and the turn git keeps it in, as a turn ends, once a lot has piled
// up (clearing.ts says when it pays, and why only then).
/** The clearing under way: convo's own session.compact hook answers it, and rows it appends are not a turn's. */
let clearing: { lastTurn?: number } | undefined
/** The number of the last finished main turn, so each stub can name its turn. */
let lastFinished: number | undefined
/** Why clearing is off in this session, when it is: not interactive (a plugin cannot compact in -p or the SDK yet). */
let clearingOff = ''

/** Clears old tool output now, when enough has piled up; says whether it did. Only from turn.complete: nowhere else does convo's hook get the compaction. */
async function clearOld($: EngineInterface): Promise<boolean> {
  if (!settings.clearOldOutput || clearingOff || clearing || !S.gitOk) return false
  try {
    const plan = planClearing(await $.session.messages(), { lastTurn: lastFinished })
    if (!shouldClear(plan)) return false
    clearing = { lastTurn: lastFinished }
    // The re-cache that follows is convo's doing, not a miss
    S.compactedAt = Date.now()
    const r = await $.session.compact({ instructions: 'convo: clearing old tool output' })
    if (r.skip !== undefined) $.ui.log(`convo: clearing skipped: ${r.skip}`, { to: 'debug' })
    // The next turn's commit says what was cleared before it
    else forNextCommit.cleared = `${k(plan.tokens)} tokens (${plan.stubs.size} output${plan.stubs.size === 1 ? '' : 's'})`
    return r.skip === undefined
  } catch (err) {
    const text = String(err)
    // A session that cannot compact from a plugin never will; anything else may pass (a turn that started meanwhile)
    if (/headless|not available/i.test(text)) clearingOff = 'a plugin cannot start a compaction in this session'
    $.ui.log(`convo: old tool output not cleared: ${text.slice(0, 200)}`, { to: 'debug' })
    return false
  } finally {
    clearing = undefined
  }
}

// ── Compacting earlier than Claude Code would ────────────────────────
// The `compactAt` setting: once the context reaches that many tokens, convo
// compacts with a keyframe as a turn ends, well before Claude Code's own
// limit (near the whole window). Off (0) by default.
/** The setting, in tokens; 0 leaves compaction to Claude Code. */
let compactAt = 0
/** A compaction convo started for the setting: its own hook builds the keyframe, as for an automatic one. */
let compacting = false
/** No early compaction below this: past one, the conversation must grow again first; past a failure, grow well past it. */
let compactAbove = 0
/** The first turn after a compaction measures what is left, and sets compactAbove from it. */
let measureNext = false

/** The least compactAt can be: a keyframe and the setup alone come near smaller ones. */
export const COMPACT_AT_MIN = 50_000

/** Compacts now when the context has reached the setting, with a keyframe; never natively. */
async function compactEarly($: EngineInterface): Promise<void> {
  if (!compactAt || clearingOff || clearing || compacting || !S.gitOk) return
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (measureNext) {
    // What a compaction left: the next one waits until a quarter of the setting has been added to it
    measureNext = false
    compactAbove = tokens + compactAt / 4
    return
  }
  if (tokens < compactAt || tokens < compactAbove) return
  compacting = true
  try {
    const r = await $.session.compact({})
    if (r.skip !== undefined) {
      measureNext = false
      compactAbove = tokens * 1.2
      $.ui.log(`convo: no early compaction: ${r.skip}`, { to: 'debug' })
    }
  } catch (err) {
    const text = String(err)
    if (/headless|not available/i.test(text)) clearingOff = 'a plugin cannot start a compaction in this session'
    $.ui.log(`convo: no early compaction: ${text.slice(0, 200)}`, { to: 'debug' })
  } finally {
    compacting = false
  }
}

// ── The context tool: what the manager does, and changing its settings ─
const SETTINGS = ['compactAt', 'clearOldOutput', 'holdBackTools', 'keepTools', 'condenseOutput', 'neverCondense', 'brief'] as const
type SettingKey = (typeof SETTINGS)[number]

/** The settings as they stand, in a few lines. */
function settingsText(): string {
  return [
    `compactAt: ${settings.compactAt ? `${settings.compactAt} tokens` : "0 (Claude Code's own limit)"}`,
    `clearOldOutput: ${settings.clearOldOutput ? 'on' : 'off'}`,
    `holdBackTools: ${settings.holdBackTools ? 'on' : 'off'}`,
    `keepTools: ${settings.keepTools.size ? [...settings.keepTools].join(', ') : '(none)'}`,
    `condenseOutput: ${settings.condenseOutput ? 'on' : 'off'}`,
    `neverCondense: ${settings.neverCondense.size ? [...settings.neverCondense].join(', ') : '(none)'}`,
    `brief: ${settings.brief ? 'on' : 'off'}`,
  ].join('\n')
}

/** A setting's value from the tool's input, checked; a reason when it does not fit. */
function settingValue(key: SettingKey, v: unknown): { value: number | boolean | string } | { why: string } {
  if (key === 'compactAt') {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return { why: 'compactAt takes a number of tokens' }
    if (n > 0 && n < COMPACT_AT_MIN) return { why: `compactAt is ${COMPACT_AT_MIN} tokens at least (or 0 to turn it off)` }
    return { value: Math.round(n) }
  }
  if (key === 'keepTools' || key === 'neverCondense') return typeof v === 'string' ? { value: [...parseKeep(v)].join(', ') } : { why: `${key} takes names, separated by commas` }
  return typeof v === 'boolean' ? { value: v } : { why: `${key} takes true or false` }
}

/**
 * The context tool: with no settings given, what the manager does now; with
 * some, asks the person, then changes them as /config would (convo reloads
 * with them; tools held back change from the next session).
 */
async function contextTool($: EngineInterface, input: { readonly [k: string]: unknown }): Promise<string> {
  const asked = SETTINGS.filter(key => input[key] !== undefined)
  // Asked before the first turn has ended: the project's other days are read now
  if (!window && S.gitOk) {
    const now = Date.now()
    await backfillUsage(ioOfStatic, now).catch(() => undefined)
    others = await projectDays(ioOfStatic, S.sid, emptyUsage(now))
  }
  const report = (): string => {
    const lines = ledgerRows(ledger, 100).map(r => r.text).filter(Boolean)
    const days = sumDays([...others, usage.days ?? {}])
    return [lines.length ? lines.join('\n') : 'No requests counted yet in this window.', '', historyText(days, Date.now()), '', 'Settings (/config, under convo):', settingsText()].join('\n')
  }
  if (!asked.length) return report()
  const changes: { key: SettingKey; value: number | boolean | string }[] = []
  for (const key of asked) {
    const v = settingValue(key, input[key])
    if ('why' in v) return `Not changed: ${v.why}.`
    changes.push({ key, value: v.value })
  }
  const what = changes.map(c => `${c.key} → ${typeof c.value === 'string' && !c.value ? '(none)' : String(c.value)}`).join(', ')
  let answer: string
  try {
    answer = await $.ui.ask(`Change convo's context settings: ${what}?`, { options: ['Change them', 'Leave them'], header: 'convo' })
  } catch {
    return `Not changed: changing convo's settings needs the person's yes, and nobody could be asked. They can change them in /config, under convo.`
  }
  if (answer !== 'Change them') return 'Not changed: the person chose to leave the settings as they are.'
  const rows = await $.config.list()
  const done: string[] = []
  for (const c of changes) {
    const row = rows.find(r => r.key.endsWith(`.${c.key}`) && (r.provider as { plugin?: string }).plugin === 'convo')
    if (!row) return `Not changed: ${c.key} is not in /config here (${done.length ? `changed so far: ${done.join(', ')}` : 'nothing changed'}).`
    const r = await $.config.set({ key: row.key, value: c.value })
    if ('deny' in r && r.deny) return `Not changed: ${c.key}: ${r.deny}${done.length ? ` (changed so far: ${done.join(', ')})` : ''}.`
    done.push(c.key)
  }
  const later = changes.some(c => c.key === 'holdBackTools' || c.key === 'keepTools') ? ' Which tools are held back changes from the next session, as Claude Code lists its tools once a session.' : ''
  return `Changed: ${what}. convo reloads with the new settings.${later}`
}

/** How each kind of row reads. */
function toneOf(tone: PaneRow['tone'] | 'bold'): Record<string, unknown> {
  if (tone === 'title' || tone === 'bold') return { bold: true }
  if (tone === 'dim') return { dimColor: true }
  if (tone === 'warn') return { color: 'warning' }
  if (tone === 'good') return { color: 'success' }
  return {}
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Readonly<Record<string, unknown>>
  const setting = Number(o.compactAt ?? 0)
  compactAt = Number.isFinite(setting) && setting > 0 ? Math.max(COMPACT_AT_MIN, setting) : 0
  settings.compactAt = compactAt
  settings.clearOldOutput = o.clearOldOutput !== false
  settings.holdBackTools = o.holdBackTools !== false
  settings.keepTools = parseKeep(o.keepTools)
  settings.condenseOutput = o.condenseOutput !== false
  settings.neverCondense = parseKeep(o.neverCondense)
  settings.brief = o.brief !== false
  settings.cacheTtl = typeof o.cacheTtl === 'string' ? o.cacheTtl.trim() : ''
  const excludeFolders = o.excludeFolders

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const verdict = decideActive({ isInteractive: e.isInteractive, force: await $.env.get('CONVO_FORCE'), cwd: e.cwd, exclude: parseExclude(excludeFolders, home) })
    S.active = verdict.active
    S.inactiveWhy = verdict.why
    if (!verdict.active) {
      $.ui.log(`convo: off in this session: ${verdict.why}`, { to: 'debug' })
      return next(e)
    }
    const io = ioOf($)
    ioOfStatic = io
    S.beat = { v: 1, state: 'idle', since: Date.now(), interactive: e.isInteractive, holds: [], holdsUnknown: 0 }
    const kept = await $.store.get('tool-sizes')
    if (kept && typeof kept === 'object' && !Object.keys(toolSizes).length) toolSizes = kept as Record<string, number>
    if (toolSizes.ToolSearch !== undefined) toolSearchSeen = true
    const rate = await $.store.get('tool-rate')
    if (typeof rate === 'number' && rate > 0) toolRate = rate
    // A reload: what this process held back before it
    if (!Object.keys(heldTools).length) Object.assign(heldTools, (await $.state.get(HELD).catch(() => undefined))?.value ?? {})
    S.cwd = e.cwd
    liveHome = home
    S.root = home ? await projectRoot(io, home, e.cwd) : ''
    S.repo = `${S.root}/repo.git`
    S.projectsDir = `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : '.')}/projects`
    await useSession(io, await $.session.id())
    const why = !home
      ? 'no home folder to keep history in'
      : (await $.env.get('OS')) === 'Windows_NT'
        ? 'Windows is not supported yet'
        : await ensureRepo(io)
    S.gitOk = why === undefined
    S.offWhy = why ?? ''
    // Subagents are followed whether or not history is on; a reload carries on with the list the session kept
    if (!runs.size) for (const a of (await $.state.get(AGENTS).catch(() => undefined))?.value ?? []) runs.set(a.id, a)
    // Requests are priced from here on: what the session cost before this process (a resume) is not theirs
    pricing.since = (await $.session.usage().catch(() => undefined))?.cost?.usd
    pricing.weight = 0
    $.clock.every(2000, () => tickAgents($))
    seenHour = (await $.store.get('cache-seen-1h').catch(() => undefined)) === true
    $.clock.every(30_000, () => tickCache($))
    $.clock.every(30_000, () => liveTick($, false))
    $.clock.every(15_000, () => liveTick($, true))
    if (!S.gitOk) {
      showStatus($, `history is off (${why})`)
    } else {
      $.clock.every(2000, () => flush(io))
      await heartbeat(io)
      $.clock.every(30_000, () => heartbeat(io))
      $.clock.after(5000, () => adoptOrphans(io))
      $.clock.every(300_000, () => adoptOrphans(io))
      await registerTools(io)
      // Originals of condensed output are kept a month; git keeps them for good
      void io.process.run(['find', `${S.root}/outputs`, '-type', 'f', '-mtime', '+30', '-delete'], { timeoutMs: 10_000 }).catch(() => undefined)
      // What this project used, for the tools held back when Claude Code first lists them (once a process)
      if (settings.holdBackTools) {
        try {
          const now = Date.now()
          await backfillUsage(io, now)
          const w = await usedInWindow(io, now, await usageFor(S.sid))
          holdOn = { used: w.used.tools, days: w.days }
        } catch (err) {
          $.ui.log(`convo: no tools held back: ${String(err).slice(0, 200)}`, { to: 'debug' })
        }
      }
      // The pane follows the history: after each flush, and every 30 s for other sessions' moves
      $.clock.every(2000, () => publish($))
      $.clock.every(30_000, () => publish($, true))
    }
    await publish($, true)
    // The ledger counts this window; a reload of convo carries on with what session state kept
    if (!ledger) {
      const kept = (await $.state.get(LEDGER)).value
      // A new window counts from the session's cost as it stands, so a resumed session's earlier spend is not its own
      ledger = kept ?? { ...emptyLedger(Date.now()), costBase: (await $.session.usage().catch(() => undefined))?.cost?.usd ?? 0 }
    }
    await saveLedger($)
    // Beside the chat on a wide enough screen, unless the person closed it; asking Claude brings it back
    if (e.isInteractive && (await $.store.get('pane-closed')) !== true) void $.ui.open({ id: PANE, title: 'convo' }).then(r => { paneOpen = r.isPlaced })
    clearingOff = e.isInteractive ? '' : 'a plugin cannot start a compaction outside an interactive session'
    return next(e)
  })

  // Each built-in tool as Claude Code lists it: its share of the setup, and, when this project has not used it, held
  // back behind ToolSearch (its name stays listed; Claude loads it when it needs it)
  on('tool.describe', async ($, e, next) => {
    if (!S.active) return next(e)
    const r = await next(e)
    const provider = e.provider as { plugin?: string }
    const deferred = r.isDeferred === undefined ? e.isDeferred === true : r.isDeferred === true
    if (provider.plugin !== 'engine') return r
    if (e.tool === 'ToolSearch') toolSearchSeen = true
    toolSizesDirty = true
    if (deferred) {
      delete toolSizes[e.tool]
      return r
    }
    if (holdOn && shouldHoldBack(e.tool, { on: settings.holdBackTools, toolSearch: toolSearchSeen, days: holdOn.days, used: holdOn.used, keep: settings.keepTools })) {
      heldTools[e.tool] = r.description.length
      delete toolSizes[e.tool]
      return { ...r, isDeferred: true }
    }
    delete heldTools[e.tool]
    toolSizes[e.tool] = r.description.length
    return r
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (!S.active) return next(e)
    paneOpen = false
    if (e.origin.kind === 'person') await $.store.set('pane-closed', true)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!S.active) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    let view = (await $.state.get(VIEW)).value
    const tokens = (await $.state.get(LEDGER)).value
    const ui: ConvoUi = (await $.state.get(UI)).value ?? { tab: 'history' }
    const width = Math.max(20, e.props.bodyColumns)
    // A subagent's transcript in view: its own branch's history
    const agent = e.props.view?.agentId
    if (agent && view && S.gitOk) {
      const history = await agentHistory(ioOf($), agent)
      view = { ...view, ...history, questions: [], lines: [], merges: [], context: undefined }
    }
    const agents = (await $.state.get(AGENTS)).value ?? []
    const live = (await $.state.get(LIVE)).value
    const nodes = panelNodes({ view, ledger: tokens, ui, width, now: Date.now(), focused: e.props.isFocused, agents, ...(live ? { live } : {}), ...(agent ? { agent } : {}) })
    // Drawn with h() rather than JSX, so this module stays a .ts file Node can run in the tests
    const button = (n: PanelButton): RenderElement => h(Button, { key: n.key, plain: true, ...(n.hotkey ? { hotkey: n.hotkey } : {}), ...(n.tone === 'dim' ? { dimColor: true } : {}), onPress: () => void act($, n.action) }, n.tone === 'bold' ? h(Text, { bold: true }, n.text) : n.text) as RenderElement
    return h(Box, { flexDirection: 'column' }, ...nodes.map(n => (n.t === 'text'
      ? h(Text, toneOf(n.tone), n.text || ' ')
      : n.t === 'row' ? h(Box, { flexDirection: 'row', columnGap: 3 }, ...n.items.map(button))
      : button(n)))) as RenderElement
  })

  // /resume however it runs (typed, or a plugin's $.command.run): the session switch that follows is a resume; one
  // the person cancelled leaves none pending
  on('command.run', { command: 'resume' }, async ($, e, next) => {
    if (!S.active) return next(e)
    resume.pending = true
    const r = await next(e)
    if (/cancel/i.test(r.text ?? '')) resume.pending = false
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (!S.active) return next(e)
    // Another session takes this one's place: a resume. Anything else (a /clear) is no resume
    resume.pending = e.reason === 'resume'
    S.beat = { ...S.beat, state: 'ended', since: Date.now() }
    beatNow(ioOf($))
    try {
      await flush(ioOf($))
    } catch {
      // What is left is committed by the next session here
    }
    return next(e)
  })

  // ── Rows: buffered per conversation until their turn ends ────────────
  on('session.append', { door: ['prompt', 'response', 'tool-result', 'command', 'delivery', 'compaction'] }, async ($, e, next) => {
    if (!S.active) return next(e)
    // A followed subagent's tool calls and their results: what it is doing now
    const run = e.agentId ? runs.get(e.agentId) : undefined
    if (run && (e.door === 'response' || e.door === 'tool-result')) {
      let a = run
      for (const b of (Array.isArray(e.message.content) ? e.message.content : []) as { type?: string; id?: string; tool_use_id?: string; name?: string; input?: unknown; is_error?: boolean }[]) {
        if (b.type === 'tool_use' && b.name) {
          // A handback is the agent's result, not a call: its own result is not counted either
          if (HANDBACK.has(b.name) && b.id) handbacks.add(b.id)
          a = called(a, b.name, b.input, Date.now())
        } else if (b.type === 'tool_result') {
          if (b.tool_use_id && handbacks.delete(b.tool_use_id)) continue
          a = returned(a, b.is_error === true, Date.now())
        }
      }
      if (a !== run) setRun(a)
    }
    // A long tool result reaches Claude condensed; what is recorded below, for git, is the original
    let sent = e
    if (settings.condenseOutput && S.gitOk && e.door === 'tool-result' && !clearing) {
      try {
        const content = await condensedRow(ioOf($), e.agentId, e.message.content as { type: string; [k: string]: unknown }[])
        if (content) sent = { ...e, message: { ...e.message, content: content as typeof e.message.content } }
      } catch (err) {
        $.ui.log(`convo: tool output not condensed: ${String(err).slice(0, 200)}`, { to: 'debug' })
      }
    }
    const result = await next(sent)
    // A clearing puts the conversation back with stubs in it: its rows are no turn's, and no summary to record
    if (clearing && !e.agentId) return result
    try {
      const blocks = toBlocks(e.message.content as { type: string; [k: string]: unknown }[])
      if (e.door === 'compaction') {
        // The summary row is the user-role one that opens as Claude Code's summaries do; the boundary notice carries no
        // text worth keeping, and the turns a compaction kept come back through this door too
        const summary = blocks.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
        if (e.message.type === 'user' && summary.includes(SUMMARY_OPENING) && !e.agentId) {
          S.compactedAt = Date.now()
          await recordCompaction(ioOf($), summary)
          // Held back: start the keyframe now, so the next prompt need not wait for it
          if (S.keyframeOwed) $.clock.after(0, () => buildOwed(ioOf($)))
        }
      } else if (KEPT_DOORS.has(e.door)) {
        rowsFor(e.agentId).push({ door: e.door, uuid: e.uuid, name: e.message.name, type: e.message.type, blocks })
      }
    } catch {
      // Recording never gets in the way of the conversation
    }
    return result
  }).catch(($, e, next) => next(e))

  // ── The tools ──────────────────────────────────────────────────────────
  // They read and write convo's own repo only. A mod serves its tools in a `tool.call` hook, which answers before
  // Claude Code's own permission step is reached, so convo asks here itself: reading this branch's own history
  // needs nothing; reading other sessions' history, listing them, and merging (which writes records and calls a
  // model) wait for the person, so an instruction injected into a turn cannot quietly pull another conversation in.
  // One hook serves all four; a registered tool's arguments arrive on the event itself, beside `tool`
  on('tool.call', { tool: ['mcp__convo__recall', 'mcp__convo__turn', 'mcp__convo__branches', 'mcp__convo__merge', 'mcp__convo__pane', 'mcp__convo__context'] }, async ($, e, next) => {
    if (!S.active) return next(e)
    if (e.tool === 'mcp__convo__context') return { result: await contextTool($, e as { readonly [k: string]: unknown }) }
    // Showing the pane reads nothing beyond what the person sees: no permission, and it works with history off
    if (e.tool === 'mcp__convo__pane') {
      await $.store.set('pane-closed', false)
      await publish($, true)
      const opened = await $.ui.open({ id: PANE, title: 'convo' })
      paneOpen = opened.isPlaced
      return { result: opened.isPlaced ? "convo's pane is open beside the chat." : `convo's pane is open but not shown here: ${opened.reason}.` }
    }
    if (!S.gitOk) return { result: `convo is off in this session: ${S.offWhy}.` }
    const input = e as { readonly [k: string]: unknown }
    const gate = await permit(ioOf($), e.tool, input)
    if (gate) return { deny: gate }
    try {
      if (e.tool === 'mcp__convo__recall') return { result: await recall(ioOf($), input) }
      if (e.tool === 'mcp__convo__turn') return { result: await readTurn(ioOf($), input) }
      if (e.tool === 'mcp__convo__branches') return { result: await branchList(ioOf($)) }
      return { result: await mergeBranch(ioOf($), input) }
    } catch (err) {
      return { result: `convo could not do that: ${String(err).slice(0, 300)}` }
    }
  }).catch(() => ({ deny: 'convo could not check whether this may run, so it did not.' }))

  // ── Compaction: a keyframe in place of the native summary ─────────────
  on('session.compact', async ($, e, next) => {
    if (!S.active) return next(e)
    // convo's own clearing: the same messages, old tool output stubbed; the engine keeps the rest as it was
    if (clearing && e.trigger === 'plugin' && !e.agentId) {
      const plan = planClearing(e.messages, { lastTurn: clearing.lastTurn })
      if (!plan.stubs.size) return { skip: 'convo: no old tool output to clear' }
      const before = e.messages.reduce((s, m) => s + messageTokens(m), 0)
      ledger = addClearing(ledger ?? emptyLedger(Date.now()), { outputs: plan.stubs.size, tokens: plan.tokens })
      await saveLedger($)
      $.ui.log(`convo: cleared ${plan.stubs.size} old tool outputs (${before} → ${before - plan.tokens} tokens, ${plan.recache} re-cached)`, { to: 'debug' })
      return { messages: applyClearing(e.messages, plan), tokensBefore: before, tokensAfter: before - plan.tokens }
    }
    if (!S.gitOk) return next(e)
    // The session compacting now, not the one the last event named (/resume and /clear fire no session.start)
    if (!e.agentId) await useSession(ioOf($), await $.session.id())
    // A subagent's own compaction stays native; so does one a plugin started, which is not held back either
    if (e.agentId) return next(e)
    if (e.trigger === 'plugin' && !compacting) {
      S.compactHookRan = true
      return next(e)
    }
    // Claude Code's automatic compaction must free room; convo's own early one keeps turns as a typed /compact does,
    // but must free at least 30%, and is never native
    const auto = e.trigger === 'auto'
    // No background summary is paid for that the keyframe would discard
    if (e.trigger === 'precompute') return { skip: 'convo builds a keyframe when the conversation compacts' }
    S.compactHookRan = true
    S.compactedAt = Date.now()
    // An early compaction waits for the conversation to grow again after this one
    measureNext = true
    // Each way back to native says why in the debug log (claude --debug), so a fallback is never silent; convo's own
    // early compaction is skipped instead (Claude Code still compacts at its own limit)
    const native = async (why: string): Promise<Awaited<ReturnType<typeof next>>> => {
      if (compacting) return { skip: `convo: no keyframe yet (${why}); Claude Code still compacts at its own limit` }
      $.ui.log(`convo: compacting natively: ${why}`, { to: 'debug' })
      return next(e)
    }
    const before = e.messages.reduce((s, m) => s + messageTokens(m), 0)
    // Automatic compaction must free room, so the kept turns stay under 40% of it; a typed /compact only caps them
    const tailCap = auto ? Math.min(40_000, Math.floor(before * 0.4)) : 40_000
    let from = tailStart(e.messages, 2, tailCap)
    // An early compaction keeps one turn when two would leave nothing before them, or most of the conversation
    if (compacting && from !== undefined && (from === 0 || e.messages.slice(from).reduce((s, m) => s + messageTokens(m), 0) > 0.5 * before)) {
      const one = tailStart(e.messages, 1, tailCap)
      if (one !== undefined && one > 0) from = one
    }
    // Even the last turn is too big to keep whole, or cut, or there is nothing before it: native does better
    if (from === undefined) return native(`the last turn is too big to keep whole or its tool calls are cut (${before} tokens in all)`)
    if (from === 0) return native('there is nothing before the turns kept word for word')
    const tail = e.messages.slice(from)
    const tailTokens = tail.reduce((s, m) => s + messageTokens(m), 0)
    // Turns the keyframe stands in for; one may be an earlier summary or keyframe, which git already covers
    const minTurns = Math.max(0, turnStarts(e.messages.slice(0, from)).length - 1)
    try {
      showStatus($, 'writing a keyframe…')
      // An automatic compaction must free room; a /compact the person typed gets the keyframe whatever the size
      const accept = (text: string): string | undefined => {
        const size = tokensOf(text) + tailTokens
        if (compacting && size > 0.7 * before) return `the keyframe would free less than 30% (${size} of ${before} tokens)`
        return auto && size >= before ? `the keyframe would not shrink the conversation (${size} ≥ ${before} tokens)` : undefined
      }
      const kf = await buildCheckpoint(ioOf($), { sid: S.sid, guidance: e.instructions, trigger: e.trigger, minTurns, accept })
      if (!kf) return native('this session has no turns in git yet')
      const after = tokensOf(kf.text) + tailTokens
      S.compactHookRan = false
      $.ui.log(`convo: keyframe ${kf.n} replaced the compaction (${before} → ${after} tokens)`, { to: 'debug' })
      return { messages: [{ role: 'user', text: kf.text, toolUses: [] }, ...tail], tokensBefore: before, tokensAfter: after }
    } catch (err) {
      // Fallback 1: native compaction runs, and its summary is recorded as a native keyframe
      return native(`the keyframe failed: ${String(err).slice(0, 200)}`)
    } finally {
      showStatus($, null)
    }
  }).catch(($, e, next) => next(e))

  // Fallback 2: where the guard holds the compaction hook back, the first
  // prompt after a native compaction carries the keyframe as context
  on('prompt.submit', async ($, e, next) => {
    if (!S.active) return next(e)
    if (!S.gitOk) return next(e)
    let extra: string | undefined
    try {
      // The switch comes after the picker, with no event of its own: the tick or the next prompt makes it, as a resume
      if (/^\/?resume$/.test(e.command?.name ?? '')) resume.pending = true
      await useSession(ioOf($), await $.session.id())
      if (e.command) return next(e)
      S.submittedAt = Date.now()
      await noticeCompaction(ioOf($))
      // Noticed only now (no compaction row reached the mod): build it here, with a short bound
      if (S.keyframeOwed && !S.owedRun && !S.owed && S.owedTries < 2) {
        showStatus($, 'writing a keyframe…')
        await buildOwed(ioOf($), 30_000)
      }
      if (S.owed?.sid === S.sid) {
        extra = S.owed.text
        S.owed = undefined
      }
    } catch (err) {
      $.ui.log(`convo: no keyframe for this prompt: ${String(err).slice(0, 200)}`, { to: 'debug' })
    } finally {
      showStatus($, null)
    }
    let brief: string | undefined
    try {
      brief = await briefFor($)
    } catch (err) {
      $.ui.log(`convo: no brief for this conversation: ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    const context = [...(e.context ?? []), ...(brief ? [brief] : []), ...(extra ? [extra] : [])]
    return next(context.length !== (e.context ?? []).length ? { ...e, context } : e)
  }).catch(($, e, next) => next(e))

  // The classic events name each session's transcript file exactly
  on('classic.SessionStart', async ($, e, next) => {
    transcripts.set(e.session_id, e.transcript_path)
    if (e.source === 'resume') resumed.add(e.session_id)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    transcripts.set(e.session_id, e.transcript_path)
    if (e.permission_mode) S.permissionMode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!S.active) return next(e)
    const r = await next(e)
    // Followed in the Agents tab; a teammate (long-lived, waiting for messages) is a team's, not followed here
    if (r.agentId && !e.isTeammate) {
      try {
        setRun(spawned({ id: r.agentId, type: e.subagentType, task: e.description || e.prompt.split('\n')[0]?.slice(0, 60) || '', ...(e.parentAgentId ? { parent: e.parentAgentId } : {}), background: e.background === true, model: r.model, ...(e.parentAgentId ? {} : { turn: turnNow }), at: Date.now() }))
      } catch {
        // Following never gets in the way of the agent
      }
    }
    // Where the subagent works, for the heartbeat: the folder the call set, or (its own worktree) a folder not known
    if (r.agentId && !e.isTeammate) {
      try {
        const rows = e.parentAgentId ? (agentRows.get(e.parentAgentId) ?? []) : S.mainRows
        const call = rows.flatMap(x => x.blocks).find(b => b.type === 'tool_use' && b.id === e.tool_use_id)
        const input = call?.type === 'tool_use' ? (call.input as { isolation?: unknown } | null | undefined) : undefined
        if (input?.isolation === 'worktree') worktreeAgents.add(r.agentId)
        if (e.cwd) agentCwds.set(r.agentId, e.cwd)
        if (worktreeAgents.has(r.agentId) || e.cwd) {
          S.beat = { ...S.beat, holds: await holdsOf($), holdsUnknown: worktreesRunning() }
          beatNow(ioOf($))
        }
      } catch {
        // Following never gets in the way of the agent
      }
    }
    if (r.agentId) {
      agentsByToolUse.set(e.tool_use_id, r.agentId)
      agentSession.set(r.agentId, S.sid)
      // The main turn's rows so far (a nested subagent's spawner is not named here, so it starts from the same point)
      agentBase.set(r.agentId, S.mainRows.map(x => x.uuid))
    }
    return r
  })

  // ── Turns ────────────────────────────────────────────────────────────
  // Each model request: its usage goes in the ledger, and a request that re-caches what was cached is a miss.
  // A streaming event: the hook passes the response through untouched and reads its usage at the end
  on('turn.step', async function* ($, e, next) {
    if (!S.active) return yield* next(e)
    const response = yield* next(e)
    try {
      const u = response.usage
      if (u) {
        // A main request that read the cache after more than five idle minutes: the cache lasts an hour here
        const prev = ledger?.last.main
        if (!e.agentId && !seenHour && prev && prev.input > 1000 && Date.now() - prev.at > 6 * 60_000 && u.cache_read_input_tokens >= 0.8 * prev.input) {
          seenHour = true
          await $.store.set('cache-seen-1h', true)
        }
        ledger = addStep(ledger ?? emptyLedger(Date.now()), { loop: e.agentId ?? 'main', model: u.model || e.model, at: Date.now(), uncached: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, output: u.output_tokens }, { compactedAt: S.compactedAt, turn: e.agentId ? undefined : turnNow })
        addRequest((usage.days ??= {}), dayOf(Date.now()), { uncached: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, output: u.output_tokens })
        await saveLedger($)
        // Every loop's request is priced, so a subagent's share of what the session costs can be told
        const step = { uncached: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, output: u.output_tokens }
        pricing.weight += weightOf(step, u.model || e.model)
        const a = e.agentId ? runs.get(e.agentId) : undefined
        if (a) setRun(stepped(a, { ...step, ...(u.model ? { model: u.model } : {}) }, Date.now()))
      }
    } catch {
      // Counting never gets in the way of the conversation
    }
    return response
  })

  on('turn.start', async ($, e, next) => {
    if (!S.active) return next(e)
    // The number this main turn will get: one past what this line holds
    if (!e.agentId) turnNow = lastTurns + turnsSince + 1
    // A finished subagent a message brought back: running again
    const back = e.agentId ? runs.get(e.agentId) : undefined
    if (back && !isLive(back)) {
      const { ended: _e, warned: _w, merged: _m, ...rest } = back
      setRun({ ...rest, status: 'running', lastAt: Date.now() })
    }
    // A changed session id means /clear, /branch, a fork or a rewind: a new branch
    await useSession(ioOf($), await $.session.id())
    startText.set(e.turnId, e.text)
    if (!e.agentId) {
      S.beat = { ...S.beat, state: 'working', since: Date.now(), prompt: mask(e.text).slice(0, 120), turns: turnNow, holds: await holdsOf($), holdsUnknown: worktreesRunning() }
      beatNow(ioOf($))
    }
    try {
      // prompt.submit already looked for this turn; a delivered turn (a notification) had none
      if (Date.now() - S.submittedAt > 10_000) await noticeCompaction(ioOf($))
    } catch {
      // Recording never gets in the way of the conversation
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!S.active) return next(e)
    const result = await next(e)
    // A followed subagent's run ended, by its answer, an error, or being stopped
    const run = e.agentId ? runs.get(e.agentId) : undefined
    if (run) await refreshRate($)
    if (run) endRun($, run, e.reason === 'error' || e.reason === 'refusal' ? 'failed' : e.reason === 'aborted' ? 'killed' : 'done', e.reason === 'answer' ? e.answer : undefined)
    // A subagent that ended no longer holds a worktree; the chat's own turn ending is idle
    if (e.agentId && (worktreeAgents.has(e.agentId) || agentCwds.has(e.agentId))) {
      S.beat = { ...S.beat, holds: await holdsOf($), holdsUnknown: worktreesRunning() }
      beatNow(ioOf($))
    }
    if (!e.agentId) {
      S.beat = { ...S.beat, state: 'idle', since: Date.now(), holds: await holdsOf($), holdsUnknown: worktreesRunning() }
      beatNow(ioOf($))
    }
    try {
      const agentId = e.agentId
      const rows = agentId ? (agentRows.get(agentId) ?? []) : S.mainRows
      await countTurn($, agentId, rows)
      if (agentId) agentRows.delete(agentId)
      else S.mainRows = []
      // A subagent's turn belongs to the session that spawned it, whatever the session is now
      const owner = agentId ? (agentSession.get(agentId) ?? S.sid) : S.sid
      const ref = agentId ? refs.agent(owner, agentId) : refs.session(S.sid)
      const at = new Date().toISOString()
      const usage = e.usage as Record<string, unknown> | undefined
      const out = await assembleTurn({
        turnId: e.turnId,
        sessionId: owner,
        agentId,
        startText: startText.get(e.turnId),
        rows,
        answer: e.answer ?? '',
        reason: e.reason,
        durationMs: e.durationMs,
        usage: usage as never,
        agents: agentsByToolUse,
        at,
      })
      startText.delete(e.turnId)
      // Main-thread turns carry their rows so the committer can tell a fork or rewind from a plain next turn
      if (agentId) finishedAgents.add(agentId)
      // Subagents this turn spawned that have finished: merged into the turn's commit (background ones still running are not)
      const spawned = rows.flatMap(r => r.blocks.flatMap(b => (b.type === 'tool_use' ? [agentsByToolUse.get(b.id)] : []))).filter((a): a is string => !!a && finishedAgents.has(a))
      // Background subagents that finished after their spawning turn: merged into this one, the turn their result reached
      const late = agentId ? [] : [...lateAgents].filter(([a, sid]) => sid === S.sid && !spawned.includes(a)).map(([a]) => a)
      const merging = [...spawned, ...late]
      for (const a of merging) {
        const r = runs.get(a)
        if (r && !agentId) setRun({ ...r, merged: turnNow })
      }
      // A subagent's branch starts where the turn that spawned it continues from (its rows so far say where)
      const baseRows = agentId ? (agentBase.get(agentId) ?? []) : []
      const lineage = agentId
        ? baseRows.length ? { baseRows, transcript: transcriptOf(owner) } : {}
        : { rows: rows.map(r => r.uuid), transcript: transcriptOf(S.sid), ...(merging.length ? { merge: merging.map(a => refs.agent(S.sid, a)) } : {}), ...(resumed.has(S.sid) ? { resumed: true } : {}) }
      // What the pane's History reads without opening the turn: tools, tokens, and for the main thread its cost, what was
      // condensed in it, cleared before it, and the brief it began with
      const loop = agentId ?? 'main'
      const used = rows.flatMap(r => r.blocks.flatMap(b => (b.type === 'tool_use' ? [b.name] : [])))
      const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      const tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      const cond = condensedInTurn.get(loop)
      condensedInTurn.delete(loop)
      const facts = [
        ...(used.length ? [`Tools: ${toolsLine(used)}`] : []),
        ...(tokensIn || u.output_tokens ? [`Tokens: in ${tokensIn}, out ${u.output_tokens ?? 0}`] : []),
        ...(cond ? [`Condensed: ${k(cond.before)} → ${k(cond.after)} tokens (${cond.outputs} output${cond.outputs === 1 ? '' : 's'})`] : []),
        ...(!agentId && forNextCommit.usd !== undefined ? [`Cost: ${forNextCommit.usd.toFixed(4)}`] : []),
        ...(!agentId && forNextCommit.cleared ? [`Cleared-Before: ${forNextCommit.cleared}`] : []),
        ...(!agentId && forNextCommit.brief ? [`Brief-From: ${forNextCommit.brief}`] : []),
      ]
      if (!agentId) {
        forNextCommit.usd = undefined
        forNextCommit.cleared = undefined
        forNextCommit.brief = undefined
      }
      await enqueue(ioOf($), { ref, base: agentId ? refs.session(owner) : undefined, numberIn: turnDir(agentId), files: out.files, message: withTrailers(out.message, facts), at, ...lineage })
      for (const a of late) lateAgents.delete(a)
      // A subagent whose spawning turn has already ended (a background one): the next main turn in its session merges it
      if (agentId && !S.mainRows.some(r => r.blocks.some(b => b.type === 'tool_use' && agentsByToolUse.get(b.id) === agentId))) {
        lateAgents.set(agentId, owner)
        finishedAgents.delete(agentId)
        agentSession.delete(agentId)
        agentBase.delete(agentId)
        for (const [k, v] of agentsByToolUse) if (v === agentId) agentsByToolUse.delete(k)
      }
      // Used once: a finished subagent's ids are not needed after the turn that merges it
      if (!agentId) {
        for (const a of spawned) {
          finishedAgents.delete(a)
          agentSession.delete(a)
          agentBase.delete(a)
        }
        for (const r of rows) for (const b of r.blocks) if (b.type === 'tool_use' && agentsByToolUse.has(b.id) && spawned.includes(agentsByToolUse.get(b.id) ?? '')) agentsByToolUse.delete(b.id)
      }
    } catch (err) {
      $.ui.log(`convo: turn not recorded: ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    if (!e.agentId) {
      lastFinished = turnNow
      // Clearing first, as it keeps every turn; the context's size after it is known only at the next request
      if (!(await clearOld($))) await compactEarly($)
      // Every ten turns, the records are brought up to date in the background, for the next conversation's brief
      turnsSinceRefresh += 1
      if (settings.brief && S.gitOk && !refreshing && turnsSinceRefresh >= REFRESH_TURNS) {
        refreshing = true
        turnsSinceRefresh = 0
        const io = ioOf($)
        const sid = S.sid
        $.clock.after(0, () =>
          refreshRecords(io, sid)
            .catch(err => $.ui.log(`convo: records not brought up to date: ${String(err).slice(0, 200)}`, { to: 'debug' }))
            .finally(() => {
              refreshing = false
            }),
        )
      }
    }
    return result
  })
}
