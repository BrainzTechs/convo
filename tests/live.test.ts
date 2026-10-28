import { describe, expect, test } from 'claude-code/testing'
import { beatText, decideActive, inUse, isInside, isPeer, isUnseenHead, ordered, parseBeat, parseExclude, relName, type Beat, type Peer } from '../hooks/live.ts'

describe('the off switch', () => {
  test('parseExclude cleans paths', () => {
    expect(parseExclude(' ~/Downloads/ , ,/a/b,, ', '/h')).toEqual(['/h/Downloads', '/a/b'])
    expect(parseExclude(undefined, '/h')).toEqual([])
    expect(parseExclude('relative/x', '/h')).toEqual([]) // only absolute or ~ paths
  })

  test('isInside is the folder itself or anything under it, never a prefix of a name', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })

  test('decideActive', () => {
    const base = { isInteractive: true, force: undefined, cwd: '/a/momopay/backend', exclude: [] }
    expect(decideActive(base)).toEqual({ active: true, why: '' })
    expect(decideActive({ ...base, isInteractive: false }).active).toBe(false)
    expect(decideActive({ ...base, isInteractive: false, force: '1' }).active).toBe(true)
    expect(decideActive({ ...base, exclude: ['/a/momopay'] }).active).toBe(false)
    expect(decideActive({ ...base, exclude: ['/a/momopay'], force: '1' }).active).toBe(false) // force never beats exclude
    expect(decideActive({ ...base, exclude: ['/a/momo'] }).active).toBe(true) // prefix trap
    expect(decideActive({ ...base, isInteractive: false }).why).toContain('not interactive')
    expect(decideActive({ ...base, exclude: ['/a/momopay'] }).why).toBe('excluded folder /a/momopay')
  })
})

describe('the heartbeat file', () => {
  test('parseBeat rejects what is not a v1 beat', () => {
    expect(parseBeat('1792913206856')).toBeUndefined() // the old bare timestamp
    expect(parseBeat('')).toBeUndefined()
    expect(parseBeat('{')).toBeUndefined()
    expect(parseBeat('{"v":2}')).toBeUndefined()
  })

  test('a beat round-trips', () => {
    const b: Beat = { v: 1, at: 1792913206856, state: 'working', since: 1792913200000, prompt: 'migrate payments repo to sqlc', turns: 4, interactive: true, holds: ['/a/b'], holdsUnknown: 1 }
    expect(parseBeat(beatText(b))).toEqual(b)
  })
})

const COORD = '/Users/illusionist/Documents/projects/brainztechs/momopay'
const BACKEND = `${COORD}/backend`
const WORKTREE = `${COORD}/backend/.claude/worktrees/agent-a1b2`
const OLD = `${COORD}-old`
const NOW = 1792913206856
const ME = '7695cbc7-3596-429d-bc98-795cc0776a3b'
const OTHER = 'b2c1d0ff-1111-4222-8333-444455556666'

const beat = (o: Partial<Beat> = {}): Beat => ({ v: 1, at: NOW - 5_000, state: 'idle', since: NOW - 60_000, interactive: true, ...o })
const peer = (cwd: string, o: Partial<Peer> = {}): Peer => ({ sid: OTHER, cwd, repo: '/h/.claude/convo/x/repo.git', mtimeMs: NOW - 5_000, ...o })
const here = { coordCwd: COORD, selfSid: ME, now: NOW }

describe('who counts as a peer', () => {
  test('a chat inside the folder is a peer; a folder that only shares its name prefix is not', () => {
    expect(isPeer(peer(BACKEND), here)).toBe(true)
    expect(isPeer(peer(WORKTREE), here)).toBe(true)
    expect(isPeer(peer(COORD), here)).toBe(true) // the same folder: two chats side by side
    expect(isPeer(peer(OLD), here)).toBe(false)
    expect(isPeer(peer('/Users/illusionist/Documents/projects'), here)).toBe(false)
  })

  test('a trailing slash on the coordinator changes nothing', () => {
    expect(isPeer(peer(BACKEND), { ...here, coordCwd: `${COORD}/` })).toBe(true)
    expect(isPeer(peer(OLD), { ...here, coordCwd: `${COORD}/` })).toBe(false)
  })

  test('this chat is never its own peer', () => {
    expect(isPeer(peer(COORD, { sid: ME }), here)).toBe(false)
  })

  test('an ended chat, a stale heartbeat, and an automated run are out; no beat at all is in', () => {
    expect(isPeer(peer(BACKEND, { beat: beat({ state: 'ended' }) }), here)).toBe(false)
    expect(isPeer(peer(BACKEND, { mtimeMs: NOW - 180_000 }), here)).toBe(false) // exactly GONE_MS old
    expect(isPeer(peer(BACKEND, { mtimeMs: NOW - 179_999 }), here)).toBe(true)
    expect(isPeer(peer(BACKEND, { beat: beat({ interactive: false }) }), here)).toBe(false)
    expect(isPeer(peer(BACKEND, { beat: beat({ state: 'working' }) }), here)).toBe(true)
    expect(isPeer(peer(BACKEND), here)).toBe(true) // the old bare timestamp parses to no beat
  })
})

