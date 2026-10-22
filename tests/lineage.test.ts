import { describe, expect, test } from 'claude-code/testing'
import { firstNewRow, indexLine, lineageTrailers, place, readIndex, readParents, rewoundRef, walkUp, withTrailers, type IndexEntry, type ParentMap } from '../hooks/lineage.ts'

const jsonl = (rows: [string, string | null, boolean?][]): string =>
  rows.map(([uuid, parentUuid, isSidechain]) => JSON.stringify({ type: 'user', uuid, parentUuid, isSidechain: isSidechain ?? false })).join('\n')

describe('transcript parents', () => {
  test('reads uuid → parent, skipping sidechains, non-rows and cut lines', () => {
    const map: ParentMap = new Map()
    readParents(`${jsonl([['a', null], ['b', 'a'], ['s', 'b', true]])}\n{"type":"last-prompt"}\n{"uuid":"c","parentUu`, map)
    expect([...map]).toEqual([['a', null], ['b', 'a']])
  })
})

describe('walking up', () => {
  // Turn 1: p1 → r1; attachments x1, x2; turn 2: p2 → r2
  const parents: ParentMap = new Map([['p1', null], ['r1', 'p1'], ['x1', 'r1'], ['x2', 'x1'], ['p2', 'x2'], ['r2', 'p2']])

  test('passes rows nobody recorded (attachments) to the nearest recorded one', () => {
    expect(walkUp('p2', parents, r => r === 'r1' || r === 'p1')).toEqual({ kind: 'hit', row: 'r1' })
  })
  test('a fresh conversation reaches its root', () => {
    expect(walkUp('p1', parents, () => false)).toEqual({ kind: 'root' })
    expect(walkUp('p2', parents, () => false)).toEqual({ kind: 'root' })
  })
  test('asks for more transcript when a link is missing', () => {
    expect(walkUp('zz', parents, () => false)).toEqual({ kind: 'missing', row: 'zz' })
    const cut: ParentMap = new Map([['p2', 'x2']])
    expect(walkUp('p2', cut, () => false)).toEqual({ kind: 'missing', row: 'x2' })
  })
  test('a turn whose rows include copied ones starts at its first new row', () => {
    expect(firstNewRow(['r1', 'p2', 'r2'], r => r === 'r1')).toBe('p2')
    expect(firstNewRow(['r1'], r => r === 'r1')).toBe(undefined)
    // Copied turns whose first and last rows are indexed: the turn's own rows start after the last indexed one
    const indexed = new Set(['a1', 'a3', 'b1', 'b2'])
    expect(firstNewRow(['a1', 'a2', 'a3', 'b1', 'b2', 'n1', 'n2'], r => indexed.has(r))).toBe('n1')
  })
})

describe('placement', () => {
  test('the next turn on the tip continues', () => {
    expect(place('t', undefined, 't', 0)).toEqual({ kind: 'continue', parent: 't' })
    expect(place('t', undefined, undefined, 0)).toEqual({ kind: 'continue', parent: 't' })
  })
  test('a first turn with no lineage starts at the base, or as a root', () => {
    expect(place(undefined, 'b', undefined, 0)).toEqual({ kind: 'continue', parent: 'b' })
    expect(place(undefined, undefined, undefined, 0)).toEqual({ kind: 'continue', parent: undefined })
  })
  test('a new session continuing another one is a branch', () => {
    expect(place(undefined, undefined, 'f', 0)).toEqual({ kind: 'branch', parent: 'f' })
  })
  test('a parent behind a compaction is the turns a keyframe kept, not a rewind (Claude Code cannot rewind past one)', () => {
    expect(place('kf', undefined, 'turn6', 1, true)).toEqual({ kind: 'continue', parent: 'kf' })
    expect(place('t9', undefined, 't8', 1, false)).toEqual({ kind: 'rewind', parent: 't8', abandoned: 't9' })
  })
  test('going back past turns is a rewind; past compactions alone is not', () => {
    expect(place('t', undefined, 'f', 2)).toEqual({ kind: 'rewind', parent: 'f', abandoned: 't' })
    expect(place('t', undefined, 'f', 0)).toEqual({ kind: 'continue', parent: 't' })
  })
  test('trailers and the kept ref', () => {
    expect(lineageTrailers({ kind: 'branch', parent: '0123456789abcdef' }, 'src', 'me')).toEqual(['Branched-From: src@0123456789ab'])
    expect(lineageTrailers({ kind: 'rewind', parent: 'aaaaaaaaaaaaaaaa', abandoned: 'bbbbbbbbbbbbbbbb' }, undefined, 'me')).toEqual(['Rewound-To: aaaaaaaaaaaa', 'Kept-As: rewound/me/bbbbbbbbbbbb'])
    expect(lineageTrailers({ kind: 'continue', parent: 't' }, undefined, 'me')).toEqual([])
    expect(rewoundRef('me', 'bbbbbbbbbbbbbbbb')).toBe('refs/heads/rewound/me/bbbbbbbbbbbb')
    expect(withTrailers('turn 1: x\n\nSession: s\n', ['A: 1'])).toBe('turn 1: x\n\nSession: s\nA: 1\n')
    expect(withTrailers('m\n', [])).toBe('m\n')
  })
})

describe('row index', () => {
  test('round-trips lines and ignores junk', () => {
    const into = new Map<string, IndexEntry>()
    readIndex(`${indexLine('r1', 'c1', 's1')}\n${indexLine('r2', 'c2', 's2')}\nbroken\n`, into)
    expect([...into]).toEqual([['r1', { commit: 'c1', sid: 's1' }], ['r2', { commit: 'c2', sid: 's2' }]])
  })
})
