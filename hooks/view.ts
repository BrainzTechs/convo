// The pane beside the chat: what it shows, built from git, and its rows.
//
// buildView reads this conversation's line and the project's other lines;
// paneRows turns that into short rows of text, so every surface draws it the
// same way and tests read it without drawing.

import type { ConvoLine, ConvoMerge, ConvoView } from '../types/index.d.ts'
import type { Io } from './io.ts'
import { parseRecords } from './checkpoint.ts'
import { refs } from './turns.ts'
import { git, revOf } from './git.ts'
import { listBranches, turnCount } from './tools.ts'
import { buildTimeline } from './timeline.ts'
import { carriedFrom } from './rows.ts'
import { resumed } from './state.ts'

/** The most other lines the pane lists, newest first. */
const LINES_SHOWN = 12

/** One commit of the line: its subject and trailers. */
type Entry = { subject: string; body: string }

/** The view of a session with nothing recorded, or with history off. */
export const emptyView = (sid: string, off?: string): ConvoView => ({
  ...(off ? { off } : {}),
  sid,
  turns: 0,
  questions: [],
  tasks: 0,
  lines: [],
  merges: [],
  agents: { all: 0, merged: 0 },
  others: 0,
  at: new Date().toISOString(),
})

/**
 * Reads a line's first-parent history, newest first: how many turns, the
 * newest compaction (what Claude's context starts from) and the merges.
 */
/** A rewind on the line: the ref it kept the abandoned turns under, where it went back to, and after which turn. */
export type Rewind = { kept: string; to: string; afterTurn: number }

