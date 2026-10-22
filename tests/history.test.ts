import { describe, expect, test } from 'claude-code/testing'
import { emptyRecords, mergeRecords, renderKeyframe } from '../hooks/checkpoint.ts'
import { conflictQuestion, conflictTasks, labelOf, pickBranch, type BranchRef, formatBranches, formatRecall, mergeNote, mergePrompt, parseGrep, parseMergeAnswer, promptLineOf, queryTerms, rankFiles, candidates, relation, turnLabel } from '../hooks/history.ts'

describe('recall', () => {
  test('terms: phrases whole, short and common words dropped, at most eight', () => {
    expect(queryTerms('What did we decide about the "rate limit" for Redis?')).toEqual(['rate limit', 'decide', 'about', 'redis'])
    expect(queryTerms('a I x')).toEqual([])
    expect(queryTerms('one two three four five six seven eight nine ten').length).toBe(8)
  })

  test('grep output with and without a tree-ish', () => {
    expect(parseGrep('abc123:turns/0002-x.md:14:we chose Redis\nabc123:turns/0002-x.md:20:redis again\n', true)).toEqual([
      { ref: 'abc123', path: 'turns/0002-x.md', line: 14, text: 'we chose Redis' },
      { ref: 'abc123', path: 'turns/0002-x.md', line: 20, text: 'redis again' },
    ])
    expect(parseGrep('turns/0001-a.md:3:x:y', false)).toEqual([{ path: 'turns/0001-a.md', line: 3, text: 'x:y' }])
  })

  test('files matching more terms rank first; shared history counts once', () => {
    const hits = [
      ...parseGrep('t1:turns/0001-a.md:5:redis here\nt1:turns/0001-a.md:6:redis there\nt1:turns/0002-b.md:9:redis timeout\n', true),
      ...parseGrep('t2:turns/0002-b.md:9:redis timeout\n', true),
    ]
    const ranked = rankFiles(hits, ['redis', 'timeout'])
    expect(ranked.map(f => [f.path, f.terms, f.lines.length])).toEqual([['turns/0002-b.md', 2, 1], ['turns/0001-a.md', 1, 2]])
  })

  test('what the person said outranks tool output; a whole word outranks part of one; the newer turn wins a tie', () => {
    // turn 5: the person set the port; turn 9: a config dump says port; turn 12: "import" only contains it; turn 60: the person changed it
    const hits = parseGrep([
      't:turns/0005-a.md:16:The HTTP port is 8080.',
      't:turns/0009-b.md:30:    port = 3000',
      't:turns/0009-b.md:31:    ports: ["5432:5432"]',
      't:turns/0009-b.md:32:    port = 3001',
      't:turns/0012-c.md:16:Tidy the import block.',
      't:turns/0060-d.md:16:Move the HTTP port to 9090.',
    ].join('\n'), true)
    const heads = parseGrep(['5', '9', '12', '60'].map(n => `t:turns/${n.padStart(4, '0')}-${{ 5: 'a', 9: 'b', 12: 'c', 60: 'd' }[n]}.md:15:## Prompt\nt:turns/${n.padStart(4, '0')}-${{ 5: 'a', 9: 'b', 12: 'c', 60: 'd' }[n]}.md:20:## Tools`).join('\n'), true)
    const ranked = rankFiles(hits, ['port'], heads)
    expect(ranked.map(f => f.path)).toEqual(['turns/0060-d.md', 'turns/0005-a.md', 'turns/0009-b.md', 'turns/0012-c.md'])
    // Heading lines never count as hits
    expect(rankFiles([...hits, ...heads], ['port'], heads).map(f => f.path)).toEqual(ranked.map(f => f.path))
  })

  test('a rare word counts for more than a common one; the best lines are shown first', () => {
    const hits = parseGrep([
      't:turns/0001-a.md:3:files: ["go.mod"]',
      't:turns/0001-a.md:16:It must build with go 1.23.',
      't:turns/0002-b.md:16:Run go vet.',
      't:turns/0003-c.md:16:Run go test.',
    ].join('\n'), true)
    const heads = parseGrep(['0001-a', '0002-b', '0003-c'].map(f => `t:turns/${f}.md:15:## Prompt`).join('\n'), true)
    const ranked = rankFiles(hits, ['go', '1.23'], heads)
    expect(ranked[0]?.path).toBe('turns/0001-a.md')
    expect(ranked[0]?.lines[0]?.line).toBe(16)
    expect(candidates(hits, ['go', '1.23'], 2)).toEqual([{ ref: 't', path: 'turns/0001-a.md' }, { ref: 't', path: 'turns/0003-c.md' }])
  })

  test('labels, prompt lines and the answer text', () => {
    expect(turnLabel('turns/0007-ab.md')).toBe('turn 7')
    expect(turnLabel('merged/4add317e/turns/0006-x.md')).toBe('turn 6 of merged branch 4add317e')
    expect(turnLabel('agents/ag1/turns/0001-x.md')).toBe('turn 1 of subagent ag1')
    expect(promptLineOf('---\nturn: 1\n---\n## Prompt\nUse Redis please\nmore\n\n## Answer\nok')).toBe('Use Redis please')
    const text = formatRecall('redis', 'this branch', [{ path: 'turns/0002-b.md', score: 1, terms: 1, lines: [{ path: 'turns/0002-b.md', line: 9, text: 'redis timeout sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV' }], prompt: 'Pick a store' }], 1)
    expect(text).toContain('turn 2 · "Pick a store"\n  9: redis timeout')
    expect(text).not.toContain('ABCDEFGHIJKLMNOPQRSTUV')
    expect(formatRecall('zzz', 'this branch', [], 0)).toMatch(/No turn on this branch mentions/)
    expect(formatRecall('go version', 'this branch', [{ path: 'turns/0002-b.md', score: 1, terms: 1, lines: [], prompt: 'x' }], 1, ['version'])).toContain('No turn has "version"; these are ranked on the other words.')
  })
})

