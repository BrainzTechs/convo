// The pane as a list of nodes, each a line of text or a pressable line, with
// what a press does: switch tab, open or close a turn, or put a ready prompt
// in the person's prompt box for them to send. Pure: register.ts draws the
// nodes with the surface's Box, Text and Button and runs the actions.
//
// Four tabs: History (this conversation's commits), Context (what every
// request carries, as a gauge and a few lines), Lines (forks, rewinds,
// merges, open questions) and Agents (subagents as they run).

import type { ConvoAgent, ConvoDetail, ConvoEntry, ConvoLedger, ConvoUi, ConvoView } from '../types/index.d.ts'
import type { PaneRow } from './view.ts'
import { paneRows, wrapRow } from './view.ts'
import { k, ledgerRows } from './ledger.ts'
import { agentFacts, dur, ordered, stuckOf } from './agents.ts'

export type Tab = ConvoUi['tab']
export type Action = { kind: 'tab'; tab: Tab } | { kind: 'toggle'; id: string; path?: string; tip?: string } | { kind: 'fill'; text: string }
export type Tone = PaneRow['tone'] | 'bold'
export type PanelButton = { t: 'button'; key: string; text: string; hotkey?: string; tone?: Tone; action: Action }
export type PanelNode =
  | { t: 'text'; text: string; tone?: Tone }
  | PanelButton
  /** Buttons side by side, as the tabs are. */
  | { t: 'row'; items: PanelButton[] }
/** A node of one line: a tab's own content is made of these. */
export type LineNode = Exclude<PanelNode, { t: 'row' }>

const TABS: [Tab, string][] = [['history', 'History'], ['context', 'Context'], ['lines', 'Lines'], ['agents', 'Agents']]

/** "now", "4m", "3h", "2d": how long ago, short. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (!Number.isFinite(s) || s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** A line cut to the width, with "…" when cut. */
const fit = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`)

/** The second line of a turn: tools, tokens, cost, what was condensed. */
export function turnFacts(e: ConvoEntry): string {
  return [
    e.tools,
    e.tokens ? `${k(e.tokens.in)} in` : '',
    e.usd !== undefined ? `$${e.usd.toFixed(2)}` : '',
    e.condensed ? `condensed ${e.condensed}` : '',
  ].filter(Boolean).join(' · ')
}

/** The History tab: one or two lines an entry, the open turn expanded with its actions. */
export function historyNodes(entries: readonly ConvoEntry[], ui: ConvoUi, width: number, now: number, tip?: string): LineNode[] {
  const out: LineNode[] = []
  if (!entries.length) return [{ t: 'text', text: 'Nothing recorded yet: each turn lands here when it ends.', tone: 'dim' }]
  for (const e of entries) {
    const when = ago(e.at, now).padEnd(4)
    if (e.kind === 'turn') {
      const n = String(e.n ?? '').padStart(3)
      const open = ui.open === e.id
      out.push({ t: 'button', key: `turn-${e.id}`, text: fit(`${open ? '▾' : '●'}${n}  ${when} ${e.title}`, width), action: { kind: 'toggle', id: e.id, ...(e.path ? { path: e.path } : {}), ...(tip ? { tip } : {}) } })
      const facts = turnFacts(e)
      if (facts) out.push({ t: 'text', text: fit(`│          ${facts}`, width), tone: 'dim' })
      if (e.mark) out.push({ t: 'text', text: fit(`│          ${e.mark}`, width), tone: 'dim' })
      if (e.brief) out.push({ t: 'text', text: fit(`│          began with a brief from ${e.brief}`, width), tone: 'dim' })
      for (const a of e.agents ?? []) {
        out.push({ t: 'button', key: `agent-${a.id}`, text: fit(`│╲ ⑂       ${a.title || `subagent ${a.id.slice(0, 8)}`}`, width), tone: 'dim', action: { kind: 'fill', text: `From convo's history, tell me what subagent ${a.id} did (merged in turn ${e.n}): what it was asked, what it ran, what it found.` } })
      }
      if (open) out.push(...detailNodes(e, ui.detail, width))
      if (e.clearedBefore) out.push({ t: 'text', text: fit(`✂         cleared ${e.clearedBefore} of old tool output`, width), tone: 'good' })
      continue
    }
    const glyph = e.kind === 'keyframe' ? '◆' : e.kind === 'native' ? '◇' : '⑃'
    const what = e.kind === 'keyframe' ? `keyframe ${e.n} · ${e.title}` : e.kind === 'native' ? `Claude Code's summary · ${e.title}` : `merged ${e.title}`
    out.push({ t: 'text', text: fit(`${glyph}     ${when} ${what}`, width), tone: e.kind === 'merge' ? 'good' : 'dim' })
  }
  return out
}

