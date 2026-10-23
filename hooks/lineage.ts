// Branch lineage: which earlier turn a new turn continues from.
//
// Claude Code's transcript links every row to its parent row, and a fork or
// /branch copies the rows with their ids kept. So walking up from a turn's
// first row to the nearest row an earlier commit recorded finds the exact
// turn it continues from: the branch tip (an ordinary turn), a turn of
// another session (a fork), or an earlier turn of this one (a rewind).
// Pure functions only; the hooks module does the reading and the git.

/** Row id → its parent row's id, or null for a root (a first prompt, a /clear, a compaction boundary). */
export type ParentMap = Map<string, string | null>

/** Adds the main-thread rows of transcript JSONL to `into`; partial or garbled lines are skipped. */
export function readParents(jsonl: string, into: ParentMap): void {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"uuid"')) continue
    try {
      const d = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown }
      if (typeof d.uuid !== 'string' || d.isSidechain === true) continue
      into.set(d.uuid, typeof d.parentUuid === 'string' ? d.parentUuid : null)
    } catch {
      // A line cut by a read window or still being written
    }
  }
}

export type WalkResult =
  /** The nearest recorded ancestor row. */
  | { kind: 'hit'; row: string }
  /** Reached a root with nothing recorded on the way: a fresh conversation. */
  | { kind: 'root' }
  /** Ran into a row the map does not hold: read more of the transcript and walk again. */
  | { kind: 'missing'; row: string }

/** Walks up from `first`'s parent to the nearest row `isRecorded` accepts. */
export function walkUp(first: string, parents: ParentMap, isRecorded: (row: string) => boolean, limit = 5000): WalkResult {
  if (!parents.has(first)) return { kind: 'missing', row: first }
  let row = parents.get(first) ?? null
  for (let i = 0; i < limit && row !== null; i++) {
    if (isRecorded(row)) return { kind: 'hit', row }
    if (!parents.has(row)) return { kind: 'missing', row }
    row = parents.get(row) ?? null
  }
  return { kind: 'root' }
}

/** The row after the last one an earlier commit recorded: where this turn's own part of the chain starts. */
export function firstNewRow(rows: readonly string[], isRecorded: (row: string) => boolean): string | undefined {
  // After the last recorded row: rows copied from earlier turns come first, and only some of theirs are indexed
  let last = -1
  rows.forEach((r, i) => {
    if (isRecorded(r)) last = i
  })
  return rows[last + 1]
}

export type Placement =
  /** On top of the branch tip, as before. */
  | { kind: 'continue'; parent?: string }
  /** A new branch starting at a turn of another line: a fork, /branch, or a resume under a new id. */
  | { kind: 'branch'; parent: string }
  /** Back to an earlier turn of this branch: the old line is kept under `abandoned`'s ref. */
  | { kind: 'rewind'; parent: string; abandoned: string }

/**
 * Where a commit goes, from the branch tip, the branch's base (a subagent's
 * session) and the commit the turn continues from. `turnsBetween` says how
 * many turn commits lie between `from` and the tip: none means only
 * compactions came after it, which is not a rewind. `crossesCompaction`
 * says a compaction (a keyframe or a native summary) lies between them:
 * Claude Code cannot rewind past one, so a turn whose parent chain reaches
 * behind it (the turns a keyframe kept word for word) continues the tip.
 */
export function place(tip: string | undefined, base: string | undefined, from: string | undefined, turnsBetween: number, crossesCompaction = false): Placement {
  if (from === undefined || from === tip) return { kind: 'continue', parent: tip ?? base }
  if (tip === undefined) return { kind: 'branch', parent: from }
  if (turnsBetween === 0 || crossesCompaction) return { kind: 'continue', parent: tip }
  return { kind: 'rewind', parent: from, abandoned: tip }
}

/** The ref an abandoned line is kept under after a rewind. */
export const rewoundRef = (sid: string, tip: string): string => `refs/heads/rewound/${sid}/${tip.slice(0, 12)}`

/** Trailer lines that record a placement in the commit message. */
export function lineageTrailers(p: Placement, fromSession: string | undefined, sid: string, resumed = false): string[] {
  // A resume branches as a fork does (a new id, a new line), and says it is the same conversation going on
  if (p.kind === 'branch') return [`Branched-From: ${fromSession ?? '?'}@${p.parent.slice(0, 12)}`, ...(resumed ? ['Resumed: yes'] : [])]
  if (p.kind === 'rewind') return [`Rewound-To: ${p.parent.slice(0, 12)}`, `Kept-As: rewound/${sid}/${p.abandoned.slice(0, 12)}`]
  return []
}

/** One line of a session's row index: row id, commit, session. */
export const indexLine = (row: string, commit: string, sid: string): string => `${row}\t${commit}\t${sid}`

export type IndexEntry = { commit: string; sid: string }

/** Adds a row index file's lines to `into`. */
export function readIndex(text: string, into: Map<string, IndexEntry>): void {
  for (const line of text.split('\n')) {
    const [row, commit, sid] = line.split('\t')
    if (row && commit && sid) into.set(row, { commit, sid })
  }
}

/** Puts trailer lines into a commit message whose last paragraph is its trailers. */
export function withTrailers(message: string, extra: readonly string[]): string {
  if (extra.length === 0) return message
  return `${message.replace(/\n+$/, '')}\n${extra.join('\n')}\n`
}
