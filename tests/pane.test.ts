import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { paneRows, readLine, wrapRow } from '../hooks/view.ts'
import { liveNodes, panelNodes } from '../hooks/panel.ts'
import type { ConvoLive, ConvoUi, ConvoView } from '../types/index.d.ts'

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

type Held = { text: string; mtimeMs: number }

/**
 * Claude Code with git that holds nothing yet, and a surface that places panes. `files` is a folder tree held
 * in memory (listed, read, stat-ed); `hold` makes every process wait for it. Returns the clock, which moves only when told.
 */
function world(on: On, opened: string[], stored: Record<string, unknown> = {}, gitAnswer: (args: readonly string[]) => string | undefined = () => undefined, o: { files?: Record<string, Held>; hold?: () => Promise<void>; listed?: string[] } = {}) {
  const files = o.files ?? {}
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
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'aaaaaaaa-0000-4000-8000-000000000001' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', async ($, e) => {
    await o.hold?.()
    const out = e.argv[0] === 'git' ? gitAnswer(e.argv.slice(2)) : undefined
    return { value: { exitCode: out === null ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/HEAD') }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', ($, e) => {
    o.listed?.push(e.path)
    return { value: [...kids(e.path)].map(([name, isFile]) => ({ name, kind: isFile ? 'file' as const : 'dir' as const, size: 0, mtimeMs: isFile ? (files[`${e.path}/${name}`]?.mtimeMs ?? 0) : 0, isLink: false })) }
  })
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: 0, mtimeMs: files[e.path]?.mtimeMs ?? 0, isLink: false } }))
  on('fs.read', ($, e) => {
    const f = files[e.path]
    if (!f) throw new Error(`ENOENT ${e.path}`)
    return { value: f.text }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__convo__${e.name}` } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.store(on, stored)
  mock.env(on, { HOME: '/h', CONVO_FORCE: '1' })
  return mock.clock(on)
}

const PANE = { plugin: 'convo', component: 'Pane', requestId: 'convo', props: { title: 'convo', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

describe('the pane', () => {
  test('draws what convo published on every surface: the header, the tabs, History first', async ($, on) => {
    world(on, [])
    // A session with nothing in git yet: the view convo publishes at its start
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: false })
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /^aaaaaaaa / }))?.text).toBe('aaaaaaaa · 0 turns')
      expect((await ui.find({ type: 'Text', text: /Nothing recorded/ }))?.text).toBe('Nothing recorded yet: each turn lands here when it ends.')
      expect((await ui.find({ type: 'Text', text: /ctrl\+x tab/ }))?.text).toBe('ctrl+x tab to use this pane')
      await ui.unmount()
    }
  })

  test('the tabs switch on a press, on every surface', async ($, on) => {
    world(on, [])
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'tab-context' })
      expect((await ui.find({ type: 'Text', text: /No requests counted/ }))?.text).toBe('No requests counted yet in this window.')
      await ui.press({ key: 'tab-lines' })
      expect((await ui.find({ type: 'Text', text: /No other lines/ }))?.text).toBe('No other lines: forks, rewinds and merges show here.')
      await ui.press({ key: 'tab-history' })
      expect(await ui.find({ type: 'Text', text: /Nothing recorded/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a turn opens on a press, and its button puts a ready prompt in the prompt box', async ($, on) => {
    const filled: string[] = []
    // git holding one turn: the line's tip, its log, and the turn file
    const at = new Date().toISOString()
    world(on, [], {}, args => {
      if (args[0] === 'rev-parse' && String(args[3]).startsWith('refs/heads/session/')) return 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe'
      if (args[0] === 'log' && args.includes('-n60')) return `\0c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe\x01turn 13: Run the tests\x01${at}\x01p\x01Turn-Id: t13\nTools: Bash\nCost: 0.04\n\x02\nturns/0013-t13.md`
      if (args[0] === 'log' && args.includes('5000')) return 'turn 13: Run the tests\x01Turn-Id: t13\x00'
      if (args[0] === 'show' && String(args[1]).endsWith(':turns/0013-t13.md')) return '---\nfiles: ["store/ledger.go"]\n---\n## Prompt\nRun the tests.\n\n## Answer\nOne fails: TestTransfer.\n'
      if (args[0] === 'show') return null as unknown as undefined
      return undefined
    })
    on('prompt.fill', ($, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'turn-c0ffee1' }))?.text).toMatch(/^● 13 {2}now {2}Run the tests$/)
    expect((await ui.find({ type: 'Text', text: /Bash · \$0\.04/ }))?.text).toBe('│          Bash · $0.04')
    await ui.press({ key: 'turn-c0ffee1' })
    expect((await ui.find({ key: 'turn-c0ffee1' }))?.text).toMatch(/^▾ 13/)
    expect((await ui.find({ type: 'Text', text: /answer:/ }))?.text).toBe('  answer: One fails: TestTransfer.')
    await ui.press({ key: 'full-c0ffee1' })
    expect(filled).toEqual(["Show me turn 13 of this conversation in full with convo's turn tool."])
    await ui.press({ key: 'turn-c0ffee1' })
    expect((await ui.find({ key: 'turn-c0ffee1' }))?.text).toMatch(/^● 13/)
    expect(await ui.find({ type: 'Text', text: /answer:/ })).toBeUndefined()
    await ui.unmount()
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

const LIVE = { plugin: 'convo', key: 'live' } as const
const SID = { b: 'b2c1d0ff-1111-4222-8333-444455556666', w: 'c3d2e1f0-2222-4333-8444-555566667777', f: 'd4e3f2a1-3333-4444-8555-666677778888' }

/** Three peers as a coordinator sees them: two working, one idle, and two chats convo does not record. */
function liveFixture(now: number): ConvoLive {
  return {
    peers: [
      { sid: SID.b, name: 'backend', state: 'working', since: now - 180_000, prompt: 'migrate payments repo to sqlc', subjects: ['turn 9: add the sqlc config', 'turn 8: read the schema', 'turn 7: a', 'turn 6: b', 'turn 5: c'] },
      { sid: SID.w, name: 'backend/wt agent-a1b2', state: 'working', since: now - 41_000, prompt: 'fix trial billing proration', subjects: [] },
      { sid: SID.f, name: 'frontend', state: 'idle', since: now - 720_000, prompt: 'checkout form validation', subjects: [] },
    ],
    unseen: 2,
    working: 2,
    at: now,
  }
}

describe('the Live tab', () => {
  test('rows: working first, how long, the prompt in quotes; an idle one says what it did last; the unrecorded chats close the list', () => {
    const now = 1_000_000_000
    const ui: ConvoUi = { tab: 'live' }
    const nodes = liveNodes(liveFixture(now), ui, 100, now)
    const text = nodes.map(n => n.text)
    expect(text.length).toBe(4)
    expect(text[0]).toMatch(/^backend {2,}working 3m {2,}"migrate payments repo to sqlc"$/)
    expect(text[1]).toMatch(/^backend\/wt agent-a1b2 {2,}working 41s {2,}"fix trial billing proration"$/)
    expect(text[2]).toMatch(/^frontend {2,}idle 12m {2,}last: "checkout form validation"$/)
    expect(text[3]).toBe("2 chats here aren't recorded by convo")
    expect(nodes.slice(0, 3).every(n => n.t === 'button')).toBe(true)
    // Cut to the pane
    expect(liveNodes(liveFixture(now), ui, 30, now).every(n => n.text.length <= 30)).toBe(true)
  })

  test('the tab row ends with Live (n) on hotkey 5, whichever tab is open', () => {
    const view: ConvoView = { ...VIEW, history: [] }
    for (const tab of ['history', 'context', 'lines', 'agents', 'live'] as const) {
      const row = panelNodes({ view, ledger: undefined, ui: { tab }, width: 80, now: 1_000_000_000, focused: true, live: liveFixture(1_000_000_000) })[1]
      const live = row?.t === 'row' ? row.items.at(-1) : undefined
      expect([live?.key, live?.text, live?.hotkey]).toEqual(['tab-live', tab === 'live' ? '[Live (2)]' : 'Live (2)', '5'])
    }
    // Nobody working: no count
    const none = panelNodes({ view, ledger: undefined, ui: { tab: 'history' }, width: 80, now: 0, focused: true, live: { peers: [], unseen: 0, working: 0, at: 0 } })[1]
    expect(none?.t === 'row' && none.items.at(-1)?.text).toBe('Live')
  })

  test('nothing live is one dim line; one unrecorded chat reads in the singular', () => {
    const none = liveNodes(undefined, { tab: 'live' }, 80, 0)
    expect(none).toEqual([{ t: 'text', text: 'No other chats running inside this folder.', tone: 'dim' }])
    expect(liveNodes({ peers: [], unseen: 0, working: 0, at: 0 }, { tab: 'live' }, 80, 0)).toEqual(none)
    expect(liveNodes({ peers: [], unseen: 1, working: 0, at: 0 }, { tab: 'live' }, 80, 0).map(n => n.text)).toEqual([none[0]?.text, "1 chat here isn't recorded by convo"])
  })

  test('an open row lists its turn subjects; a chat with no beat is shown as alive', () => {
    const now = 1_000_000_000
    const live = liveFixture(now)
    const nodes = liveNodes({ ...live, peers: [...live.peers, { sid: 'e5f4a3b2-4444-4555-8666-777788889999', name: '.', state: 'unknown', since: now - 20_000, subjects: [] }] }, { tab: 'live', open: `peer:${SID.b}` }, 100, now)
    const text = nodes.map(n => n.text)
    expect(text[0]).toMatch(/^▾ backend/)
    expect(text.slice(1, 6)).toEqual(['    · turn 9: add the sqlc config', '    · turn 8: read the schema', '    · turn 7: a', '    · turn 6: b', '    · turn 5: c'])
    expect(text.find(t => t.includes('alive'))).toMatch(/^\. {2,}alive/)
    // A row with no subjects yet says so when opened
    const w = liveNodes(live, { tab: 'live', open: `peer:${SID.w}` }, 100, now).map(n => n.text)
    expect(w).toContain('    no turns recorded yet')
    // One whose history git could not read says that, not "nothing recorded"
    const failed = { ...live, peers: live.peers.map(p => (p.sid === SID.w ? { ...p, failed: true as const } : p)) }
    const f = liveNodes(failed, { tab: 'live', open: `peer:${SID.w}` }, 100, now).map(n => n.text)
    expect(f).toContain('    could not be read (git failed)')
    expect(f).not.toContain('    no turns recorded yet')
  })

  test('the tab shows how many work, on every tab, with hotkey 5; the list draws on both surfaces and a press shows the subjects without git', async ($, on) => {
    const gitCalls: string[][] = []
    world(on, [], {}, args => {
      gitCalls.push([...args])
      return undefined
    })
    // What the ticks would have written: the tab reads it from session state
    on('state.get', async ($, e, next) => (e.key === 'live' ? { value: { value: liveFixture(Date.now()), version: 1 } } : next(e)))
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'tab-live' }))?.text).toBe('Live (2)')
      expect((await ui.find({ key: 'tab-agents' }))?.text).toBe('Agents')
      await ui.press({ key: 'tab-context' })
      expect((await ui.find({ key: 'tab-live' }))?.text).toBe('Live (2)')
      await ui.press({ key: 'tab-live' })
      expect((await ui.find({ key: 'tab-live' }))?.text).toBe('[Live (2)]')
      expect((await ui.find({ key: `peer-${SID.b}` }))?.text).toMatch(/^backend {2,}working 3m {2,}"migrate payments repo to sqlc"$/)
      expect((await ui.find({ key: `peer-${SID.f}` }))?.text).toMatch(/^frontend {2,}idle 12m {2,}last: "checkout form validation"$/)
      expect((await ui.find({ type: 'Text', text: /aren't recorded/ }))?.text).toBe("2 chats here aren't recorded by convo")
      const runs = gitCalls.length
      await ui.press({ key: `peer-${SID.b}` })
      expect((await ui.find({ type: 'Text', text: /sqlc config/ }))?.text).toBe('    · turn 9: add the sqlc config')
      expect((await ui.find({ type: 'Text', text: /turn 5: c/ }))?.text).toBe('    · turn 5: c')
      // Read from what the tab holds: git was not asked
      expect(gitCalls.length).toBe(runs)
      await ui.press({ key: `peer-${SID.b}` })
      expect(await ui.find({ type: 'Text', text: /sqlc config/ })).toBeUndefined()
      await ui.press({ key: 'tab-history' })
      await ui.unmount()
    }
  })

  test('with nothing published the tab says no other chats are running', async ($, on) => {
    world(on, [])
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'tab-live' }))?.text).toBe('Live')
      await ui.press({ key: 'tab-live' })
      expect((await ui.find({ type: 'Text', text: /No other chats/ }))?.text).toBe('No other chats running inside this folder.')
      await ui.press({ key: 'tab-history' })
      await ui.unmount()
    }
  })
})

describe('the Live tab keeps itself current', () => {
  const FOLDER = '/h/.claude/convo/-proj-backend-aaaa1111'
  const FOLDER2 = '/h/.claude/convo/-proj-frontend-bbbb2222'
  const beat = (o: object) => JSON.stringify({ v: 1, at: Date.now(), interactive: true, ...o })
  const peers = (): Record<string, Held> => ({
    [`${FOLDER}/cwd`]: { text: '/proj/backend\n', mtimeMs: 1 },
    [`${FOLDER}/alive/${SID.b}`]: { text: beat({ state: 'working', since: Date.now() - 180_000, prompt: 'migrate payments repo to sqlc' }), mtimeMs: Date.now() - 2_000 },
    [`${FOLDER2}/cwd`]: { text: '/proj/frontend\n', mtimeMs: 1 },
    [`${FOLDER2}/alive/${SID.f}`]: { text: beat({ state: 'idle', since: Date.now() - 720_000, prompt: 'checkout form validation' }), mtimeMs: Date.now() - 2_000 },
  })
  const subjects = (args: readonly string[]): string | undefined => (args[0] === 'log' && args.includes('--first-parent') ? 'turn 2: x\x1f\nturn 1: y\x1f\n' : undefined)
  const scans = (listed: string[]): number => listed.filter(p => p === '/h/.claude/convo').length

  test('with the pane open a cheap scan every 30 s keeps the count; the rows wait for the Live tab, and then refresh every 15 s', async ($, on) => {
    const listed: string[] = []
    const git: string[][] = []
    const clock = world(on, [], {}, args => {
      if (subjects(args) !== undefined) git.push([...args])
      return subjects(args)
    }, { files: peers(), listed })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'tab-live' }))?.text).toBe('Live')
    await clock.advance(30_000)
    expect((await ui.find({ key: 'tab-live' }))?.text).toBe('Live (1)')
    // History is showing: no git read for the rows
    expect(git).toEqual([])
    await ui.press({ key: 'tab-live' })
    await clock.settle()
    expect((await ui.find({ key: `peer-${SID.b}` }))?.text).toMatch(/^backend {2,}working 3m {2,}"migrate payments repo to sqlc"$/)
    expect((await ui.find({ key: `peer-${SID.f}` }))?.text).toMatch(/^frontend {2,}idle 12m {2,}last: "checkout form validation"$/)
    expect(git.length).toBe(2)
    const before = git.length
    await clock.advance(15_000)
    expect(git.length).toBe(before + 2)
    await ui.unmount()
  })

  test('with no pane open nothing is scanned', async ($, on) => {
    const listed: string[] = []
    const clock = world(on, [], {}, subjects, { files: peers(), listed })
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    await clock.advance(60_000)
    expect(scans(listed)).toBe(0)
  })

  test('a tick that is still reading git makes the next one wait', async ($, on) => {
    const listed: string[] = []
    const git: string[][] = []
    let slow = false
    const clock = world(on, [], {}, args => {
      if (subjects(args) !== undefined) git.push([...args])
      return subjects(args)
    }, { files: peers(), listed, hold: async () => { if (slow) await clock.sleep(40_000) } })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'tab-live' })
    await clock.settle()
    git.length = 0
    slow = true
    const before = scans(listed)
    // Due at 15 s, 30 s and 45 s while the first one's git reads wait 40 s
    await clock.advance(15_000)
    await clock.advance(15_000)
    await clock.advance(10_000)
    const during = scans(listed)
    expect(during - before).toBe(1)
    slow = false
    await clock.advance(10_000)
    await clock.advance(10_000)
    expect(scans(listed)).toBeGreaterThan(during)
    await ui.unmount()
  })
})
