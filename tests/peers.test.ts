import { describe, expect, test } from 'claude-code/testing'
import type { Io } from '../hooks/io.ts'
import { beatText, type Beat, type Peer } from '../hooks/live.ts'
import { git, readFiles } from '../hooks/git.ts'
import { peerSubjects, scanPeers, unseenCount } from '../hooks/peers.ts'
import { S } from '../hooks/state.ts'

const NOW = 1792913206856
const HOME = '/Users/illusionist'
const COORD = '/Users/illusionist/Documents/projects/brainztechs/momopay'
const ME = '7695cbc7-3596-429d-bc98-795cc0776a3b'
const A = 'b2c1d0ff-1111-4222-8333-444455556666'
const B = 'c3d2e1f0-2222-4333-8444-555566667777'

type File = { text: string; mtimeMs: number }
type Call = { argv: string[]; opts: { cwd?: string; timeoutMs?: number } }

/** A folder tree held in memory, with the calls that reached it counted. */
function fakeIo(files: Record<string, File>, run: (argv: string[]) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 })) {
  const reads: string[] = []
  const stats: string[] = []
  const calls: Call[] = []
  const kids = (dir: string): Map<string, boolean> => {
    const out = new Map<string, boolean>() // name -> is a file
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const rest = path.slice(dir.length + 1)
      const i = rest.indexOf('/')
      out.set(i < 0 ? rest : rest.slice(0, i), i < 0)
    }
    return out
  }
  const io = {
    fs: {
      exists: async (p: string) => p in files || kids(p).size > 0,
      list: async (dir: string) => {
        const k = kids(dir)
        if (k.size === 0) throw new Error(`ENOENT ${dir}`)
        return [...k].map(([name, isFile]) => ({ name, kind: isFile ? 'file' : 'dir', size: 0, mtimeMs: isFile ? (files[`${dir}/${name}`]?.mtimeMs ?? 0) : 0, isLink: false }))
      },
      stat: async (p: string) => {
        stats.push(p)
        const f = files[p]
        if (!f) throw new Error(`ENOENT ${p}`)
        return { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
      },
      read: async (p: string) => {
        reads.push(p)
        const f = files[p]
        if (!f) throw new Error(`ENOENT ${p}`)
        return f.text
      },
      write: async () => {},
    },
    process: {
      run: async (argv: string[], opts: Call['opts'] = {}) => {
        calls.push({ argv, opts })
        const r = run(argv)
        return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  } as unknown as Io
  return { io, reads, stats, calls }
}

const beat = (o: Partial<Beat> = {}): Beat => ({ v: 1, at: NOW - 5_000, state: 'idle', since: NOW - 60_000, interactive: true, ...o })
const folder = (name: string) => `${HOME}/.claude/convo/${name}`
const o = { home: HOME, coordCwd: COORD, selfSid: ME, now: NOW }

describe('scanning for peers', () => {
  const F_BACK = '-Users-illusionist-Documents-projects-brainztechs-momopay-backend-aaaa1111'
  const F_ROOT = '-Users-illusionist-Documents-projects-brainztechs-momopay-bbbb2222'
  const F_OLD = '-Users-illusionist-Documents-projects-brainztechs-momopay-old-cccc3333'

  test('finds the chats in folders inside the coordinator, with their beats, and skips the rest', async () => {
    const { io } = fakeIo({
      [`${folder(F_BACK)}/cwd`]: { text: `${COORD}/backend\n`, mtimeMs: 1 },
      [`${folder(F_BACK)}/alive/${A}`]: { text: beatText(beat({ state: 'working', prompt: 'migrate payments repo to sqlc' })), mtimeMs: NOW - 4_000 },
      [`${folder(F_BACK)}/alive/${B}`]: { text: '1792728666987', mtimeMs: NOW - 90_000 }, // the old bare timestamp
      [`${folder(F_ROOT)}/cwd`]: { text: `${COORD}\n`, mtimeMs: 1 },
      [`${folder(F_ROOT)}/alive/${ME}`]: { text: beatText(beat()), mtimeMs: NOW - 1_000 },
      [`${folder(F_OLD)}/cwd`]: { text: `${COORD}-old\n`, mtimeMs: 1 },
      [`${folder(F_OLD)}/alive/ffff0000-0000-4000-8000-000000000000`]: { text: beatText(beat()), mtimeMs: NOW - 1_000 },
    })
    const r = await scanPeers(io, o)
    expect(r.peers.map(p => [p.sid, p.cwd, p.beat?.state])).toEqual([
      [A, `${COORD}/backend`, 'working'],
      [B, `${COORD}/backend`, undefined],
    ])
    expect(r.peers[0]?.repo).toBe(`${folder(F_BACK)}/repo.git`)
    expect(r.peers[0]?.mtimeMs).toBe(NOW - 4_000)
    // known: every chat with a heartbeat in a matched folder, this one too; not the neighbour's
    expect([...r.known].sort()).toEqual([A, B, ME].sort())
  })

  test('a stale heartbeat is not a peer but is known; an ended one the same', async () => {
    const F = '-Users-illusionist-Documents-projects-brainztechs-momopay-dddd4444'
    const { io } = fakeIo({
      [`${folder(F)}/cwd`]: { text: COORD, mtimeMs: 1 },
      [`${folder(F)}/alive/${A}`]: { text: beatText(beat()), mtimeMs: NOW - 180_000 },
      [`${folder(F)}/alive/${B}`]: { text: beatText(beat({ state: 'ended' })), mtimeMs: NOW - 2_000 },
    })
    const r = await scanPeers(io, o)
    expect(r.peers).toEqual([])
    expect([...r.known].sort()).toEqual([A, B].sort())
  })

  test('a beat with a state that is none of the three counts as no beat', async () => {
    const F = '-Users-illusionist-Documents-projects-brainztechs-momopay-eeee5555'
    const { io } = fakeIo({
      [`${folder(F)}/cwd`]: { text: COORD, mtimeMs: 1 },
      [`${folder(F)}/alive/${A}`]: { text: '{"v":1,"state":"bogus","at":1,"since":1}', mtimeMs: NOW - 2_000 },
      [`${folder(F)}/alive/${B}`]: { text: '{"v":1,"state":"working","at":1,"since":1,"interactive":false}', mtimeMs: NOW - 2_000 },
    })
    const r = await scanPeers(io, o)
    expect(r.peers.map(p => [p.sid, p.beat])).toEqual([[A, undefined]]) // B is an automated run: out
  })

  test('each folder\'s cwd file is read once per process, cached by folder name', async () => {
    const F = '-Users-illusionist-Documents-projects-brainztechs-momopay-ffff6666'
    const { io, reads } = fakeIo({
      [`${folder(F)}/cwd`]: { text: COORD, mtimeMs: 1 },
      [`${folder(F)}/alive/${A}`]: { text: beatText(beat()), mtimeMs: NOW - 2_000 },
    })
    await scanPeers(io, o)
    await scanPeers(io, o)
    expect(reads.filter(p => p.endsWith('/cwd'))).toEqual([`${folder(F)}/cwd`])
    // The beat is read each time: it changes
    expect(reads.filter(p => p.includes('/alive/')).length).toBe(2)
  })

  test('no convo folder, a folder without a cwd file, or an unreadable beat are skipped quietly', async () => {
    expect(await scanPeers(fakeIo({}).io, o)).toEqual({ peers: [], known: new Set() })
    const F = '-Users-illusionist-Documents-projects-brainztechs-momopay-gggg7777'
    const NOCWD = '-Users-illusionist-Documents-projects-brainztechs-momopay-hhhh8888'
    const { io } = fakeIo({
      [`${folder(NOCWD)}/alive/${A}`]: { text: beatText(beat()), mtimeMs: NOW - 2_000 },
      [`${folder(F)}/cwd`]: { text: COORD, mtimeMs: 1 },
      [`${folder(F)}/alive/${B}`]: { text: 'not json at all', mtimeMs: NOW - 2_000 },
    })
    const r = await scanPeers(io, o)
    expect(r.peers.map(p => [p.sid, p.beat])).toEqual([[B, undefined]])
    expect(r.known.has(A)).toBe(false)
  })
})

describe('what a peer has been doing', () => {
  const peer = (sid: string): Peer => ({ sid, cwd: `${COORD}/backend`, repo: `/r/${sid}/repo.git`, mtimeMs: NOW })
  const US = '\x1f'

  test('one git log on the peer\'s own repo and session branch: subjects, and the files touched without repeats', async () => {
    const { io, calls } = fakeIo({}, () => ({
      exitCode: 0,
      stdout: `turn 3: add the sqlc config${US}db/sqlc.yaml,db/query.sql\nturn 2: read the schema${US}db/schema.sql,db/query.sql\nturn 1: hello${US}\n`,
    }))
    const r = await peerSubjects(io, peer(A), 3)
    expect(r.subjects).toEqual(['turn 3: add the sqlc config', 'turn 2: read the schema', 'turn 1: hello'])
    expect(r.files).toEqual(['db/sqlc.yaml', 'db/query.sql', 'db/schema.sql'])
    expect(calls.length).toBe(1)
    expect(calls[0]?.argv).toEqual(['git', `--git-dir=/r/${A}/repo.git`, 'log', '--first-parent', '-n', '3', '--format=%s%x1f%(trailers:key=Files,valueonly,separator=%x2c)', `refs/heads/session/${A}`])
    expect(calls[0]?.opts).toEqual({ cwd: '/', timeoutMs: 20_000 })
  })

  test('the log follows the session branch only, so merged subagent turns are not the peer\'s own', async () => {
    const { io, calls } = fakeIo({}, () => ({ exitCode: 0, stdout: '' }))
    await peerSubjects(io, peer(A), 5)
    const argv = calls[0]?.argv ?? []
    expect(argv).toContain('--first-parent')
    expect(argv).toContain(`refs/heads/session/${A}`)
    expect(argv).toContain(`--git-dir=/r/${A}/repo.git`)
  })

  test('a git log that fails leaves that peer empty and the next peer unaffected', async () => {
    const { io } = fakeIo({}, argv =>
      argv.includes(`--git-dir=/r/${A}/repo.git`) ? { exitCode: 128, stderr: "fatal: ambiguous argument 'refs/heads/session/x'" } : { exitCode: 0, stdout: `turn 1: hi${US}a.go\n` },
    )
    expect(await peerSubjects(io, peer(A), 3)).toEqual({ subjects: [], files: [] })
    expect(await peerSubjects(io, peer(B), 3)).toEqual({ subjects: ['turn 1: hi'], files: ['a.go'] })
  })

  test('a process that throws is the same as one that fails', async () => {
    const { io } = fakeIo({}, () => {
      throw new Error('spawn failed')
    })
    expect(await peerSubjects(io, peer(A), 3)).toEqual({ subjects: [], files: [] })
  })
})

describe('chats convo has not seen', () => {
  const PROJECTS = `${HOME}/.claude/projects`
  const DIR = '-Users-illusionist-Documents-projects-brainztechs-momopay-backend'
  const DIR_OLD = '-Users-illusionist-Documents-projects-brainztechs-momopay-old'
  const DIR_OTHER = '-Users-illusionist-src-sessions'
  const U1 = 'd4e3f2a1-3333-4444-8555-666677778888'
  const U2 = 'e5f4a3b2-4444-4555-8666-777788889999'
  const U3 = 'f6a5b4c3-5555-4666-8777-88889999aaaa'
  const U4 = '0a1b2c3d-6666-4777-8888-9999aaaabbbb'
  const head = (sid: string, entrypoint: string, cwd: string) =>
    `{"type":"queue-operation","operation":"enqueue","sessionId":"${sid}"}\n` +
    JSON.stringify({ parentUuid: null, type: 'attachment', entrypoint, cwd, sessionId: sid, version: '2.1.308' }) + '\n'
  const u = { projectsDir: PROJECTS, coordCwd: COORD, now: NOW }

  test('runs head only on transcripts touched in the last 180 s, skips known chats, and counts the CLI and Desktop ones', async () => {
    const { io, calls } = fakeIo(
      {
        [`${PROJECTS}/${DIR}/${U1}.jsonl`]: { text: '', mtimeMs: NOW - 10_000 }, // cli: counted
        [`${PROJECTS}/${DIR}/${U2}.jsonl`]: { text: '', mtimeMs: NOW - 10_000 }, // known: skipped
        [`${PROJECTS}/${DIR}/${U3}.jsonl`]: { text: '', mtimeMs: NOW - 180_000 }, // too old: never read
        [`${PROJECTS}/${DIR}/${U4}.jsonl`]: { text: '', mtimeMs: NOW - 20_000 }, // sdk: not counted
        [`${PROJECTS}/${DIR}/${U1}/subagents/agent-1.jsonl`]: { text: '', mtimeMs: NOW - 1_000 }, // a subagent's: not a chat
        [`${PROJECTS}/${DIR_OLD}/${U3}.jsonl`]: { text: '', mtimeMs: NOW - 5_000 }, // a neighbour by name prefix: head says it is outside
        [`${PROJECTS}/${DIR_OTHER}/${U3}.jsonl`]: { text: '', mtimeMs: NOW - 5_000 }, // another folder: not looked at
      },
      argv => {
        const f = argv[3] ?? ''
        if (f.includes(U1)) return { exitCode: 0, stdout: head(U1, 'cli', `${COORD}/backend`) }
        if (f.includes(U4)) return { exitCode: 0, stdout: head(U4, 'sdk-py', `${COORD}/backend`) }
        if (f.includes(DIR_OLD)) return { exitCode: 0, stdout: head(U3, 'cli', `${COORD}-old`) }
        return { exitCode: 1 }
      },
    )
    const n = await unseenCount(io, { ...u, known: new Set([U2, ME]) })
    expect(n).toBe(1)
    expect(calls.map(c => c.argv)).toEqual([
      ['head', '-c', '8192', `${PROJECTS}/${DIR}/${U1}.jsonl`],
      ['head', '-c', '8192', `${PROJECTS}/${DIR}/${U4}.jsonl`],
      ['head', '-c', '8192', `${PROJECTS}/${DIR_OLD}/${U3}.jsonl`],
    ])
    expect(calls.every(c => c.opts.cwd === '/' && c.opts.timeoutMs === 5_000)).toBe(true)
  })

  test('the same chat found twice is one, and a head that cannot be read is none', async () => {
    const { io } = fakeIo(
      {
        [`${PROJECTS}/${DIR}/${U1}.jsonl`]: { text: '', mtimeMs: NOW - 10_000 },
        [`${PROJECTS}/${DIR}/${U2}.jsonl`]: { text: '', mtimeMs: NOW - 10_000 },
        [`${PROJECTS}/${DIR_OLD}/${U1}.jsonl`]: { text: '', mtimeMs: NOW - 10_000 },
      },
      argv => (argv[3]?.includes(U2) ? { exitCode: 1, stderr: 'head: cannot open' } : { exitCode: 0, stdout: head(U1, 'claude-desktop', `${COORD}/backend`) }),
    )
    expect(await unseenCount(io, { ...u, known: new Set() })).toBe(1)
  })

  test('no projects folder is no chats', async () => {
    expect(await unseenCount(fakeIo({}).io, { ...u, known: new Set() })).toBe(0)
  })
})

describe('git on another project\'s repo', () => {
  test('git and readFiles read the repo they are given, and this project\'s when none is', async () => {
    S.repo = '/mine/repo.git'
    try {
      const dirs = async (f: (io: Io) => Promise<unknown>): Promise<string[]> => {
        const { io, calls } = fakeIo({}, () => ({ exitCode: 1 })) // every call fails, readFiles falls back to `git show`: all of them name the repo
        await f(io)
        return [...new Set(calls.map(c => c.argv[1] ?? ''))]
      }
      expect(await dirs(io => git(io, ['log']))).toEqual(['--git-dir=/mine/repo.git'])
      expect(await dirs(io => git(io, ['log'], {}, '/theirs/repo.git'))).toEqual(['--git-dir=/theirs/repo.git'])
      expect(await dirs(io => readFiles(io, ['abc:turns/1.md']))).toEqual(['--git-dir=/mine/repo.git'])
      expect(await dirs(io => readFiles(io, ['abc:turns/1.md'], '/theirs/repo.git'))).toEqual(['--git-dir=/theirs/repo.git'])
    } finally {
      S.repo = ''
    }
  })
})
