// Which session events belong to, and native compactions noticed along the way.

import type { Io } from './io.ts'
import { KEYFRAME_OPENING } from './checkpoint.ts'
import { assembleCompaction, refs, sha256, type Row } from './turns.ts'
import { S, agentRows, endedSessions, resume, resumed } from './state.ts'
import { endBeat, enqueue, flush } from './spool.ts'

export function rowsFor(agentId: string | undefined): Row[] {
  if (!agentId) return S.mainRows
  let r = agentRows.get(agentId)
  if (!r) {
    r = []
    agentRows.set(agentId, r)
  }
  return r
}

export async function useSession(io: Io, id: string): Promise<void> {
  if (id === S.sid) return
  if (S.sid !== '') {
    await flush(io)
    // The session this process leaves (/clear, /branch, a fork, a rewind, a resume) is no peer of anyone's, this chat's included
    endBeat(io, S.sid)
  }
  // One this process comes back to (a /resume of an earlier one) is alive again
  endedSessions.delete(id)
  // A switch from another session after a /resume: this one goes on as that resume
  if (resume.pending && S.sid !== '') resumed.add(id)
  resume.pending = false
  S.sid = id
  S.moved += 1
  S.mainRows = []
  // Running subagents keep their rows: each belongs to the session it was spawned in (agentSession)
  S.compactHookRan = false
  S.keyframeOwed = false
  S.owed = undefined
  S.owedTries = 0
}

export const SUMMARY_OPENING = 'This session is being continued from a previous conversation'


/** Records a native compaction summary once per session, whichever way it was noticed. */
export async function recordCompaction(io: Io, summary: string): Promise<void> {
  // A keyframe that replaced the summary is committed by its builder
  if (summary.trimStart().startsWith(KEYFRAME_OPENING)) return
  // Keyed by the summary itself: a fork or a resume inherits the summary it was made after, and it is not a new compaction
  const key = `compaction:${(await sha256(summary)).slice(0, 40)}`
  if ((await io.store.get(key)) !== undefined) return
  await io.store.set(key, S.sid)
  // Native compaction with no hook call before it: the guard held the hook back, so fallback 2
  if (!S.compactHookRan) S.keyframeOwed = true
  S.compactHookRan = false
  const at = new Date().toISOString()
  const c = assembleCompaction(S.sid, summary, at)
  await enqueue(io, { ref: refs.session(S.sid), numberIn: 'keyframes', files: c.files, message: c.message, at })
}


/**
 * Compaction events do not reach installed mods everywhere (managed setups
 * hold them), so each turn also checks whether the conversation now opens
 * with a compaction summary that has not been recorded yet.
 */
export async function noticeCompaction(io: Io): Promise<void> {
  const first = (await io.session.messages()).at(0)
  if (first?.role === 'user' && first.text.includes(SUMMARY_OPENING)) await recordCompaction(io, first.text)
}