/** An open turn's lines: asked, answer, tools, files, tokens, and the button that asks for it in full. */
export function detailNodes(e: ConvoEntry, d: ConvoDetail | undefined, width: number): LineNode[] {
  const out: LineNode[] = []
  const add = (label: string, text: string): void => {
    // Room for the indent of the lines that follow, so none is cut
    for (const [i, line] of wrapRow(`${label}${text.replace(/\s+/g, ' ')}`, width - 6).entries()) out.push({ t: 'text', text: `${i ? '    ' : '  '}${line}`, tone: i ? 'dim' : undefined })
  }
  if (!d) {
    out.push({ t: 'text', text: '  reading the turn…', tone: 'dim' })
  } else {
    if (d.asked) add('asked:  ', d.asked.slice(0, 400))
    if (d.answer) add('answer: ', d.answer.slice(0, 400))
    for (const t of d.tools.slice(0, 8)) out.push({ t: 'text', text: fit(`  tool:   ${t}`, width), tone: 'dim' })
    if (d.tools.length > 8) out.push({ t: 'text', text: `  … ${d.tools.length - 8} more tools`, tone: 'dim' })
    if (d.files.length) add('files:  ', d.files.slice(0, 6).join(', ') + (d.files.length > 6 ? ` and ${d.files.length - 6} more` : ''))
  }
  out.push({ t: 'button', key: `full-${e.id}`, hotkey: 'r', text: `show turn ${e.n} in full`, action: { kind: 'fill', text: `Show me turn ${e.n} of this conversation in full with convo's turn tool.` } })
  return out
}

/** A gauge of the context against where it compacts. */
export function gauge(now: number, limit: number, width: number): string {
  const cells = Math.max(8, Math.min(40, width - 22))
  const filled = Math.min(cells, Math.round((cells * now) / Math.max(1, limit)))
  return `▕${'█'.repeat(filled)}${'░'.repeat(cells - filled)}▏ ${k(now)} / ${k(limit)}`
}

/** The Context tab: the gauge, then the ledger's lines. */
export function contextNodes(l: ConvoLedger | undefined, width: number): LineNode[] {
  if (!l?.requests) return [{ t: 'text', text: 'No requests counted yet in this window.', tone: 'dim' }]
  const out: LineNode[] = []
  const now = l.last.main?.input
  const limit = l.compactAt ?? l.autoCompactAt
  // The ledger's own line says where it compacts and how
  if (now && limit) out.push({ t: 'text', text: gauge(now, limit, width) })
  for (const r of ledgerRows(l, width)) if (r.text) out.push({ t: 'text', text: r.text, tone: r.tone })
  return out
}