describe('branches', () => {
  const base = { turns: 6, lastSubject: 'turn 6: rename', when: '2 minutes ago' }
  test('how a line relates to this one', () => {
    expect(relation({ ...base, name: 'x', isContained: false, isAhead: false })).toBe('a separate conversation in this project')
    expect(relation({ ...base, name: 'x', shared: 5, isContained: false, isAhead: false })).toBe('split from this branch after turn 5')
    expect(relation({ ...base, name: 'x', shared: 6, isContained: true, isAhead: false })).toBe('already part of this branch')
    expect(relation({ ...base, name: 'x', shared: 4, isContained: false, isAhead: true })).toBe("continues past this branch's turn 4")
    const text = formatBranches('session/aaa', [{ ...base, name: 'session/4add317e', shared: 5, isContained: false, isAhead: false, firstOwn: 'turn 6: In this branch only, rename to ledgerx' }])
    expect(text).toContain('- session/4add317e: split from this branch after turn 5; 6 turns, last 2 minutes ago')
    expect(text).toContain('first of its own: turn 6: In this branch only')
  })
})

describe('merge', () => {
  const ours = mergeRecords(emptyRecords(), { state: 'Service named ledgerd.', add: [{ kind: 'decision', text: 'Name it ledgerd', turn: 1 }, { kind: 'task', text: 'Add /healthz', turn: 2 }], done: [] }, 5, [])

  test('the prompt carries this branch\'s live records and the other branch\'s turns', () => {
    const p = mergePrompt(ours, '4add317e', [{ n: 6, files: [], body: '## Prompt\nRename to ledgerx' }], { focus: 'the naming' })
    expect(p).toContain('D1 [decision] Name it ledgerd')
    expect(p).toContain('<turn n="6">')
    expect(p).toContain('The person wants this from it: the naming')
    expect(p).toMatch(/Never replace a current record/)
  })

  test('the answer: additions keep no supersedes, conflicts become open tasks, records carry their branch', () => {
    const m = parseMergeAnswer('```json\n{"note":"The branch renamed it.","state":"Two names in play.","add":[{"kind":"decision","text":"Port 9090","turn":7,"supersedes":"D1"}],"done":[{"id":"T1","turn":8}],"conflicts":[{"id":"D1","topic":"Service name","here":"ledgerd","hereTurn":1,"there":"ledgerx","thereTurn":6},{"topic":"half","here":"x"},{"question":""}]}\n```')
    expect(m?.note).toBe('The branch renamed it.')
    expect(m?.add).toEqual([{ kind: 'decision', text: 'Port 9090', turn: 7 }])
    expect(m?.conflicts).toEqual([{ id: 'D1', topic: 'Service name', here: 'ledgerd', hereTurn: 1, there: 'ledgerx', thereTurn: 6, question: undefined }])
    if (!m) return
    let r = mergeRecords(ours, m, ours.throughTurn, [], '4add317e')
    const questions = m.conflicts.map(c => conflictQuestion(c, 'branch 4add317e'))
    r = mergeRecords(r, { state: '', add: conflictTasks(questions), done: [] }, r.throughTurn, [])
    expect(r.throughTurn).toBe(5)
    expect(r.records.find(x => x.text === 'Port 9090')).toMatchObject({ id: 'D2', branch: '4add317e', turn: 7 })
    expect(r.records.find(x => x.id === 'D1')?.supersededBy).toBe(undefined)
    expect(r.records.find(x => x.id === 'T1')?.done).toBe(true)
    expect(r.records.find(x => x.id === 'T2')?.text).toBe('Decide: Service name: ledgerd (here, turn 1) or ledgerx (branch 4add317e, turn 6)?')
    const k = renderKeyframe({ n: 3, sid: 's', fromTurn: 1, toTurn: 5, records: r, recall: 'r' })
    expect(k).toContain('- D2 Port 9090 (branch 4add317e turn 7)')
    // The question says where each side came from, so it carries no turn stamp of its own
    expect(k).toContain('- [ ] T2 Decide: Service name: ledgerd (here, turn 1) or ledgerx (branch 4add317e, turn 6)?\n')
  })

  test('the note lists what came in and what needs deciding', () => {
    const note = mergeNote({ label: 'session/4add317e', turns: [6, 7], notes: ['Renamed it.'], added: ['- D2 [decision] Port 9090 (branch 4add317e turn 7)'], conflicts: ['ledgerx or ledgerd? (D1)'], n: 3 })
    expect(note).toContain('# Merged session/4add317e (turns 6–7) · keyframe 3')
    expect(note).toContain('## Needs your decision\n- ledgerx or ledgerd? (D1)')
    expect(note).toContain('recall (branch "session/4add317e")')
  })
})

