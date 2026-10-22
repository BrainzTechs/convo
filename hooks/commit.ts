// Commits with plumbing only: turns on their branch (continued, branched or rewound), and merges.

import type { Io } from './io.ts'
import { lineageTrailers, place, rewoundRef, withTrailers, type IndexEntry, type Placement } from './lineage.ts'
import { numbered, type SpoolItem } from './turns.ts'
import { S } from './state.ts'
import { addedFiles, git, revOf } from './git.ts'
import { continuesFrom, indexRows, loadIndex } from './rows.ts'

/** Adds an item's files on top of its branch tip and moves the branch, with plumbing only. */
export async function commitItem(io: Io, item: SpoolItem, indexFile: string, spoolId?: string): Promise<string> {
  // A fresh index file per commit: a crash cannot leave a lock behind that stops every later commit
  const idx = `${indexFile}.${Date.now().toString(36)}-${(S.indexSeq += 1)}`
  try {
    return await commitItemWith(io, item, idx, spoolId)
  } finally {
    await io.process.run(['rm', '-f', idx, `${idx}.lock`])
  }
}

/** The commit already made from a spool file, if one was: a flush cut off before the file's removal is not a new turn. */
export async function committedFrom(io: Io, ref: string, spoolId: string): Promise<string | undefined> {
  const r = await git(io, ['log', '-n', '20', '--first-parent', '--format=%H%x01%B%x00', ref])
  for (const c of r.ok ? r.out.split('\0') : []) {
    const [hash, body = ''] = c.trim().split('\x01')
    if (hash && body.split('\n').includes(`Spool-Id: ${spoolId}`)) return hash
  }
  return undefined
}

/** Where a commit goes on `tip`, given the commit its turn continues from. */
export async function placeOn(io: Io, tip: string | undefined, from: IndexEntry | undefined, item: SpoolItem): Promise<Placement> {
  let turnsBetween = 0
  let crossesCompaction = false
  if (from && tip && from.commit !== tip) {
    const between = await git(io, ['log', '--first-parent', '--format=%s', `${from.commit}..${tip}`])
    const subjects = between.out.split('\n')
    turnsBetween = subjects.filter(x => x.startsWith('turn ')).length
    // A keyframe or native summary on the line since: what looks like a rewind is the turns compaction kept
    crossesCompaction = subjects.some(x => /^keyframe \d+: /.test(x))
  }
  let base: string | undefined
  if (!tip && !from && item.base) {
    // A subagent's branch starts where the turn that spawned it continues from, not at whatever the session tip is
    const spawner = item.baseRows?.length ? await continuesFrom(io, { ...item, rows: item.baseRows }).catch(() => undefined) : undefined
    base = spawner?.commit ?? (await revOf(io, item.base))
  }
  return place(tip, base, from?.commit, turnsBetween, crossesCompaction)
}

