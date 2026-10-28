// Finding the other chats in the coordinator's folder: whose heartbeat files say they are alive,
// what they last did, and the Claude Code chats convo has not recorded at all.

import type { Io } from './io.ts'
import { git, readFiles } from './git.ts'
import { mask } from './redact.ts'
import { GONE_MS, isInside, isPeer, isUnseenHead, ordered, parseBeat, peersText, relName, type Beat, type Peer } from './live.ts'
import type { ConvoLive } from '../types/index.d.ts'

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
    const r = await git(io, ['log', '--first-parent', '-n', String(n), '--format=%s%x1f%(trailers:key=Files,valueonly,separator=%x2c)', `refs/heads/session/${p.sid}`], { cwd: '/' }, p.repo)
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

/**
 * What the Live tab shows. A cheap pass is the scan alone: who works now, with the rows and the unseen
 * count left as `prev` had them. A full pass also reads each peer's last 5 turn subjects (all peers at
 * once: one slow repo costs the pass its own time, not the sum) and counts the chats convo has not
 * seen, never counting this chat itself.
 */
export async function collectLive(io: Io, o: { home: string; coordCwd: string; selfSid: string; projectsDir: string; now: number; full: boolean; prev?: ConvoLive }): Promise<ConvoLive> {
  const { peers, known } = await scanPeers(io, o)
  const working = peers.filter(p => p.beat?.state === 'working').length
  if (!o.full) return { peers: o.prev?.peers ?? [], unseen: o.prev?.unseen ?? 0, working, at: o.now }
  // unseenCount does not leave a chat out by itself: its own transcript is fresh and may have no heartbeat file yet
  known.add(o.selfSid)
  const [subjects, unseen] = await Promise.all([
    Promise.all(peers.map(p => peerSubjects(io, p, 5))),
    unseenCount(io, { projectsDir: o.projectsDir, coordCwd: o.coordCwd, known, now: o.now }),
  ])
  return {
    peers: peers.map((p, i) => ({
      sid: p.sid,
      name: relName(o.coordCwd, p.cwd),
      state: p.beat?.state === 'working' ? 'working' : p.beat?.state === 'idle' ? 'idle' : 'unknown',
      since: p.beat?.since ?? p.mtimeMs,
      ...(p.beat?.prompt ? { prompt: p.beat.prompt } : {}),
      subjects: subjects[i]?.subjects ?? [],
    })),
    unseen,
    working,
    at: o.now,
  }
}

/** The longest a turn file is shown whole in the peers tool. */
const TURN_CUT = 4_000

/**
 * The peers tool. Without `chat`, every live chat with its last turns and files, the folders in use and the
 * chats convo does not record. With `chat` (a folder as the list names it, or a session id prefix) that
 * chat's last `turns` turn files, read from its own repo.
 */
export async function peersTool(io: Io, input: { chat?: unknown; turns?: unknown }, o: { home: string; coordCwd: string; selfSid: string; projectsDir: string; now?: number }): Promise<string> {
  const now = o.now ?? Date.now()
  const { peers, known } = await scanPeers(io, { ...o, now })
  const chat = typeof input.chat === 'string' ? input.chat.trim() : ''
  if (!chat) {
    // unseenCount does not leave a chat out by itself: its own transcript is fresh and may have no heartbeat file yet
    known.add(o.selfSid)
    const [subjects, unseen] = await Promise.all([
      Promise.all(peers.map(p => peerSubjects(io, p, 5))),
      unseenCount(io, { projectsDir: o.projectsDir, coordCwd: o.coordCwd, known, now }),
    ])
    const details = new Map(peers.map((p, i) => [p.sid, subjects[i] ?? { subjects: [], files: [] }]))
    return mask(peersText({ coordCwd: o.coordCwd, peers, details, unseen, now }))
  }
  const want = chat.toLowerCase()
  const name = (p: Peer): string => relName(o.coordCwd, p.cwd)
  const live = peers.map(p => `${name(p)} (${p.sid.slice(0, 8)})`).join(', ') || 'none'
  const byFolder = peers.filter(p => name(p).toLowerCase() === want || p.cwd === chat)
  const found = byFolder.length ? byFolder : peers.filter(p => p.sid.toLowerCase().startsWith(want))
  const peer = found[0]
  if (!peer) return `No live chat matches "${chat.slice(0, 80)}". Live here: ${live}.`
  if (found.length > 1) return `Several live chats match "${chat.slice(0, 80)}": ${found.map(p => `${name(p)} (${p.sid.slice(0, 8)})`).join(', ')}. Name one by its session id prefix.`
  const asked = Math.trunc(Number(input.turns ?? 5))
  const n = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 20) : 5
  const ref = `refs/heads/session/${peer.sid}`
  const label = `${name(peer)} (${peer.sid.slice(0, 8)})`
  const ls = await git(io, ['ls-tree', '--name-only', ref, 'turns/'], { cwd: '/' }, peer.repo)
  const names = ls.ok && ls.out ? ls.out.split('\n').slice(-n) : []
  if (!names.length) return `${label} has no turns recorded yet.`
  const texts = await readFiles(io, names.map(f => `${ref}:${f}`), peer.repo, { cwd: '/' })
  const parts = names.map(f => {
    const text = texts.get(`${ref}:${f}`)
    if (text === undefined) return `--- ${f} ---\n(could not be read)`
    return `--- ${f} ---\n${text.length > TURN_CUT ? `${text.slice(0, TURN_CUT)}\n… [${text.length - TURN_CUT} more chars]` : text}`
  })
  return mask(`${label}: its last ${names.length} turn${names.length === 1 ? '' : 's'}\n\n${parts.join('\n\n')}`)
}