describe('listing peers', () => {
  test('working chats first, then the most recently started', () => {
    const a = peer(BACKEND, { sid: 'a', beat: beat({ since: 100 }) })
    const b = peer(BACKEND, { sid: 'b', beat: beat({ since: 300 }) })
    const c = peer(BACKEND, { sid: 'c', beat: beat({ state: 'working', since: 50 }) })
    const d = peer(BACKEND, { sid: 'd', mtimeMs: 200 }) // no beat: its file time stands in for `since`
    expect(ordered([a, b, c, d]).map(p => p.sid)).toEqual(['c', 'b', 'd', 'a'])
    const list = [a, b]
    ordered(list)
    expect(list.map(p => p.sid)).toEqual(['a', 'b']) // the input is left as it was
  })

  test('relName is the folder below the coordinator, worktrees as "wt"', () => {
    expect(relName(COORD, COORD)).toBe('.')
    expect(relName(`${COORD}/`, COORD)).toBe('.')
    expect(relName(COORD, BACKEND)).toBe('backend')
    expect(relName(COORD, WORKTREE)).toBe('backend/wt agent-a1b2')
    expect(relName(COORD, `${COORD}/.claude/worktrees/agent-c3d4`)).toBe('wt agent-c3d4')
  })
})

describe('which folders are in use', () => {
  test('a worktree is in use while a peer works in it', () => {
    expect(inUse(WORKTREE, [peer(WORKTREE)])).toBe(true)
    expect(inUse(WORKTREE, [peer(`${WORKTREE}/src`)])).toBe(true) // deeper inside
    expect(inUse(`${COORD}/backend/.claude`, [peer(WORKTREE)])).toBe(true) // a parent of where it works
  })

  test('a worktree a peer holds is in use, wherever that peer sits', () => {
    expect(inUse(WORKTREE, [peer(COORD, { beat: beat({ holds: [WORKTREE] }) })])).toBe(true)
    expect(inUse(`${WORKTREE}/src`, [peer(COORD, { beat: beat({ holds: [WORKTREE] }) })])).toBe(true) // inside a held folder
  })

  test('under a peer whose subagent worktrees are unknown it is in use; once none are unknown it is free', () => {
    expect(inUse(WORKTREE, [peer(BACKEND, { beat: beat({ holdsUnknown: 1 }) })])).toBe(true)
    expect(inUse(WORKTREE, [peer(BACKEND, { beat: beat({ holdsUnknown: 0, holds: [] }) })])).toBe(false)
    expect(inUse(WORKTREE, [peer(BACKEND)])).toBe(false) // no beat says nothing is held
  })

  test('another chat\'s folder or a name-prefix neighbour is not in use', () => {
    expect(inUse(WORKTREE, [peer(`${BACKEND}/.claude/worktrees/agent-zzzz`)])).toBe(false)
    expect(inUse(`${COORD}/backend`, [peer(`${COORD}/backend-old`)])).toBe(false)
    expect(inUse(WORKTREE, [])).toBe(false)
  })
})

// A real transcript head, cut to the fields the check reads (the first two lines are Claude Code's own queue notes)
const SID = 'db6c7807-5cd8-41fd-beb5-c54f1ae0e07f'
const line = (entrypoint: string, cwd: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'attachment', uuid: 'c67e60fe-4874-4f83-8242-3912c11bde2d', timestamp: '2026-10-27T14:24:19.590Z', userType: 'external', entrypoint, cwd, sessionId: SID, version: '2.1.308', gitBranch: 'HEAD' })
const queue = [
  `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-27T14:24:21.708Z","sessionId":"${SID}"}`,
  `{"type":"queue-operation","operation":"dequeue","timestamp":"2026-10-27T14:24:21.715Z","sessionId":"${SID}"}`,
]
const head = (...lines: string[]): string => [...queue, ...lines].join('\n') + '\n'

describe('chats convo has not seen', () => {
  test('a Claude Code chat inside the folder gives its session; an SDK run does not', () => {
    expect(isUnseenHead(head(line('cli', BACKEND)), COORD)).toEqual({ sid: SID })
    expect(isUnseenHead(head(line('claude-desktop', BACKEND)), COORD)).toEqual({ sid: SID })
    expect(isUnseenHead(head(line('sdk-py', BACKEND)), COORD)).toBeUndefined()
    expect(isUnseenHead(head(line('sdk-cli', BACKEND)), COORD)).toBeUndefined()
  })

  test('a chat outside the folder, or in a name-prefix neighbour, is not one', () => {
    expect(isUnseenHead(head(line('cli', OLD)), COORD)).toBeUndefined()
    expect(isUnseenHead(head(line('cli', '/Users/illusionist/src')), COORD)).toBeUndefined()
    expect(isUnseenHead(head(line('cli', COORD)), `${COORD}/`)).toEqual({ sid: SID })
  })

  test('a last line cut by the 8 KiB limit is ignored; the whole lines before it still count', () => {
    const torn = line('cli', BACKEND).slice(0, 120)
    expect(isUnseenHead(head(torn), COORD)).toBeUndefined()
    expect(isUnseenHead(head(line('cli', BACKEND), torn), COORD)).toEqual({ sid: SID })
    expect(isUnseenHead('', COORD)).toBeUndefined()
    expect(isUnseenHead('not json\n[1,2]\nnull\n', COORD)).toBeUndefined()
  })
})