export async function commitItemWith(io: Io, item: SpoolItem, indexFile: string, spoolId?: string): Promise<string> {
  const itemSid = item.ref.slice(item.ref.lastIndexOf('/') + 1)
  if (spoolId && (await revOf(io, item.ref))) {
    const done = await committedFrom(io, item.ref, spoolId)
    if (done) {
      if (item.rows?.length) await indexRows(io, item.rows, done, itemSid)
      return done
    }
  }
  // Lineage is best effort: a transcript that cannot be read leaves the turn on the branch tip
  let from = await continuesFrom(io, item).catch(() => undefined)
  let rechecked = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const tip = await revOf(io, item.ref)
    // Records and keyframes were built from one tip; on another they would undo what landed meanwhile (a merge)
    if (item.expectTip !== undefined && tip !== item.expectTip) throw new Error(`${item.ref} moved while this was being built`)
    let placement = await placeOn(io, tip, from, item)
    // A rewind or a branch is only as good as the row index: another process may have added this session's newer
    // turns to it since it was read. Read on and walk again before moving a line
    if (!rechecked && (placement.kind === 'rewind' || placement.kind === 'branch')) {
      rechecked = true
      await loadIndex(io)
      from = await continuesFrom(io, item).catch(() => undefined)
      placement = await placeOn(io, tip, from, item)
    }
    const parent = placement.parent
    const env = { GIT_INDEX_FILE: indexFile }
    const read = await git(io, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env })
    if (!read.ok) throw new Error(`read-tree: ${read.err}`)
    // Numbered from what the branch holds right now, so concurrent sessions and resumes never repeat a number
    let ready = item
    if (item.numberIn) {
      const ls = parent ? await git(io, ['ls-tree', '--name-only', parent, `${item.numberIn}/`]) : { ok: true, out: '' }
      ready = numbered(item, (ls.ok && ls.out ? ls.out.split('\n').length : 0) + 1)
    }
    const lines: string[] = []
    // A subagent that finished in this turn joins as another parent, its turn files and outputs in the tree so recall
    // finds them. Only when every commit it adds is the subagent's own: an agent branch based on a line a rewind
    // abandoned would otherwise pull that line back into the session
    const extra: { id: string; tip: string }[] = []
    for (const m of parent ? (item.merge ?? []) : []) {
      const t = await revOf(io, m)
      if (!t || !parent || t === parent) continue
      const id = m.slice(m.lastIndexOf('/') + 1)
      const own = await git(io, ['log', '--format=%x00%b', `${parent}..${t}`])
      const bodies = own.out.split('\0').map(b => b.trim()).filter(Boolean)
      if (!own.ok || !bodies.length || !bodies.every(b => b.includes(`Agent: ${id}`))) continue
      extra.push({ id, tip: t })
      lines.push(...(await addedFiles(io, parent, t, [`agents/${id}/`, 'blobs/'])))
    }
    for (const f of ready.files) {
      const blob = f.blob ? { ok: true, out: f.blob, err: '' } : await git(io, ['hash-object', '-w', '--stdin'], { stdin: f.text })
      if (!blob.ok) throw new Error(`hash-object: ${blob.err}`)
      lines.push(`100644 blob ${blob.out}\t${f.path}`)
    }
    const upd = await git(io, ['update-index', '--index-info'], { env, stdin: lines.join('\n') + '\n' })
    if (!upd.ok) throw new Error(`update-index: ${upd.err}`)
    const tree = await git(io, ['write-tree'], { env })
    if (!tree.ok) throw new Error(`write-tree: ${tree.err}`)
    const who = { GIT_AUTHOR_NAME: 'convo', GIT_AUTHOR_EMAIL: 'convo@localhost', GIT_COMMITTER_NAME: 'convo', GIT_COMMITTER_EMAIL: 'convo@localhost', GIT_AUTHOR_DATE: item.at, GIT_COMMITTER_DATE: item.at }
    const message = withTrailers(ready.message, [...lineageTrailers(placement, from?.sid, itemSid), ...(spoolId ? [`Spool-Id: ${spoolId}`] : [])])
    const merged = extra.length ? withTrailers(message, [`Merged-Agents: ${extra.map(x => x.id).join(', ')}`]) : message
    const commit = await git(io, parent ? ['commit-tree', tree.out, '-p', parent, ...extra.flatMap(x => ['-p', x.tip])] : ['commit-tree', tree.out], { env: who, stdin: merged })
    if (!commit.ok) throw new Error(`commit-tree: ${commit.err}`)
    // A rewind keeps the line it leaves behind under a ref of its own before the branch moves back
    if (placement.kind === 'rewind') {
      const kept = await git(io, ['update-ref', rewoundRef(itemSid, placement.abandoned), placement.abandoned])
      if (!kept.ok) throw new Error(`update-ref (keep): ${kept.err}`)
    }
    // Moves the branch only if nobody else moved it since we read it; else retry on the new tip
    const moved = await git(io, ['update-ref', item.ref, commit.out, tip ?? '0000000000000000000000000000000000000000'])
    if (moved.ok) {
      S.moved += 1
      if (item.rows?.length) await indexRows(io, item.rows, commit.out, itemSid)
      return commit.out
    }
  }
  throw new Error(`update-ref kept losing a race on ${item.ref}`)
}

/** A commit with two parents: this branch's tip first, the merged branch's second; the branch moves only if nobody moved it meanwhile. */
export async function commitMerge(io: Io, o: { ref: string; oursTip: string; theirsTip: string; files: { path: string; text: string }[]; entries: string[]; message: string; indexFile: string }): Promise<string> {
  const idx = `${o.indexFile}.${Date.now().toString(36)}-${(S.indexSeq += 1)}`
  try {
    return await commitMergeWith(io, { ...o, indexFile: idx })
  } finally {
    await io.process.run(['rm', '-f', idx, `${idx}.lock`])
  }
}

export async function commitMergeWith(io: Io, o: { ref: string; oursTip: string; theirsTip: string; files: { path: string; text: string }[]; entries: string[]; message: string; indexFile: string }): Promise<string> {
  const env = { GIT_INDEX_FILE: o.indexFile }
  const read = await git(io, ['read-tree', o.oursTip], { env })
  if (!read.ok) throw new Error(`read-tree: ${read.err}`)
  const lines = [...o.entries]
  for (const f of o.files) {
    const blob = await git(io, ['hash-object', '-w', '--stdin'], { stdin: f.text })
    if (!blob.ok) throw new Error(`hash-object: ${blob.err}`)
    lines.push(`100644 blob ${blob.out}\t${f.path}`)
  }
  const upd = await git(io, ['update-index', '--index-info'], { env, stdin: `${lines.join('\n')}\n` })
  if (!upd.ok) throw new Error(`update-index: ${upd.err}`)
  const tree = await git(io, ['write-tree'], { env })
  if (!tree.ok) throw new Error(`write-tree: ${tree.err}`)
  const at = new Date().toISOString()
  const who = { GIT_AUTHOR_NAME: 'convo', GIT_AUTHOR_EMAIL: 'convo@localhost', GIT_COMMITTER_NAME: 'convo', GIT_COMMITTER_EMAIL: 'convo@localhost', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
  const commit = await git(io, ['commit-tree', tree.out, '-p', o.oursTip, '-p', o.theirsTip], { env: who, stdin: o.message })
  if (!commit.ok) throw new Error(`commit-tree: ${commit.err}`)
  const moved = await git(io, ['update-ref', o.ref, commit.out, o.oursTip])
  if (!moved.ok) throw new Error('the branch moved while merging; ask again')
  S.moved += 1
  return commit.out
}
