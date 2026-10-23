// The pane's History: this conversation's commits, newest first, as entries
// the pane draws: turns (with their tools, tokens, cost, what was condensed in
// them and what was cleared before them), keyframes, subagents merged in, and
// forks and rewinds where they happened. Parsing is pure; buildTimeline and
// turnDetail read git.

import type { ConvoEntry, ConvoDetail } from '../types/index.d.ts'
import type { Io } from './io.ts'
import { git } from './git.ts'
import { unwrapPrompt } from './turns.ts'

/** The most commits the History reads; the pane scrolls past what it shows. */
export const TIMELINE_COMMITS = 60

const SEP = '\x01'
const END = '\x02'

/** One commit as the log prints it: hash, subject, date, parents, body, and the files it changed. */
type Raw = { hash: string; subject: string; at: string; parents: string[]; body: string; files: string[] }

/** The log's output (format %H\x01%s\x01%cI\x01%P\x01%b\x02 with --name-only), commit by commit. */
export function parseLog(out: string): Raw[] {
  const raws: Raw[] = []
  for (const chunk of out.split('\0')) {
    const at = chunk.indexOf(END)
    if (at < 0) continue
    const [hash = '', subject = '', date = '', parents = '', body = ''] = chunk.slice(0, at).split(SEP)
    if (!hash.trim()) continue
    const files = chunk.slice(at + 1).split('\n').map(f => f.trim()).filter(Boolean)
    raws.push({ hash: hash.trim(), subject, at: date, parents: parents.split(' ').filter(Boolean), body, files })
  }
  return raws
}

/** A turn file: the conversation's own (turns/0001-…) or a subagent's (agents/<id>/turns/0001-…). */
const isTurnFile = (f: string): boolean => /(?:^|\/)turns\/\d{4}-[^/]+\.md$/.test(f)

/** The turn file a commit adds: the conversation's own before a merged subagent's. */
const ownFile = (files: readonly string[]): string | undefined => files.find(f => /^turns\/\d{4}-/.test(f)) ?? files.find(isTurnFile)

const trailer = (body: string, name: string): string | undefined => new RegExp(`^${name}: (.+)$`, 'm').exec(body)?.[1]?.trim()

/** "Edit×2 Bash" from tool names in the order first used. */
export function toolsLine(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(' ')
}

