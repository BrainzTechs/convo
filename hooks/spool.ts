// The spool: finished turns wait here as files and a background timer commits them, so turns never wait on git.

import type { Io } from './io.ts'
import type { SpoolItem } from './turns.ts'
import { S, endedSessions } from './state.ts'
import { beatText, GONE_MS, type Beat } from './live.ts'
import { git, utf8 } from './git.ts'
import { commitItem } from './commit.ts'

/** Under the 4 MiB a file write takes, with room for JSON escaping. */
export const SPOOL_BYTES = 3_000_000

export async function enqueue(io: Io, item: SpoolItem): Promise<void> {
  if (!S.gitOk) return
  S.seq += 1
  const name = `${Date.now().toString().padStart(14, '0')}-${String(S.seq).padStart(5, '0')}.json`
  let json = JSON.stringify(item)
  if (utf8.encode(json).length > SPOOL_BYTES) {
    // Too big to spool: its large files go into git's object store now (one quick call each), the spool keeps their ids
    const files = []
    for (const f of item.files) {
      // The turn file itself is numbered at commit time, so it stays text
      if (f.text.length < 50_000 || f.path.includes('{NNNN}')) {
        files.push(f)
        continue
      }
      const blob = await git(io, ['hash-object', '-w', '--stdin'], { stdin: f.text })
      files.push(blob.ok ? { path: f.path, text: '', blob: blob.out } : f)
    }
    json = JSON.stringify({ ...item, files })
    if (utf8.encode(json).length > SPOOL_BYTES) {
      // Still too big: the turn file's tool section is cut, so the turn is kept rather than lost
      const cutFiles = files.map(f => (f.path.includes('{NNNN}') && f.text.length > 1_000_000 ? { ...f, text: `${f.text.slice(0, 1_000_000)}\n\n… [turn cut at 1,000,000 of ${f.text.length} chars]` } : f))
      json = JSON.stringify({ ...item, files: cutFiles })
    }
  }
  // Written whole under another name, then renamed: the committer never reads a half-written file
  const path = `${S.root}/spool/${S.sid}/${name}`
  await io.fs.write(`${path}.tmp`, json)
  const mv = await io.process.run(['mv', `${path}.tmp`, path])
  if (mv.exitCode !== 0) await io.fs.write(path, json)
}

/** How often a spool file may fail before it is set aside so the files after it can commit. */
export const SPOOL_TRIES = 5
/** …and only once it has kept failing this long, so a passing lock or a full disk does not cost a turn. */
export const SPOOL_FAIL_MS = 600_000
export const spoolFailures = new Map<string, { tries: number; since: number }>()

/** Moves a spool file out of the queue into spool-failed/, kept for a look rather than lost. */
export async function setAside(io: Io, path: string, name: string, why: string): Promise<void> {
  // Named by its folder too, so files from two sessions never collide there
  const folder = path.slice(0, path.lastIndexOf('/'))
  const to = `${S.root}/spool-failed/${folder.slice(folder.lastIndexOf('/') + 1)}-${name}`
  const mv = await io.process.run(['mv', path, to])
  io.ui.log(mv.exitCode === 0 ? `convo: set aside spool file ${name} (${why}); kept at ${to}` : `convo: could not set aside ${name} (${why}); it stays in the queue`, { to: 'debug' })
}

/** Commits every spool file in `dir`, oldest first, removing each once committed. */
export async function flushDir(io: Io, dir: string, indexFile: string): Promise<void> {
  if (!(await io.fs.exists(dir))) return
  const entries = (await io.fs.list(dir)).filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => e.name).sort()
  for (const name of entries) {
    const path = `${dir}/${name}`
    let item: SpoolItem
    try {
      item = JSON.parse(await io.fs.read(path)) as SpoolItem
    } catch {
      // Unreadable now may be mid-write by an older convo that wrote in place: only an old file is set aside
      if (Date.now() - (await io.fs.stat(path)).mtimeMs > 60_000) await setAside(io, path, name, 'not readable JSON')
      continue
    }
    // The spool file's own name plus its folder: unique to this turn, and how a repeat is recognised
    const spoolId = `${dir.slice(dir.lastIndexOf('/') + 1).replace(/\.claimed-.*$/, '')}/${name}`
    try {
      await commitItem(io, item, indexFile, spoolId)
      await io.process.run(['rm', '-f', path])
      spoolFailures.delete(path)
    } catch (err) {
      const f = spoolFailures.get(path) ?? { tries: 0, since: Date.now() }
      f.tries += 1
      spoolFailures.set(path, f)
      if (f.tries >= SPOOL_TRIES && Date.now() - f.since >= SPOOL_FAIL_MS) {
        spoolFailures.delete(path)
        await setAside(io, path, name, `failed ${f.tries} times over ${Math.round((Date.now() - f.since) / 60_000)} min: ${String(err).slice(0, 160)}`)
        continue
      }
      io.ui.log(`convo: could not commit ${name}, kept for a retry: ${String(err).slice(0, 200)}`, { to: 'debug' })
      return
    }
  }
}

