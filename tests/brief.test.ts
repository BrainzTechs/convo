import { describe, expect, test } from 'claude-code/testing'
import { BRIEF_OPENING, BRIEF_TOKENS, renderBrief } from '../hooks/brief.ts'
import { emptyRecords, tokensOf, type Rec } from '../hooks/checkpoint.ts'

const rec = (id: string, kind: Rec['kind'], text: string, turn: number, more: Partial<Rec> = {}): Rec => ({ id, kind, text, turn, ...more })
const at = Date.UTC(2026, 9, 22, 10)

describe('the brief a new conversation starts with', () => {
  test('pins with their words, live decisions newest first, open tasks, where it stood; superseded and done left out', () => {
    const records = { ...emptyRecords(), throughTurn: 10, state: 'The ledger service compiles; transfers fail one test.', records: [
      rec('P1', 'pin', 'ledgerd runs on Go 1.23 only', 1, { quote: 'it must run on Go 1.23 only' }),
      rec('D1', 'decision', 'Service is named ledgerd', 1),
      rec('D2', 'decision', 'Port 8080', 2, { supersededBy: 'D3' }),
      rec('D3', 'decision', 'Port 9090', 7, { supersedes: 'D2' }),
      rec('T1', 'task', 'Fix TestTransfer', 9),
      rec('T2', 'task', 'Write the README', 4, { done: true, doneTurn: 8 }),
    ] }
    const b = renderBrief({ sid: 'aaaaaaaa-0000-4000-8000-000000000001', at, records, lastTurn: 12 })
    expect(b?.counts).toEqual({ pins: 1, decisions: 2, tasks: 1 })
    expect(b?.text).toBe([
      `${BRIEF_OPENING} · conversation aaaaaaaa, 2026-10-22, turns 1–12`,
      "Notes convo kept from the last conversation in this project, for continuity: they are not the person's new request. Its last 2 turns are not in these notes yet. Every turn is kept word for word: mcp__convo__recall with branch \"aaaaaaaa\" finds them (it asks the person first).",
      '',
      '## Where it stood',
      'The ledger service compiles; transfers fail one test.',
      '',
      '## Pins (the person asked for these to be kept in mind)',
      '- ledgerd runs on Go 1.23 only — they said "it must run on Go 1.23 only"',
      '',
      '## Decisions',
      '- Port 9090 (turn 7)',
      '- Service is named ledgerd (turn 1)',
      '',
      '## Open tasks',
      '- Fix TestTransfer (turn 9)',
    ].join('\n'))
  })

  test('nothing to carry over, no brief; a long history fits the cap, pins whole', () => {
    expect(renderBrief({ sid: 'a', at, records: emptyRecords(), lastTurn: 3 })).toBeUndefined()
    const many = [rec('P1', 'pin', 'Always run gofmt', 1), ...Array.from({ length: 80 }, (_, i) => rec(`D${i}`, 'decision', `Decision number ${i}: ${'the reasoning behind it '.repeat(20)}`, i + 1)), ...Array.from({ length: 40 }, (_, i) => rec(`T${i}`, 'task', `Task ${i}: ${'details '.repeat(8)}`, i + 1))]
    const b = renderBrief({ sid: 'bbbbbbbb', at, records: { ...emptyRecords(), throughTurn: 120, records: many }, lastTurn: 120 })
    expect(tokensOf(b?.text ?? '')).toBeLessThanOrEqual(BRIEF_TOKENS)
    expect(b?.text).toContain('- Always run gofmt')
    expect(b?.text).toContain('Decision number 79')
    expect(b?.counts.decisions).toBeLessThan(10)
  })
})
