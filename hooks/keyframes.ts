// Keyframes: a branch's records brought up to date from git, rendered, committed and tagged.

import type { Io } from './io.ts'
import { EXTRACT_SYSTEM, chunkTurns, extractPrompt, mergeRecords, onlyBackedPins, parseExtraction, parseRecords, recordsJson, renderKeyframe, tokensOf, turnNumberOf, type Records, type TurnDoc } from './checkpoint.ts'
import { refs } from './turns.ts'
import { S, exclusive, toolNames } from './state.ts'
import { git, readTurns, revOf } from './git.ts'
import { commitItem } from './commit.ts'
import { flushAll } from './spool.ts'

export type Checkpoint = { text: string; n: number; commit: string }

export const recallLine = (_id: string): string =>
  `Every earlier turn is kept word for word: search them with ${toolNames.recall} and read one with ${toolNames.turn}. ${toolNames.branches} lists this project's other lines (forks, rewinds), and ${toolNames.merge} brings one in.`

/**
 * The records of a branch tip brought up to date with the turns it holds
 * past them, oldest first in prompt-sized runs: nothing is committed.
 */
export async function freshRecords(io: Io, tip: string, o: { guidance?: string; minTurns?: number; timeoutMs?: number }): Promise<{ records: Records; docs: TurnDoc[]; lastTurn: number }> {
  const stored = await git(io, ['show', `${tip}:records.json`])
  const records = parseRecords(stored.ok ? stored.out : undefined)
  const ls = await git(io, ['ls-tree', '--name-only', tip, 'turns/'])
  const all = ls.ok && ls.out ? ls.out.split('\n') : []
  // The conversation holds turns git never saw (convo installed mid-session): only native keeps them
  if (o.minTurns !== undefined && all.length < o.minTurns) throw new Error(`git holds ${all.length} turns, the conversation at least ${o.minTurns}`)
  const fresh = all
    .map(p => ({ p, n: turnNumberOf(p) ?? 0 }))
    .filter(x => x.n > records.throughTurn)
    .sort((a, b) => a.n - b.n)
  const docs = await readTurns(io, tip, fresh.map(f => f.p))
  const lastTurn = Math.max(records.throughTurn, ...docs.map(d => d.n))
  let merged = records
  for (const chunk of chunkTurns(docs)) {
    const r = await io.model.complete({ model: 'haiku', system: EXTRACT_SYSTEM, prompt: extractPrompt(merged, chunk, o.guidance), maxTokens: 8000, effort: 'low', timeoutMs: o.timeoutMs ?? 90_000 })
    if (!r.isAnswered) throw new Error(`records: ${r.reason}`)
    const parsed = parseExtraction(r.text)
    if (!parsed) throw new Error('records: the answer was not readable JSON')
    // A pin stands only on the person's own words in the turn it names
    const ext = onlyBackedPins(parsed, chunk, pin => io.ui.log(`convo: left out a pin its turn's prompt does not back: turn ${pin.turn}: ${pin.text.slice(0, 120)}${pin.quote ? ` (quote: ${pin.quote.slice(0, 80)})` : ''}`, { to: 'debug' }))
    merged = mergeRecords(merged, ext, chunk.at(-1)?.n ?? lastTurn, chunk.flatMap(d => d.files))
  }
  return { records: relative(merged), docs, lastTurn }
}

/** Paths inside the project read relative to it. */
export const relative = (r: Records): Records => ({ ...r, files: [...new Set(r.files.map(f => (S.cwd && f.startsWith(`${S.cwd}/`) ? f.slice(S.cwd.length + 1) : f)))].sort() })

/** What buildCheckpoint takes; `accept` sees the finished text before anything is committed and may refuse it. */
export type CheckpointOptions = { sid: string; guidance?: string; trigger: string; minTurns?: number; timeoutMs?: number; accept?: (text: string) => string | undefined }

/**
 * Builds the branch's next keyframe from git: records from the turns since
 * the last one, merged and rendered, then committed and tagged before it
 * returns. Throws when it cannot, so callers fall back to native.
 */
export function buildCheckpoint(io: Io, o: CheckpointOptions): Promise<Checkpoint | undefined> {
  return exclusive(() => buildCheckpointNow(io, o))
}

