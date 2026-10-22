import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { paneRows, readLine, wrapRow } from '../hooks/view.ts'
import type { ConvoView } from '../types/index.d.ts'

const VIEW: ConvoView = {
  sid: 'aaaaaaaa-0000-4000-8000-000000000001',
  turns: 13,
  context: { kind: 'keyframe', n: 3, afterTurn: 7, turnsSince: 6 },
  questions: ['Decide: HTTP port: undecided (here, turn 5) or 8080 (branch 3162559f, turn 5)?'],
  tasks: 1,
  lines: [
    { kind: 'fork', name: 'session/3162559f-578c-4262-b65e-c425411856b1', own: 1, splitAfter: 4, relation: 'merged', first: 'In this branch only, rename to ledgerx', when: '2 hours ago' },
    { kind: 'rewound', name: 'rewound/aaaaaaaa-0000-4000-8000-000000000001/568b84069ac5', own: 1, splitAfter: 4, relation: 'split', first: 'One more decision: the HTTP port is 8080', when: '2 hours ago' },
  ],
  merges: [{ from: 'session/3162559f-578c-4262-b65e-c425411856b1', afterTurn: 5, conflicts: 2 }],
  agents: { all: 1, merged: 1 },
  others: 2,
  at: '2026-10-22T00:00:00.000Z',
}

describe('what the pane says', () => {
  test('the conversation, what Claude works from, open questions, and its lines', () => {
    const text = paneRows(VIEW, 120).map(r => r.text)
    expect(text).toEqual([
      'Session aaaaaaaa · 13 turns',
      'Claude works from keyframe 3, made after turn 7, then 6 turns.',
      '1 question open:',
      '  HTTP port: undecided (here, turn 5) or 8080 (branch 3162559f, turn 5)?',
      '1 task open.',
      '',
      'Lines',
      '  fork 3162559f · split after turn 4 · 1 turn · merged after turn 5, 2 questions · 2 hours ago',
      '    “In this branch only, rename to ledgerx”',
      '  rewound after turn 4 · 1 turn · 2 hours ago',
      '    “One more decision: the HTTP port is 8080”',
      '  1 subagent, 1 merged in',
      '2 other conversations in this project.',
      '',
      'Ask Claude to recall, list or merge any of these.',
    ])
  })
  test('nothing compacted, nothing recorded, history off, and a narrow pane', () => {
    expect(paneRows({ ...VIEW, context: undefined }, 120)[1]?.text).toBe('Claude sees all 13 turns: nothing compacted yet.')
    expect(paneRows({ ...VIEW, context: { kind: 'native', n: 2, afterTurn: 9, turnsSince: 1 } }, 120)[1]?.text).toBe('Claude works from Claude Code’s summary (compaction 2), made after turn 9, then 1 turn.')
    expect(paneRows({ ...VIEW, turns: 0, context: undefined, lines: [], merges: [], questions: [], tasks: 0, agents: { all: 0, merged: 0 } }, 120)[1]?.text).toBe('Nothing recorded yet: each turn lands here when it ends.')
    expect(paneRows({ ...VIEW, off: 'git was not found' }, 120)).toEqual([{ text: 'History is off in this session: git was not found.', tone: 'warn' }])
    expect(paneRows(undefined, 120)[0]?.text).toMatch(/Reading/)
    expect(paneRows(VIEW, 24).every(r => r.text.length <= 24)).toBe(true)
    // Once nothing is open, a merge's questions read as settled
    expect(paneRows({ ...VIEW, questions: [] }, 200).map(r => r.text)).toContain('  fork 3162559f · split after turn 4 · 1 turn · merged after turn 5, 2 questions settled · 2 hours ago')
  })
  test('a long row wraps at a " · " under itself rather than losing its end', () => {
    expect(wrapRow('  fork 3162559f · split after turn 4 · 2 turns · merged after turn 5, 2 questions · 2 hours ago', 60)).toEqual([
      '  fork 3162559f · split after turn 4 · 2 turns',
      '    merged after turn 5, 2 questions · 2 hours ago',
    ])
    expect(wrapRow('short', 60)).toEqual(['short'])
    // At most three rows; the last is cut
    const long = wrapRow(`  ${'word '.repeat(60)}`, 30)
    expect(long.length).toBe(3)
    expect(long.every(r => r.length <= 30)).toBe(true)
    expect(long[2]?.endsWith('…')).toBe(true)
  })
  test('a line read from its commits: turns, the newest compaction, merges', () => {
    const entries = [
      { subject: 'turn 9: ok', body: '' },
      { subject: 'merge: session/bbb (turns 5–6)', body: 'Kind: merge\nMerged-From: session/bbb@0123456789ab\nBase: 0123456789ab\nConflicts: 2\n' },
      { subject: 'turn 8: x', body: '' },
      { subject: 'keyframe 2: turns 1–7', body: 'Kind: keyframe' },
      { subject: 'turn 7: y', body: '' },
      { subject: 'keyframe 1: native summary', body: '' },
      ...Array.from({ length: 6 }, (_, i) => ({ subject: `turn ${6 - i}: z`, body: '' })),
    ]
    expect(readLine(entries)).toEqual({
      turns: 9,
      context: { kind: 'keyframe', n: 2, afterTurn: 7, turnsSince: 2 },
      merges: [{ from: 'session/bbb', afterTurn: 8, conflicts: 2, base: '0123456789ab' }],
      rewinds: [],
    })
  })
})

/** Claude Code with git that holds nothing yet, and a surface that places panes. */
function world(on: On, opened: string[], stored: Record<string, unknown> = {}): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'aaaaaaaa-0000-4000-8000-000000000001' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/HEAD') }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__convo__${e.name}` } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.store(on, stored)
  mock.env(on, { HOME: '/h' })
  mock.clock(on)
}

const PANE = { plugin: 'convo', component: 'Pane', requestId: 'convo', props: { title: 'convo', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

describe('the pane', () => {
  test('draws what convo published on every surface', async ($, on) => {
    world(on, [])
    // A session with nothing in git yet: the view convo publishes at its start
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: false })
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /^Session / }))?.text).toBe('Session aaaaaaaa · 0 turns')
      expect((await ui.find({ type: 'Text', text: /Nothing recorded/ }))?.text).toBe('Nothing recorded yet: each turn lands here when it ends.')
      await ui.unmount()
    }
  })

  test('opens with an interactive session', async ($, on) => {
    const opened: string[] = []
    world(on, opened)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    expect(opened).toEqual(['convo'])
  })

  test('once the person has closed it, it stays shut until they ask Claude for it', async ($, on) => {
    const opened: string[] = []
    world(on, opened, { 'pane-closed': true })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    expect(opened).toEqual([])
    const r = await $.tool.call({ tool: 'mcp__convo__pane' })
    expect(opened).toEqual(['convo'])
    expect('result' in r ? String(r.result) : '').toContain('pane is open')
    // Asked for, it is the person's again: the next session opens it by itself
    opened.length = 0
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    expect(opened).toEqual(['convo'])
  })

  test('a run with nobody at the screen opens no pane', async ($, on) => {
    const opened: string[] = []
    world(on, opened)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    expect(opened).toEqual([])
  })
})
