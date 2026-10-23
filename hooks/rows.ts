// The row index and lineage walks: which committed turn a new turn continues from.

import type { Io } from './io.ts'
import { firstNewRow, indexLine, readIndex, readParents, walkUp, type IndexEntry, type ParentMap } from './lineage.ts'
import type { SpoolItem } from './turns.ts'
import { S } from './state.ts'
import { git, utf8 } from './git.ts'

/** Row id → commit and session, for every main-thread row any session of this project committed. */
export const index = new Map<string, IndexEntry>()
/** Row id → parent row id, from the transcripts read so far (row ids are shared by forks). */
export const parents: ParentMap = new Map()
/** Session id → its transcript file, as the classic hook events name it. */
export const transcripts = new Map<string, string>()
/** The most transcript rows kept in memory for walking lineage (a few hundred long sessions' worth). */
export const PARENTS_CAP = 400_000

/** How far each growing file (transcripts, row index files) has been read, in bytes. */
export const readOffsets = new Map<string, number>()

/**
 * Reads what was appended to a file since the last read, whole lines only,
 * in pieces under the 4 MiB cap a process's output is cut at: a long
 * transcript is read once, a little more each turn after. A single line
 * longer than the cap is skipped (its rest is not valid JSON either way).
 */
export async function readNew(io: Io, path: string, onLines: (text: string) => void): Promise<void> {
  if (!(await io.fs.exists(path))) return
  let off = readOffsets.get(path) ?? 0
  // A file that shrank was rewritten: read it again from the start
  const size = (await io.fs.stat(path)).size
  if (size === off) return
  if (size < off) off = 0
  for (let piece = 0; piece < 256; piece++) {
    const r = await io.process.run(['tail', '-c', `+${off + 1}`, path], { timeoutMs: 20_000 })
    if (r.exitCode !== 0 || !r.stdout) break
    const end = r.stdout.lastIndexOf('\n')
    if (end < 0 && !r.isStdoutTruncated) break // a line still being written
    const text = end < 0 ? r.stdout : r.stdout.slice(0, end + 1)
    if (end >= 0) onLines(text)
    off += utf8.encode(text).length
    if (!r.isStdoutTruncated) break
  }
  readOffsets.set(path, off)
}

/** Reads the row index files other sessions (and this one) appended to since the last load. */
export async function loadIndex(io: Io): Promise<void> {
  const dir = `${S.root}/rows`
  if (await io.fs.exists(dir)) {
    for (const e of await io.fs.list(dir)) {
      if (e.kind === 'file' && e.name.endsWith('.tsv')) await readNew(io, `${dir}/${e.name}`, t => readIndex(t, index))
    }
  }
  S.indexLoadedAt = Date.now()
}

/** Sessions whose transcript holds turns another line committed (a resume or fork under a new id): its newest such row's commit. */
const carried = new Map<string, IndexEntry>()

/**
 * The newest committed turn a session's transcript carries from another
 * line, before the session has committed one of its own: what a resume or a
 * fork under a new id goes on from. Read once, a little more as it grows.
 */
export async function carriedFrom(io: Io, sid: string): Promise<IndexEntry | undefined> {
  if (S.indexLoadedAt === 0) await loadIndex(io)
  await readNew(io, transcriptOf(sid), t => {
    // Walks read the same lines, so they are kept for them too
    readParents(t, parents)
    for (const line of t.split('\n')) {
      if (!line.includes('"uuid"')) continue
      try {
        const d = JSON.parse(line) as { uuid?: unknown; isSidechain?: unknown }
        const hit = typeof d.uuid === 'string' && d.isSidechain !== true ? index.get(d.uuid) : undefined
        if (hit && hit.sid !== sid) carried.set(sid, hit)
      } catch {
        // A line still being written
      }
    }
  })
  const hit = carried.get(sid)
  if (!hit || !(await git(io, ['cat-file', '-e', `${hit.commit}^{commit}`])).ok) return undefined
  return hit
}

/** The commit a turn continues from: its first new row's nearest recorded ancestor. */
export async function continuesFrom(io: Io, item: SpoolItem): Promise<IndexEntry | undefined> {
  S.walking += 1
  try {
    return await continuesFromNow(io, item)
  } finally {
    S.walking -= 1
  }
}

export async function continuesFromNow(io: Io, item: SpoolItem): Promise<IndexEntry | undefined> {
  if (!item.rows?.length || !item.transcript) return undefined
  if (S.indexLoadedAt === 0) await loadIndex(io)
  const recorded = (row: string): boolean => index.has(row)
  const first = firstNewRow(item.rows, recorded)
  if (first === undefined) return undefined
  let readMore = false
  let reloaded = false
  for (;;) {
    const w = walkUp(first, parents, recorded)
    if (w.kind === 'hit') {
      const hit = index.get(w.row)
      // A commit gone from the repo (reset, gc) cannot be a parent: the turn stays on the tip
      if (!hit || !(await git(io, ['cat-file', '-e', `${hit.commit}^{commit}`])).ok) return undefined
      return hit
    }
    if (w.kind === 'missing' && !readMore) {
      readMore = true
      // Bounded: past the cap the map starts over, and transcripts are read again from the start when needed
      if (parents.size > PARENTS_CAP && S.walking === 1) {
        parents.clear()
        for (const k of [...readOffsets.keys()]) if (k.endsWith('.jsonl')) readOffsets.delete(k)
      }
      await readNew(io, item.transcript, t => readParents(t, parents))
    } else if (w.kind === 'root' && !reloaded && Date.now() - S.indexLoadedAt > 10_000) {
      // Another session may have committed the rows a fork copied since the index was read
      reloaded = true
      await loadIndex(io)
    } else {
      return undefined
    }
  }
}

/** Records a committed turn's rows so later turns, forks and rewinds can find it. */
export async function indexRows(io: Io, all: readonly string[], commit: string, forSid: string): Promise<void> {
  // A turn's first and last rows: the last is always on the live chain (a walk from the next turn hits it in one
  // step, even when a compaction cut the chain mid-turn), the first catches a rewind to the turn's start
  const rows = [...new Set([all[0], all.at(-1)].filter((r): r is string => !!r))]
  for (const r of rows) index.set(r, { commit, sid: forSid })
  await io.process.run(['tee', '-a', `${S.root}/rows/${forSid}.tsv`], { stdin: rows.map(r => indexLine(r, commit, forSid)).join('\n') + '\n', timeoutMs: 10_000 })
}

/** Where Claude Code keeps a session's transcript when no classic event has named it yet. */
export function transcriptOf(id: string): string {
  return transcripts.get(id) ?? `${S.projectsDir}/${S.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
}