export async function buildCheckpointNow(io: Io, o: CheckpointOptions): Promise<Checkpoint | undefined> {
  const ref = refs.session(o.sid)
  await flushAll(io)
  // A turn the spool could not commit would be missing from the keyframe and from git
  const spool = `${S.root}/spool/${o.sid}`
  if ((await io.fs.exists(spool)) && (await io.fs.list(spool)).some(f => f.name.endsWith('.json'))) throw new Error('turns are still waiting in the spool')
  const tip = await revOf(io, ref)
  if (!tip) return undefined
  const { records: merged, docs, lastTurn } = await freshRecords(io, tip, o)
  const kfs = await git(io, ['ls-tree', '--name-only', tip, 'keyframes/'])
  const n = (kfs.ok && kfs.out ? kfs.out.split('\n').length : 0) + 1
  const text = renderKeyframe({ n, sid: o.sid, fromTurn: 1, toTurn: lastTurn, records: merged, recall: recallLine(o.sid) })
  // Refused before anything is written: git never holds a keyframe Claude did not get
  const refused = o.accept?.(text)
  if (refused) throw new Error(refused)
  const at = new Date().toISOString()
  const covered = docs.length ? `turns ${docs[0]?.n ?? '?'}–${lastTurn}` : 'no new turns'
  const commit = await commitItem(io, {
    ref,
    files: [
      { path: 'keyframe.md', text },
      { path: `keyframes/${String(n).padStart(4, '0')}.md`, text },
      { path: 'records.json', text: recordsJson(merged) },
    ],
    expectTip: tip,
    message: `keyframe ${n}: ${covered}\n\nSession: ${o.sid}\nKind: keyframe\nTrigger: ${o.trigger}\nRecords: ${merged.records.filter(x => !x.supersededBy).length}\nTokens: ${tokensOf(text)}\n`,
    at,
  }, `${S.root}/index/${o.sid}-kf.idx`)
  const tag = await git(io, ['update-ref', `refs/tags/kf/${o.sid}/${n}`, commit])
  if (!tag.ok) io.ui.log(`convo: keyframe ${n} committed but not tagged: ${tag.err.slice(0, 200)}`, { to: 'debug' })
  return { text, n, commit }
}

/** Builds the keyframe a held-back compaction owes, once at a time; the next prompt carries it. */
export function buildOwed(io: Io, timeoutMs?: number): Promise<void> {
  const forSid = S.sid
  S.owedTries += 1
  S.owedRun ??= buildCheckpoint(io, { sid: forSid, trigger: 'held-back', timeoutMs })
    .then(kf => {
      if (kf && forSid === S.sid) S.owed = { sid: forSid, text: besideSummary(kf.text) }
      if (forSid === S.sid) S.keyframeOwed = false
    })
    .catch(err => {
      io.ui.log(`convo: keyframe for the next prompt failed: ${String(err).slice(0, 200)}`, { to: 'debug' })
      // Two tries, then the native summary alone carries on
      if (S.owedTries >= 2) S.keyframeOwed = false
    })
    .finally(() => {
      S.owedRun = undefined
    })
  return S.owedRun
}

/** How a keyframe is framed when it rides a prompt beside the native summary (fallback 2). */
export const besideSummary = (text: string): string =>
  `convo keeps a structured checkpoint of this conversation beside Claude Code's own summary: the decisions, assumptions, tasks and pins recorded so far, each with the turn it came from. Where the two differ, the checkpoint's records are the more exact.\n\n${text}`

/** Turns a session may run past its records before they are brought up to date in the background. */
export const REFRESH_TURNS = 10

/**
 * Brings a session's records up to date with the turns past them, and
 * commits records.json alone (no keyframe, nothing Claude reads): so the
 * next conversation's brief, and the next keyframe, start from fresh notes.
 * Nothing to do under REFRESH_TURNS new turns. Returns how many turns it
 * covered.
 */
export function refreshRecords(io: Io, sid: string): Promise<number> {
  return exclusive(async () => {
    await flushAll(io)
    const ref = refs.session(sid)
    const tip = await revOf(io, ref)
    if (!tip) return 0
    const stored = await git(io, ['show', `${tip}:records.json`])
    const through = parseRecords(stored.ok ? stored.out : undefined).throughTurn
    const ls = await git(io, ['ls-tree', '--name-only', tip, 'turns/'])
    const newer = (ls.ok && ls.out ? ls.out.split('\n') : []).filter(p => (turnNumberOf(p) ?? 0) > through).length
    if (newer < REFRESH_TURNS) return 0
    const { records, docs, lastTurn } = await freshRecords(io, tip, { timeoutMs: 120_000 })
    if (!docs.length) return 0
    await commitItem(io, {
      ref,
      files: [{ path: 'records.json', text: recordsJson(records) }],
      expectTip: tip,
      message: `records: turns ${docs[0]?.n ?? '?'}–${lastTurn}\n\nSession: ${sid}\nKind: records\nRecords: ${records.records.filter(x => !x.supersededBy).length}\n`,
      at: new Date().toISOString(),
    }, `${S.root}/index/${sid}-records.idx`)
    return docs.length
  })
}

/** The most recent other conversation in this project within `days`, with its records and its last turn. */
export async function briefSource(io: Io, sid: string, now: number, days: number): Promise<{ sid: string; at: number; records: Records; lastTurn: number } | undefined> {
  const r = await git(io, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:strip=3) %(objectname) %(committerdate:unix)', 'refs/heads/session/'])
  for (const line of (r.ok ? r.out.split('\n') : []).slice(0, 20)) {
    const [other = '', tip = '', when = '0'] = line.split(' ')
    const at = Number(when) * 1000
    if (!other || other === sid || !tip) continue
    if (now - at > days * 24 * 60 * 60_000) return undefined
    const stored = await git(io, ['show', `${tip}:records.json`])
    const records = parseRecords(stored.ok ? stored.out : undefined)
    const ls = await git(io, ['ls-tree', '--name-only', tip, 'turns/'])
    const lastTurn = Math.max(0, ...(ls.ok && ls.out ? ls.out.split('\n') : []).map(p => turnNumberOf(p) ?? 0))
    // The most recent conversation with notes; one too short to have any is passed over
    if (records.records.length || records.state) return { sid: other, at, records, lastTurn }
  }
  return undefined
}