describe('picking a branch', () => {
  const b = (name: string): BranchRef => ({ ref: `refs/heads/${name}`, name, tip: name.length.toString(), when: 'now', subject: 's' })
  const all = [b('session/4add317e-aaaa'), b('rewound/4add317e-aaaa/50ed62c592cb'), b('session/08aef133-bbbb'), b('session/08aef199-cccc')]
  test('a session id prefix picks the session line even when it was rewound', () => {
    expect(pickBranch(all, '4add317e').branch?.name).toBe('session/4add317e-aaaa')
    expect(pickBranch(all, 'session/4add317e-aaaa').branch?.name).toBe('session/4add317e-aaaa')
  })
  test('rewound lines by name or by their merge label', () => {
    expect(pickBranch(all, 'rewound/4add').branch?.name).toBe('rewound/4add317e-aaaa/50ed62c592cb')
    expect(labelOf('rewound/4add317e-aaaa/50ed62c592cb')).toBe('rewound-4add317e-50ed62c5')
    expect(pickBranch(all, 'rewound-4add317e-50ed62c5').branch?.name).toBe('rewound/4add317e-aaaa/50ed62c592cb')
    expect(labelOf('session/08aef133-bbbb')).toBe('08aef133')
  })
  test('ambiguous and unknown names say so; "this" is the current line', () => {
    expect(pickBranch(all, '08aef1').why).toMatch(/matches 2 branches/)
    expect(pickBranch(all, 'zzz').why).toMatch(/no branch/)
    expect(pickBranch(all, 'this', 'refs/heads/session/08aef133-bbbb').branch?.name).toBe('session/08aef133-bbbb')
  })
})

describe('recall paths and merge inputs', () => {
  test('a merged or subagent hit carries its path, since its number names a turn of this branch', () => {
    const t = formatRecall('x', 'this branch', [{ path: 'merged/4add317e/turns/0003-x.md', score: 1, terms: 1, lines: [{ path: 'merged/4add317e/turns/0003-x.md', line: 2, text: 'x' }], prompt: 'p' }], 1)
    expect(t).toContain('turn 3 of merged branch 4add317e [path: merged/4add317e/turns/0003-x.md]')
  })
  test('the other branch\'s own records go in, marked as its own', () => {
    const p = mergePrompt(emptyRecords(), '4add317e', [{ n: 6, files: [], body: 'b' }], { theirs: [{ id: 'D5', kind: 'decision', text: 'Use LRU', turn: 6 }] })
    expect(p).toContain("What branch 4add317e recorded since it split off (its own ids, not this branch's):\n- [decision] Use LRU")
    expect(p).toMatch(/ids in done and conflicts are always the current branch's/)
  })
})

describe('merge sees what was said here', () => {
  test("this branch's own turns since the split go in, newest kept, with the rule that they stand", () => {
    const mine = [{ n: 5, files: [], body: '## Prompt\nNo port decision yet, and plain log instead of zerolog.' }]
    const p = mergePrompt(emptyRecords(), '8bd23353', [{ n: 5, files: [], body: '## Prompt\nThe HTTP port is 8080.' }], { mine })
    expect(p).toContain('Turns on the current branch since the split (turns 5–5): what the person said here stands.')
    expect(p).toContain('No port decision yet')
    expect(p).toMatch(/A conflict is a real contradiction only/)
    expect(p).toMatch(/Never raise a follow-up or "should X also change\?" question/)
    expect(p).toMatch(/The note raises no question that is not in conflicts/)
    expect(p).toMatch(/What it still has from before the split \(the shared history\) is not its choice/)
    const many = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, files: [], body: 'x'.repeat(3000) }))
    const q = mergePrompt(emptyRecords(), 'b', [], { mine: many })
    expect(q).toMatch(/the newest \d+ of 40/)
    expect(q).toContain('<turn n="40">')
    expect(q).not.toContain('<turn n="1">')
  })
})

describe('merge questions', () => {
  test('topic: here or there, with where each side came from, and a side left by a rewind says so', () => {
    expect(conflictQuestion({ topic: 'HTTP port', here: 'undecided', hereTurn: 5, there: '8080', thereTurn: 5 }, 'branch 473582d0', true)).toBe('HTTP port: undecided (here, turn 5) or 8080 (branch 473582d0, turn 5, from before your rewind)?')
    expect(conflictQuestion({ question: 'Which stands?' }, 'b')).toBe('Which stands?')
  })
})
