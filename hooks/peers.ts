// Finding the other chats in the coordinator's folder: whose heartbeat files say they are alive,
// what they last did, and the Claude Code chats convo has not recorded at all.

import type { Io } from './io.ts'
import { git } from './git.ts'
import { GONE_MS, isInside, isPeer, isUnseenHead, ordered, parseBeat, type Beat, type Peer } from './live.ts'

/** What each project folder's `cwd` file said, kept for the life of the process: it is written once. */
const folderCwd = new Map<string, string>()

const STATES: readonly string[] = ['working', 'idle', 'ended']

/** A heartbeat file's beat, or none when it is the old bare timestamp, unreadable, or names a state convo does not have. */
function readBeat(text: string): Beat | undefined {
  const b = parseBeat(text)
  return b && STATES.includes(b.state) ? b : undefined
}

/**
 * The chats alive in project folders at or inside `coordCwd`, working ones first, and the id of every
 * chat that has a heartbeat file in them (this one and finished ones too) for `unseenCount`.
 */
export async function scanPeers(io: Io, o: { home: string; coordCwd: string; selfSid: string; now: number }): Promise<{ peers: Peer[]; known: Set<string> }> {
  const base = `${o.home}/.claude/convo`
  const found: Peer[] = []
  const known = new Set<string>()
  let folders
  try {
    folders = await io.fs.list(base)
  } catch {
    return { peers: [], known }
  }
  for (const f of folders) {
    if (f.kind !== 'dir') continue
    const dir = `${base}/${f.name}`
    try {
      let cwd = folderCwd.get(dir)
      if (cwd === undefined) {
        cwd = (await io.fs.read(`${dir}/cwd`)).trim()
        if (cwd !== '') folderCwd.set(dir, cwd)
      }
      if (cwd === '' || !isInside(o.coordCwd, cwd)) continue
      for (const e of await io.fs.list(`${dir}/alive`)) {
        if (e.kind !== 'file') continue
        known.add(e.name)
        try {
          const mtimeMs = (await io.fs.stat(`${dir}/alive/${e.name}`)).mtimeMs
          // A chat gone for good or this one needs no look at its beat
          const beat = e.name === o.selfSid || o.now - mtimeMs >= GONE_MS ? undefined : readBeat(await io.fs.read(`${dir}/alive/${e.name}`))
          found.push({ sid: e.name, cwd, repo: `${dir}/repo.git`, mtimeMs, ...(beat ? { beat } : {}) })
        } catch {
          // A heartbeat file that went away between the listing and the read
        }
      }
    } catch {
      // A folder with no cwd file or no alive folder is not a chat's
    }
  }
  return { peers: ordered(found.filter(p => isPeer(p, o))), known }
}

/** A peer's newest turn subjects (its commits' first lines) and the files they touched, newest first; empty when its history cannot be read. */
export async function peerSubjects(io: Io, p: Peer, n: number): Promise<{ subjects: string[]; files: string[] }> {
  const none = { subjects: [], files: [] }
  try {
    const r = await git(io, ['log', '-n', String(n), '--format=%s%x1f%(trailers:key=Files,valueonly,separator=%x2c)', `refs/heads/session/${p.sid}`], { cwd: '/' }, p.repo)
    if (!r.ok) return none
    const subjects: string[] = []
    const files = new Set<string>()
    for (const line of r.out.split('\n')) {
      const [subject, touched = ''] = line.split('\x1f')
      if (!subject) continue
      subjects.push(subject)
      for (const f of touched.split(',')) if (f.trim() !== '') files.add(f.trim())
    }
    return { subjects, files: [...files] }
  } catch {
    return none
  }
}

/**
 * How many Claude Code chats inside `coordCwd` wrote to their transcript in the last 3 minutes and have
 * no heartbeat (`known` holds the ones that do). Only those transcripts' first 8 KiB are read, to tell a
 * chat someone types into from an SDK run.
 */
export async function unseenCount(io: Io, o: { projectsDir: string; coordCwd: string; known: ReadonlySet<string>; now: number }): Promise<number> {
  const prefix = o.coordCwd.replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-')
  const chats = new Set<string>()
  try {
    for (const d of await io.fs.list(o.projectsDir)) {
      if (d.kind !== 'dir' || !d.name.startsWith(prefix)) continue
      for (const t of await io.fs.list(`${o.projectsDir}/${d.name}`)) {
        if (t.kind !== 'file' || !t.name.endsWith('.jsonl') || o.now - t.mtimeMs >= GONE_MS) continue
        if (o.known.has(t.name.slice(0, -'.jsonl'.length))) continue
        const r = await io.process.run(['head', '-c', '8192', `${o.projectsDir}/${d.name}/${t.name}`], { cwd: '/', timeoutMs: 5_000 })
        if (r.exitCode !== 0) continue
        const seen = isUnseenHead(r.stdout, o.coordCwd)
        if (seen && !o.known.has(seen.sid)) chats.add(seen.sid)
      }
    }
  } catch {
    // No transcripts folder: nothing unseen
  }
  return chats.size
}
