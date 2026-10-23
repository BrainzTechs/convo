import { describe, expect, test } from 'claude-code/testing'
import { detailOf, fromTurnFiles, parseLog, timelineOf, toolsLine } from '../hooks/timeline.ts'
import { ago, contextNodes, gauge, historyNodes, panelNodes, turnFacts } from '../hooks/panel.ts'
import { emptyLedger } from '../hooks/ledger.ts'
import { unwrapPrompt } from '../hooks/turns.ts'
import type { ConvoEntry, ConvoView } from '../types/index.d.ts'

const S = '\x01'
const E = '\x02'
const commit = (hash: string, subject: string, at: string, parents: string, body: string, files: string[]): string => `\0${hash}${S}${subject}${S}${at}${S}${parents}${S}${body}${E}\n${files.join('\n')}\n`

describe("the pane's History", () => {
  test('commits become entries: a new turn by its trailers, an old one by its turn file, subagents, keyframes and merges', () => {
    const log = [
      commit('a'.repeat(40), 'turn 14: Fix the transfer test', '2026-10-23T10:00:00Z', 'p14 agentTip', 'Turn-Id: t14\nTools: Edit×2 Bash\nTokens: in 41200, out 300\nCost: 0.0412\nCondensed: 6.4k → 94 tokens (1 output)\nCleared-Before: 39k tokens (5 outputs)\nMerged-Agents: ae4b01\n', ['turns/0014-t14.md', 'agents/ae4b01/turns/0001-x.md']),
      commit('b'.repeat(40), 'records: turns 1–10', '2026-10-23T09:59:00Z', 'p', 'Kind: records\n', ['records.json']),
      commit('c'.repeat(40), 'keyframe 2: turns 1–10', '2026-10-23T09:58:00Z', 'p', 'Kind: keyframe\n', ['keyframe.md']),
      commit('d'.repeat(40), 'turn 10: Add the /metrics endpoint', '2026-10-23T09:50:00Z', 'p', 'Turn-Id: t10\nBranched-From: 3162559f-aaaa@0123456789ab\n', ['turns/0010-t10.md']),
      commit('e'.repeat(40), 'merge: session/3162559f (turns 5–6)', '2026-10-23T09:40:00Z', 'p q', 'Kind: merge\n', []),
    ].join('')
    const raws = parseLog(log)
    expect(raws.map(r => r.subject)).toEqual(['turn 14: Fix the transfer test', 'records: turns 1–10', 'keyframe 2: turns 1–10', 'turn 10: Add the /metrics endpoint', 'merge: session/3162559f (turns 5–6)'])
    const files = fromTurnFiles('turnId: t10\nusage: { in: 2, out: 50, cacheRead: 30000, cacheWrite: 900 }\n- Read `api/x.go` → ok, 3 lines\n- Edit `api/x.go` → ok, 1 lines\n- Read `api/y.go` → ok, 9 lines')
    const entries = timelineOf(raws, files, new Map([['agentTip', 'Find assembleTurn']]))
    expect(entries).toEqual([
      { kind: 'turn', id: 'aaaaaaa', n: 14, at: '2026-10-23T10:00:00Z', title: 'Fix the transfer test', tools: 'Edit×2 Bash', tokens: { in: 41200, out: 300 }, usd: 0.0412, condensed: '6.4k → 94 tokens (1 output)', clearedBefore: '39k tokens (5 outputs)', agents: [{ id: 'ae4b01', title: 'Find assembleTurn' }], path: 'turns/0014-t14.md' },
      { kind: 'keyframe', id: 'ccccccc', n: 2, at: '2026-10-23T09:58:00Z', title: 'turns 1–10' },
      { kind: 'turn', id: 'ddddddd', n: 10, at: '2026-10-23T09:50:00Z', title: 'Add the /metrics endpoint', tools: 'Read×2 Edit', tokens: { in: 30902, out: 50 }, mark: 'branched from 3162559f', path: 'turns/0010-t10.md' },
      { kind: 'merge', id: 'eeeeeee', at: '2026-10-23T09:40:00Z', title: 'session/3162559f (turns 5–6)' },
    ])
    expect(toolsLine(['Bash', 'Read', 'Bash'])).toBe('Bash×2 Read')
  })

  test('an old subagent reply is named by the subagent merged in', () => {
    const log = commit('d'.repeat(40), 'turn 3: <agent-message from="af5602dd96e12c41a">', '2026-10-23T10:00:00Z', 'p3 agentTip', 'Turn-Id: t3\nMerged-Agents: af5602\n', ['turns/0003-t3.md'])
    expect(timelineOf(parseLog(log), new Map(), new Map([['agentTip', 'Run the sleep loop']]))[0]?.title).toBe('(subagent reply) Run the sleep loop')
  })

  test("a turn file's detail: what was asked, the answer, its tools and files", () => {
    const d = detailOf(['---', 'turn: 3', 'files: ["store/ledger.go", "api/x.go"]', '---', '## Prompt', 'Run the tests.', '', '## Answer', 'One fails: TestTransfer.', '', '## Tools', '- Bash `go test ./...` → ok, 4 lines, 22315 chars, full output: blobs/aa/bb.txt', '    ok ...', '- Edit `store/ledger.go` → ok, 1 lines', ''].join('\n'))
    // A prompt a plugin submitted reads without Claude Code's framing
    const framed = ['## Prompt', 'The convodrive plugin sent a message:', 'Run the tests.', '', 'This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the', "user's place. Address the message above.", '', '## Answer', 'ok', ''].join('\n')
    expect(detailOf(framed).asked).toBe('Run the tests.')
    expect(unwrapPrompt('The x plugin sent a message:\nDo it.')).toBe('Do it.')
    expect(unwrapPrompt('Fix these:\n- a')).toBe('Fix these:\n- a')
    // A background subagent's result, as Claude Code hands it to the conversation
    expect(unwrapPrompt('Another Claude session sent a message:\nRun exactly this with Bash: done.\n\nThis is how Claude Code surfaces messages other sessions send.')).toBe('Run exactly this with Bash: done.')
    expect(unwrapPrompt('Someone said they sent a message:\nhi')).toBe('Someone said they sent a message:\nhi')
    expect(unwrapPrompt('Another Claude session sent a message:\n<agent-message from="af5602dd96e12c41a">\ndone. The loop printed step 1 through step 8.\n</agent-message>')).toBe('(subagent reply) done. The loop printed step 1 through step 8.')
    expect(unwrapPrompt('Another Claude session sent a message:\n<agent-message from="a1">Two files mention port.')).toBe('(subagent reply) Two files mention port.')
    expect(d).toEqual({ asked: 'Run the tests.', answer: 'One fails: TestTransfer.', tools: ['Bash `go test ./...`', 'Edit `store/ledger.go`'], files: ['store/ledger.go', 'api/x.go'] })
  })

  test('rows: a turn and its facts, a subagent, what was cleared before it, a keyframe; the open one expanded', () => {
    const now = Date.parse('2026-10-23T10:02:00Z')
    const e: ConvoEntry = { kind: 'turn', id: 'aaaaaaa', n: 14, at: '2026-10-23T10:00:00Z', title: 'Fix the transfer test', tools: 'Edit×2 Bash', tokens: { in: 41200, out: 300 }, usd: 0.0412, condensed: '6.4k → 94 tokens (1 output)', clearedBefore: '39k tokens (5 outputs)', agents: [{ id: 'ae4b01', title: 'Find assembleTurn' }], path: 'turns/0014-t14.md' }
    const k: ConvoEntry = { kind: 'keyframe', id: 'ccccccc', n: 2, at: '2026-10-23T09:58:00Z', title: 'turns 1–10' }
    expect(historyNodes([e, k], { tab: 'history' }, 80, now, 'tip1').map(n => n.text)).toEqual([
      '● 14  2m   Fix the transfer test',
      '│          Edit×2 Bash · 41k in · $0.04 · condensed 6.4k → 94 tokens (1 output)',
      '│╲ ⑂       Find assembleTurn',
      '✂         cleared 39k tokens (5 outputs) of old tool output',
      '◆     4m   keyframe 2 · turns 1–10',
    ])
    const open = historyNodes([e], { tab: 'history', open: 'aaaaaaa', detail: { asked: 'Fix it.', answer: 'Fixed the rounding.', tools: ['Edit `store/ledger.go`'], files: ['store/ledger.go'] } }, 80, now, 'tip1')
    expect(open.map(n => n.text)).toEqual([
      '▾ 14  2m   Fix the transfer test',
      '│          Edit×2 Bash · 41k in · $0.04 · condensed 6.4k → 94 tokens (1 output)',
      '│╲ ⑂       Find assembleTurn',
      '  asked:  Fix it.',
      '  answer: Fixed the rounding.',
      '  tool:   Edit `store/ledger.go`',
      '  files:  store/ledger.go',
      'show turn 14 in full',
      '✂         cleared 39k tokens (5 outputs) of old tool output',
    ])
    expect(open[0]).toMatchObject({ t: 'button', action: { kind: 'toggle', id: 'aaaaaaa', path: 'turns/0014-t14.md', tip: 'tip1' } })
    expect(open.find(n => n.text === 'show turn 14 in full')).toMatchObject({ hotkey: 'r', action: { kind: 'fill' } })
    expect(open[2]).toMatchObject({ t: 'button', action: { kind: 'fill', text: expect.stringContaining('subagent ae4b01') } })
    // Narrow: every row fits
    expect(historyNodes([e, k], { tab: 'history' }, 30, now).every(n => n.text.length <= 30)).toBe(true)
    expect(turnFacts({ kind: 'turn', id: 'x', at: '', title: '' })).toBe('')
    expect([ago('2026-10-23T10:01:50Z', now), ago('2026-10-23T07:00:00Z', now), ago('2026-10-20T10:00:00Z', now)]).toEqual(['now', '3h', '3d'])
  })

  test('the Context tab: a gauge against where it compacts, then the ledger', () => {
    // 18 cells at 40 columns: 52k of 200k fills 5
    expect(gauge(52_000, 200_000, 40)).toBe(`▕${'█'.repeat(5)}${'░'.repeat(13)}▏ 52k / 200k`)
    const l = { ...emptyLedger(0), requests: 3, uncached: 6, read: 100_000, write: 4000, output: 300, last: { main: { at: 0, model: 'opus', input: 52_000 } }, compactAt: 200_000, autoCompactAt: 967_000 }
    const text = contextNodes(l, 60).map(n => n.text)
    expect(text[0]).toMatch(/^▕█+░+▏ 52k \/ 200k$/)
    // Where it compacts is the ledger's line, said once
    expect(text.filter(t => /compacts at/.test(t ?? ''))).toEqual(['  compacts at 200k with a keyframe (your setting); Claude'])
    expect(text).toContain('  104k in over 3 requests, 300 out')
  })

  test('the whole pane: header, tabs with their keys, the tab, and how to use it', () => {
    const view: ConvoView = { sid: 'aaaaaaaa-1', turns: 2, questions: [], tasks: 0, lines: [], merges: [], agents: { all: 0, merged: 0 }, others: 0, at: '', history: [] }
    const nodes = panelNodes({ view, ledger: undefined, ui: { tab: 'history' }, width: 60, now: 0, focused: true })
    expect(nodes[0]?.t === 'text' && nodes[0].text).toBe('aaaaaaaa · 2 turns · all in view')
    // The tabs side by side, on one row
    const tabs = nodes[1]
    expect(tabs?.t === 'row' && tabs.items.map(b => [b.key, b.text, b.hotkey])).toEqual([['tab-history', '[History]', '1'], ['tab-context', 'Context', '2'], ['tab-lines', 'Lines', '3'], ['tab-agents', 'Agents', '4']])
    expect((nodes.at(-1) as { text: string }).text).toBe('Tab moves · Enter opens · 1–4 switch tabs · Esc back to the prompt')
    expect((panelNodes({ view, ledger: undefined, ui: { tab: 'history' }, width: 60, now: 0, focused: false, agent: 'ae4b01aa22' })[0] as { text: string }).text).toBe('subagent ae4b01aa22 · 2 turns')
    // Resumed under a new id, before a turn of its own
    expect((panelNodes({ view: { ...view, continues: 'e76194f7-1' }, ledger: undefined, ui: { tab: 'history' }, width: 80, now: 0, focused: false })[0] as { text: string }).text).toBe('aaaaaaaa · continues e76194f7 · 2 turns · all in view')
  })
})