export function readLine(entries: readonly Entry[]): Pick<ConvoView, 'turns' | 'context' | 'merges'> & { rewinds: Rewind[] } {
  const isTurn = (e: Entry): boolean => e.subject.startsWith('turn ')
  const turns = entries.filter(isTurn).length
  // Turns older than an entry: what came before it on the line
  const olderTurns = (i: number): number => entries.slice(i + 1).filter(isTurn).length
  let context: ConvoView['context']
  const at = entries.findIndex(e => /^keyframe \d+: /.test(e.subject))
  if (at >= 0) {
    const e = entries[at] as Entry
    const n = Number(/^keyframe (\d+)/.exec(e.subject)?.[1] ?? 0)
    context = { kind: /: native summary/.test(e.subject) ? 'native' : 'keyframe', n, afterTurn: olderTurns(at), turnsSince: entries.slice(0, at).filter(isTurn).length }
  }
  const merges: ConvoMerge[] = []
  entries.forEach((e, i) => {
    if (!e.subject.startsWith('merge: ')) return
    const from = /^Merged-From: ([^@\n]+)@/m.exec(e.body)?.[1] ?? e.subject.slice('merge: '.length).replace(/ \(.*$/, '')
    const base = /^Base: ([0-9a-f]+)/m.exec(e.body)?.[1]
    merges.push({ from, afterTurn: olderTurns(i), conflicts: Number(/^Conflicts: (\d+)/m.exec(e.body)?.[1] ?? 0), ...(base ? { base } : {}) })
  })
  const rewinds: Rewind[] = []
  entries.forEach((e, i) => {
    const kept = /^Kept-As: (\S+)/m.exec(e.body)?.[1]
    const to = /^Rewound-To: ([0-9a-f]+)/m.exec(e.body)?.[1]
    if (kept && to) rewinds.push({ kept, to, afterTurn: olderTurns(i) })
  })
  return { turns, context, merges: merges.reverse(), rewinds }
}

/** Builds the pane's view of session `sid` from git. */
export async function buildView(io: Io, sid: string): Promise<ConvoView> {
  const view = emptyView(sid)
  const own = await revOf(io, refs.session(sid))
  // Resumed or forked under a new id, before a turn of its own: the line its transcript goes on from
  const carried = own ? undefined : await carriedFrom(io, sid).catch(() => undefined)
  const tip = own ?? carried?.commit
  const all = await listBranches(io)
  if (!tip) return { ...view, others: all.filter(b => b.ref.startsWith('refs/heads/session/')).length }
  if (carried) view.continues = carried.sid
  const log = await git(io, ['log', '--first-parent', '-n', '5000', '--format=%s%x01%b%x00', tip])
  const entries = (log.ok ? log.out.split('\0') : []).map(x => x.trim()).filter(Boolean).map(x => {
    const [subject = '', body = ''] = x.split('\x01')
    return { subject, body }
  })
  const line = readLine(entries)
  // A resume under a new id is this conversation going on: the line it went on from reads as continued, not forked
  const resumedAt = entries.find(x => /^Resumed: yes$/m.test(x.body))
  const resumedFrom = resumedAt ? /^Branched-From: ([^@\s]+)@/m.exec(resumedAt.body)?.[1] : carried && resumed.has(sid) ? carried.sid : undefined
  if (resumedFrom) view.resumedFrom = resumedFrom
  // Open tasks from the newest records on this line; a merge's questions are Decide: tasks
  const stored = await git(io, ['show', `${tip}:records.json`])
  const open = parseRecords(stored.ok ? stored.out : undefined).records.filter(r => r.kind === 'task' && !r.done && !r.supersededBy)
  const questions = open.filter(r => r.text.startsWith('Decide: ')).map(r => r.text)
  // The other lines: forks and sessions sharing history with this one, and the turns rewinds left
  const lines: ConvoLine[] = []
  let others = 0
  const ours = refs.session(sid)
  for (const b of all) {
    if (b.ref === ours) continue
    const isRewound = b.ref.startsWith('refs/heads/rewound/')
    // Another session's rewinds are its own business
    if (isRewound && !b.ref.startsWith(`refs/heads/rewound/${sid}/`)) continue
    if (lines.length >= LINES_SHOWN) {
      if (!isRewound) others += 1
      continue
    }
    const common = await git(io, ['merge-base', tip, b.tip])
    if (!common.ok || !common.out) {
      others += 1
      continue
    }
    // A merged line's split point is where it was when merged in (the merge records it), not its tip; a rewound
    // line's is the turn the rewind went back to (its commit records it), even once a merge brought those turns back
    const merge = line.merges.find(m => m.from === b.name)
    const rewind = isRewound ? line.rewinds.find(r => r.kept === b.name) : undefined
    const base = rewind ? rewind.to : merge?.base && common.out === b.tip ? merge.base : common.out
    const splitAfter = rewind ? rewind.afterTurn : await turnCount(io, base)
    const own = (await turnCount(io, b.tip)) - splitAfter
    // A fork's first turn of its own, leaving out turns of this line's rewound lines (a fork taken before a rewind
    // carries them, and they are listed under the rewind already)
    const firstOwn = await git(io, ['log', '--reverse', '--first-parent', '--format=%s', `${base}..${b.tip}`, ...(isRewound ? [] : ['--not', `--glob=refs/heads/rewound/${sid}/*`])])
    const first = firstOwn.ok ? firstOwn.out.split('\n').find(s => s.startsWith('turn '))?.replace(/^turn \d+: /, '') : undefined
    const relation: ConvoLine['relation'] = merge || (isRewound && common.out === b.tip) ? 'merged' : common.out === b.tip ? 'parent' : common.out === tip ? 'ahead' : 'split'
    lines.push({ kind: isRewound ? 'rewound' : 'fork', name: b.name, own: Math.max(0, own), splitAfter, relation, ...(first ? { first } : {}), when: b.when })
  }
  // Subagents: their branches, and which of them this line has merged
  const agentRefs = `refs/heads/agent/${sid}/`
  const ag = await git(io, ['for-each-ref', '--format=%(objectname)', agentRefs])
  const agMerged = await git(io, ['for-each-ref', '--merged', tip, '--format=%(objectname)', agentRefs])
  const count = (r: { ok: boolean; out: string }): number => (r.ok && r.out ? r.out.split('\n').length : 0)
  const history = await buildTimeline(io, tip).catch(() => [])
  return { ...view, ...line, questions, tasks: open.length - questions.length, lines, agents: { all: count(ag), merged: count(agMerged) }, others, tip, history }
}

/** A row of the pane: its text and how it reads. */
export type PaneRow = { text: string; tone?: 'title' | 'dim' | 'warn' | 'good' }

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const short = (name: string): string => name.replace(/^session\/([0-9a-f]{8})[0-9a-f-]*$/, '$1').replace(/^rewound\/[^/]+\/([0-9a-f]{8})[0-9a-f]*$/, '$1')

/**
 * A row too long for the pane, as up to three rows: broken after a " · " or a
 * space, the rest indented under it, the third cut with "…" if still too long.
 */
export function wrapRow(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const indent = ' '.repeat(Math.min((/^ */.exec(text)?.[0].length ?? 0) + 2, Math.floor(width / 3)))
  const out: string[] = []
  let rest = text
  while (rest.length > width && out.length < 2) {
    const room = rest.slice(0, width + 1)
    // A break between parts (" · ") when one falls in the second half of the row, else between words
    const dot = room.lastIndexOf(' · ')
    const at = dot > width / 2 ? dot : room.lastIndexOf(' ')
    const end = at > indent.length + 4 ? at : width
    out.push(rest.slice(0, end).trimEnd())
    rest = indent + rest.slice(end).replace(/^ ?· ?|^ /, '')
  }
  out.push(rest.length > width ? `${rest.slice(0, Math.max(1, width - 1))}…` : rest)
  return out
}

/** The pane's rows for `view`, each at most `width` columns (a long one wraps); `more` goes before the closing hint. */
export function paneRows(view: ConvoView | undefined, width: number, more: readonly PaneRow[] = []): PaneRow[] {
  const rows: PaneRow[] = []
  const add = (text: string, tone?: PaneRow['tone']): void => {
    for (const t of wrapRow(text, width)) rows.push({ text: t, ...(tone ? { tone } : {}) })
  }
  if (!view) {
    add('Reading this conversation’s history…', 'dim')
    return rows
  }
  if (view.off) {
    add(`History is off in this session: ${view.off}.`, 'warn')
    return rows
  }
  add(`Session ${view.sid.slice(0, 8)} · ${plural(view.turns, 'turn')}`, 'title')
  if (!view.turns) {
    add('Nothing recorded yet: each turn lands here when it ends.', 'dim')
  } else if (!view.context) {
    add(`Claude sees all ${plural(view.turns, 'turn')}: nothing compacted yet.`)
  } else {
    const c = view.context
    const what = c.kind === 'keyframe' ? `keyframe ${c.n}` : `Claude Code’s summary (compaction ${c.n})`
    add(`Claude works from ${what}, made after turn ${c.afterTurn}, then ${plural(c.turnsSince, 'turn')}.`)
  }
  if (view.questions.length) {
    add(`${plural(view.questions.length, 'question')} open:`, 'warn')
    for (const q of view.questions) add(`  ${q.replace(/^Decide: /, '')}`, 'warn')
  }
  if (view.tasks) add(`${plural(view.tasks, 'task')} open.`, 'dim')
  const merged = view.merges.length
  if (view.lines.length || view.agents.all || merged) {
    add('')
    add('Lines', 'title')
  }
  for (const l of view.lines) {
    const name = short(l.name)
    if (l.relation === 'parent') {
      add(`  ${view.resumedFrom && l.name === `session/${view.resumedFrom}` ? 'continued from' : 'forked from'} ${name} after its turn ${l.splitAfter} · ${l.when}`, 'dim')
      continue
    }
    const merge = view.merges.find(m => m.from === l.name)
    const head = l.kind === 'rewound' ? `rewound after turn ${l.splitAfter}` : `fork ${name} · ${l.relation === 'ahead' ? 'continues after' : 'split after'} turn ${l.splitAfter}`
    // A rewound line a merge brought back (the fork it was part of) says so; it is not merged by name
    // A merge's questions, and whether they are settled (none open on this line any more)
    const asked = (n: number): string => (n ? `, ${plural(n, 'question')}${view.questions.length ? '' : ' settled'}` : '')
    const tail = merge ? ` · merged after turn ${merge.afterTurn}${asked(merge.conflicts)}` : l.relation === 'merged' ? ' · back in through a merge' : ''
    add(`  ${head} · ${plural(l.own, 'turn')}${tail} · ${l.when}`, l.relation === 'merged' ? 'good' : undefined)
    if (l.first) add(`    “${l.first}”`, 'dim')
  }
  // Merges of lines not listed above (another project's line, or past the list's end)
  for (const m of view.merges.filter(m => !view.lines.some(l => l.name === m.from))) add(`  merged ${short(m.from)} after turn ${m.afterTurn}${m.conflicts ? ` · ${plural(m.conflicts, 'question')}${view.questions.length ? '' : ' settled'}` : ''}`, 'good')
  if (view.agents.all) add(`  ${plural(view.agents.all, 'subagent')}, ${view.agents.merged} merged in`, 'dim')
  if (view.others) add(`${plural(view.others, 'other conversation')} in this project.`, 'dim')
  rows.push(...more)
  add('')
  add('Ask Claude to recall, list or merge any of these.', 'dim')
  return rows
}