/** The Lines tab: the other lines and questions as before, a fork with a button to merge it. */
export function linesNodes(view: ConvoView, width: number): LineNode[] {
  const out: LineNode[] = []
  const rows = paneRows(view, width).filter(r => r.text && !/^Session |^Claude (sees|works)|^Nothing recorded|^Ask Claude/.test(r.text))
  for (const r of rows) out.push({ t: 'text', text: r.text, tone: r.tone })
  for (const l of view.lines.filter(x => x.relation === 'split' || x.relation === 'ahead')) {
    const name = l.name.replace(/^session\//, '').slice(0, 8)
    const what = l.kind === 'rewound' ? `what was tried after the rewind (${l.name})` : `fork ${name}`
    out.push({ t: 'button', key: `merge-${l.name}`, text: `merge ${l.kind === 'rewound' ? 'the rewound turns' : `fork ${name}`}`, action: { kind: 'fill', text: `Merge ${what} into this conversation with convo.` } })
  }
  if (!out.length) out.push({ t: 'text', text: 'No other lines: forks, rewinds and merges show here.', tone: 'dim' })
  return out
}

const GLYPH: Record<ConvoAgent['status'], string> = { running: '⟳', waiting: '◌', done: '✓', failed: '✗', killed: '■' }

/**
 * The Agents tab: each subagent in two or three lines (what it is, what it
 * has taken, what it is doing or how it ended, and a warning when it looks
 * stuck); an open one adds its last tool calls and buttons that put a
 * request in the prompt box. Its own subagents are indented under it.
 */
export function agentNodes(agents: readonly ConvoAgent[], ui: ConvoUi, width: number, now: number): LineNode[] {
  if (!agents.length) return [{ t: 'text', text: 'No subagents in this session yet: each one shows here as it runs.', tone: 'dim' }]
  const out: LineNode[] = []
  for (const { a, depth } of ordered(agents)) {
    const pad = '  '.repeat(depth)
    const open = ui.open === `agent:${a.id}`
    const live = a.status === 'running' || a.status === 'waiting'
    out.push({ t: 'button', key: `agent-${a.id}`, text: fit(`${pad}${open ? '▾' : GLYPH[a.status]} ${a.type} · ${a.task}`, width), tone: live ? undefined : 'dim', action: { kind: 'toggle', id: `agent:${a.id}` } })
    out.push({ t: 'text', text: fit(`${pad}│   ${agentFacts(a, now)}`, width), tone: 'dim' })
    const where = a.status === 'running'
      ? a.now ? `now: ${a.now.tool}${a.now.detail ? ` ${a.now.detail}` : ''} (${dur(now - a.now.since)})` : 'thinking'
      : a.status === 'waiting' ? 'waiting for a message'
      : a.status === 'failed' ? 'failed'
      : a.status === 'killed' ? 'stopped'
      : a.merged !== undefined ? `merged into turn ${a.merged}` : a.background ? 'finished; lands in your next turn' : 'finished'
    out.push({ t: 'text', text: fit(`${pad}│   ${where}`, width), tone: a.status === 'failed' ? 'warn' : a.status === 'running' ? undefined : 'dim' })
    const stuck = stuckOf(a, now)
    if (stuck) out.push({ t: 'text', text: fit(`${pad}│   ⚠ looks stuck: ${stuck}`, width), tone: 'warn' })
    if (!open) continue
    for (const line of a.recent) out.push({ t: 'text', text: fit(`${pad}    · ${line}`, width), tone: 'dim' })
    if (!a.recent.length) out.push({ t: 'text', text: `${pad}    no tool calls yet`, tone: 'dim' })
    const named = `subagent ${a.id} ("${a.task}")`
    if (live) {
      out.push({ t: 'button', key: `agent-msg-${a.id}`, text: `${pad}  message it`, action: { kind: 'fill', text: `Send ${named} this message: ` } })
      out.push({ t: 'button', key: `agent-stop-${a.id}`, text: `${pad}  stop it`, action: { kind: 'fill', text: `Stop ${named}.` } })
    } else {
      out.push({ t: 'button', key: `agent-found-${a.id}`, text: `${pad}  what it found`, action: { kind: 'fill', text: `From convo's history, tell me what ${named} did: what it was asked, what it ran, what it found.` } })
    }
  }
  return out
}

/** The whole pane: a header, the tabs, the tab's nodes, and how to use it. */
export function panelNodes(o: { view: ConvoView | undefined; ledger: ConvoLedger | undefined; ui: ConvoUi; width: number; now: number; focused: boolean; agent?: string; agents?: readonly ConvoAgent[] }): PanelNode[] {
  const { view, ui, width } = o
  if (!view) return [{ t: 'text', text: 'Reading this conversation’s history…', tone: 'dim' }]
  if (view.off) return [{ t: 'text', text: `History is off in this session: ${view.off}.`, tone: 'warn' }]
  const sees = !view.turns ? '' : view.context ? ` · from ${view.context.kind === 'keyframe' ? `keyframe ${view.context.n}` : 'a summary'} + ${view.context.turnsSince}` : ' · all in view'
  const who = o.agent ? `subagent ${o.agent.slice(0, 10)}` : `${view.sid.slice(0, 8)}${view.continues ? ` · continues ${view.continues.slice(0, 8)}` : ''}`
  const out: PanelNode[] = [{ t: 'text', text: fit(`${who} · ${view.turns} turn${view.turns === 1 ? '' : 's'}${o.agent ? '' : sees}${view.questions.length ? ` · ${view.questions.length} open question${view.questions.length === 1 ? '' : 's'}` : ''}`, width), tone: 'title' }]
  // The Agents tab says how many run, whichever tab is open
  const running = (o.agents ?? []).filter(a => a.status === 'running' || a.status === 'waiting').length
  const labelOf = (tab: Tab, label: string): string => (tab === 'agents' && running ? `${label} (${running})` : label)
  out.push({ t: 'row', items: TABS.map(([tab, label], i) => ({ t: 'button', key: `tab-${tab}`, hotkey: String(i + 1), text: ui.tab === tab ? `[${labelOf(tab, label)}]` : labelOf(tab, label), tone: ui.tab === tab ? 'bold' : tab === 'agents' && running ? undefined : 'dim', action: { kind: 'tab', tab } })) })
  out.push({ t: 'text', text: '─'.repeat(Math.max(4, Math.min(width, 60))), tone: 'dim' })
  if (ui.tab === 'history') out.push(...historyNodes(view.history ?? [], ui, width, o.now, view.tip))
  else if (ui.tab === 'context') out.push(...contextNodes(o.ledger, width))
  else if (ui.tab === 'lines') out.push(...linesNodes(view, width))
  else out.push(...agentNodes(o.agents ?? [], ui, width, o.now))
  out.push({ t: 'text', text: '' }, { t: 'text', text: o.focused ? 'Tab moves · Enter opens · 1–4 switch tabs · Esc back to the prompt' : 'ctrl+x tab to use this pane', tone: 'dim' })
  return out
}