/** Tools and tokens of turn files, from git grep's lines (turnId, usage and tool lines, file by file). */
export function fromTurnFiles(grep: string): Map<string, { tools: string; tokens?: { in: number; out: number } }> {
  const out = new Map<string, { tools: string; tokens?: { in: number; out: number } }>()
  let id = ''
  let tools: string[] = []
  let tokens: { in: number; out: number } | undefined
  const flush = (): void => {
    if (id) out.set(id, { tools: toolsLine(tools), ...(tokens ? { tokens } : {}) })
  }
  for (const line of grep.split('\n')) {
    const t = /^turnId: (\S+)/.exec(line)
    if (t?.[1]) {
      flush()
      id = t[1]
      tools = []
      tokens = undefined
      continue
    }
    const u = /^usage: \{ in: (\d+), out: (\d+), cacheRead: (\d+), cacheWrite: (\d+) \}/.exec(line)
    if (u) {
      tokens = { in: Number(u[1]) + Number(u[3]) + Number(u[4]), out: Number(u[2]) }
      continue
    }
    const tool = /^- ([A-Za-z0-9_:.-]+) `/.exec(line)
    if (tool?.[1]) tools.push(tool[1])
  }
  flush()
  return out
}

/**
 * The History's entries, newest first, from the line's commits: a turn's own
 * trailers where it has them (newer turns), else what its turn file says
 * (`files`, by Turn-Id); subagents by the subject of the branch merged in.
 */
export function timelineOf(raws: readonly Raw[], files: ReadonlyMap<string, { tools: string; tokens?: { in: number; out: number } }>, agentTitles: ReadonlyMap<string, string>): ConvoEntry[] {
  const out: ConvoEntry[] = []
  for (const r of raws) {
    const id = r.hash.slice(0, 7)
    const m = /^turn (\d+): (.*)$/.exec(r.subject)
    if (m) {
      const turnId = trailer(r.body, 'Turn-Id') ?? ''
      const fromFile = files.get(turnId)
      const tok = /in (\d+), out (\d+)/.exec(trailer(r.body, 'Tokens') ?? '')
      const tokens = tok ? { in: Number(tok[1]), out: Number(tok[2]) } : fromFile?.tokens
      const usd = Number(trailer(r.body, 'Cost') ?? NaN)
      const merged = (trailer(r.body, 'Merged-Agents') ?? '').split(/,\s*/).filter(Boolean)
      const agents = merged.map((a, i) => ({ id: a, title: agentTitles.get(r.parents[i + 1] ?? '') ?? '' }))
      const branched = trailer(r.body, 'Branched-From')
      const rewound = trailer(r.body, 'Rewound-To')
      const tools = trailer(r.body, 'Tools') ?? fromFile?.tools
      out.push({
        kind: 'turn',
        id,
        n: Number(m[1]),
        at: r.at,
        title: (m[2] ?? '').trim(),
        ...(tools ? { tools } : {}),
        ...(tokens ? { tokens } : {}),
        ...(Number.isFinite(usd) ? { usd } : {}),
        ...(trailer(r.body, 'Condensed') ? { condensed: trailer(r.body, 'Condensed') } : {}),
        ...(trailer(r.body, 'Cleared-Before') ? { clearedBefore: trailer(r.body, 'Cleared-Before') } : {}),
        ...(trailer(r.body, 'Brief-From') ? { brief: trailer(r.body, 'Brief-From') } : {}),
        ...(agents.length ? { agents } : {}),
        ...(branched ? { mark: `${trailer(r.body, 'Resumed') ? 'continued from' : 'branched from'} ${branched.replace(/@.*/, '').slice(0, 8)}` } : rewound ? { mark: `rewound to ${rewound.slice(0, 7)}` } : {}),
        // The line's own turn file; a subagent's (merged in this turn) only on the subagent's own branch
        ...(ownFile(r.files) ? { path: ownFile(r.files) } : {}),
      })
      continue
    }
    const k = /^keyframe (\d+): (.*)$/.exec(r.subject)
    if (k) {
      out.push({ kind: /native summary/.test(r.subject) ? 'native' : 'keyframe', id, n: Number(k[1]), at: r.at, title: (k[2] ?? '').trim() })
      continue
    }
    if (r.subject.startsWith('merge: ')) out.push({ kind: 'merge', id, at: r.at, title: r.subject.slice('merge: '.length) })
    // Records refreshed in the background, and anything else, are not the person's history
  }
  return out
}

/** Reads the line's newest commits and what the pane needs of them. */
export async function buildTimeline(io: Io, tip: string): Promise<ConvoEntry[]> {
  const log = await git(io, ['log', '--first-parent', `-n${TIMELINE_COMMITS}`, `--format=%x00%H${SEP}%s${SEP}%cI${SEP}%P${SEP}%b${END}`, '--name-only', tip])
  const raws = parseLog(log.ok ? log.out : '')
  // Older turns carry no trailers: their turn files say what tools ran and the tokens
  const paths = raws.filter(r => /^turn \d+: /.test(r.subject) && !trailer(r.body, 'Tools')).flatMap(r => r.files.filter(isTurnFile))
  const grep = paths.length ? await git(io, ['grep', '-h', '-I', '-E', '^(turnId: |usage: |- [A-Za-z0-9_:.-]+ `)', tip, '--', ...paths]) : { ok: true, out: '', err: '' }
  const second = raws.flatMap(r => r.parents.slice(1))
  const titles = new Map<string, string>()
  if (second.length) {
    const s = await git(io, ['log', '--no-walk', `--format=%H${SEP}%s`, ...second])
    for (const line of s.ok ? s.out.split('\n') : []) {
      const [h = '', subject = ''] = line.split(SEP)
      if (h) titles.set(h, subject.replace(/^turn \d+: /, ''))
    }
  }
  return timelineOf(raws, fromTurnFiles(grep.ok ? grep.out : ''), titles)
}

/** A turn file's parts for the expanded row: what was asked, the answer, the tools, the files. */
export function detailOf(text: string): ConvoDetail {
  const section = (name: string): string => {
    const m = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text)
    return (m?.[1] ?? '').trim()
  }
  const files = /^files: \[(.*)\]$/m.exec(text)?.[1]
  return {
    asked: unwrapPrompt(section('Prompt').replace(/^\(none\)$/, '')) || section('Command') || section('Delivered'),
    answer: section('Answer'),
    tools: section('Tools').split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).replace(/\s+→ ok, \d+ lines?.*$/, '').replace(/→ (ok|error), .*$/, '').trim()),
    files: files ? (JSON.parse(`[${files}]`) as string[]) : [],
  }
}

/** One turn's detail, read from git. */
export async function turnDetail(io: Io, tip: string, path: string): Promise<ConvoDetail | undefined> {
  const r = await git(io, ['show', `${tip}:${path}`])
  return r.ok ? detailOf(r.out) : undefined
}