/** Commits this session's spool; a call while one runs shares that run. */
export function flush(io: Io): Promise<void> {
  if (!S.gitOk || S.sid === '') return Promise.resolve()
  S.flushRun ??= flushDir(io, `${S.root}/spool/${S.sid}`, `${S.root}/index/${S.sid}.idx`).finally(() => {
    S.flushRun = undefined
  })
  return S.flushRun
}

/** Waits out a run in progress, then commits whatever it did not see. */
export async function flushAll(io: Io): Promise<void> {
  await flush(io)
  await flush(io)
}

// A session that has written no heartbeat for this long is gone: its spool may be adopted (the number lives in live.ts, which has no imports)
export { GONE_MS }

/**
 * Marks this session as alive, so no other session adopts its spool while it sits idle, and says what it is
 * doing: `beat`, which the hooks build with the holds read fresh. A session that has ended keeps its `ended`.
 */
export async function heartbeat(io: Io, beat: Omit<Beat, 'at'> = S.beat): Promise<void> {
  if (S.gitOk && S.sid && !endedSessions.has(S.sid)) await io.fs.write(`${S.root}/alive/${S.sid}`, beatText({ ...beat, at: Date.now() }))
}

/**
 * A session this process no longer runs (it ended, or the process moved on to another id): its heartbeat
 * file says `ended`, written once and never deleted, so spool adoption judges it by its time as before. The
 * beat starts over idle, with no prompt, for whichever session goes on. Fire-and-forget; never throws.
 */
export function endBeat(io: Io, sid: string): void {
  if (!sid || endedSessions.has(sid)) return
  endedSessions.add(sid)
  const now = Date.now()
  const { prompt: _prompt, ...rest } = S.beat
  S.beat = { ...rest, state: 'idle', since: now }
  if (!S.gitOk || !S.root) return
  try {
    void io.fs.write(`${S.root}/alive/${sid}`, beatText({ ...rest, state: 'ended', since: now, at: now, holds: [], holdsUnknown: 0 })).catch(() => undefined)
  } catch {
    // A heartbeat file is throwaway: the worst is an ended chat shown until its file goes stale
  }
}

/** Whether a session has shown a heartbeat lately. */
export async function isAlive(io: Io, id: string): Promise<boolean> {
  const path = `${S.root}/alive/${id}`
  if (!(await io.fs.exists(path))) return false
  return Date.now() - (await io.fs.stat(path)).mtimeMs < GONE_MS
}

/**
 * Spools sessions that are gone left behind, claimed by renaming so two
 * sessions never commit the same one. A claim whose claimer is gone too is
 * taken over, so a half-committed folder is never stranded.
 */
export async function adoptOrphans(io: Io): Promise<void> {
  const dir = `${S.root}/spool`
  if (!S.gitOk || !(await io.fs.exists(dir))) return
  for (const e of await io.fs.list(dir)) {
    if (e.kind !== 'dir') continue
    const at = e.name.lastIndexOf('.claimed-')
    const owner = (at < 0 ? e.name : e.name.slice(0, at)).split('.claimed-')[0] ?? ''
    const claimer = at < 0 ? undefined : e.name.slice(at + '.claimed-'.length)
    if (owner === S.sid) continue
    // One this session claimed and could not finish: finish it now
    if (claimer === S.sid) {
      await flushDir(io, `${dir}/${e.name}`, `${S.root}/index/${S.sid}-orphans.idx`)
      await io.process.run(['rmdir', `${dir}/${e.name}`])
      continue
    }
    if (await isAlive(io, claimer ?? owner)) continue
    // A session with no heartbeat file yet (an older convo) is judged by the folder's age, as before
    if (!(await io.fs.exists(`${S.root}/alive/${claimer ?? owner}`)) && Date.now() - (await io.fs.stat(`${dir}/${e.name}`)).mtimeMs < GONE_MS) continue
    const claimed = `${dir}/${owner}.claimed-${S.sid}`
    const mv = await io.process.run(['mv', `${dir}/${e.name}`, claimed])
    if (mv.exitCode !== 0) continue
    await flushDir(io, claimed, `${S.root}/index/${S.sid}-orphans.idx`)
    await io.process.run(['rmdir', claimed])
  }
}
