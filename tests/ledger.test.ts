import { describe, expect, test } from 'claude-code/testing'
import { addAgentRun, addStep, addToolOutput, emptyLedger, k, ledgerRows, readBreakdown, type Step } from '../hooks/ledger.ts'

const MIN = 60_000
const step = (at: number, read: number, write: number, more: Partial<Step> = {}): Step => ({ loop: 'main', model: 'opus', at, uncached: 2, read, write, output: 100, ...more })

describe('the token ledger', () => {
  test('a growing conversation reads from the cache and is no miss', () => {
    let l = emptyLedger(0)
    l = addStep(l, step(0, 30_000, 10_000))
    l = addStep(l, step(1 * MIN, 40_000, 800))
    l = addStep(l, step(2 * MIN, 40_800, 1200))
    expect(l.requests).toBe(3)
    expect(l.misses).toEqual([])
    expect(l.read).toBe(110_800)
  })

  test('a miss after a long pause says so, with its turn and size', () => {
    let l = addStep(emptyLedger(0), step(0, 30_000, 10_000))
    l = addStep(l, step(8 * MIN, 0, 41_000), { turn: 14 })
    expect(l.misses).toEqual([{ at: 8 * MIN, loop: 'main', tokens: 41_000, why: 'the cache expired after 8 minutes idle', turn: 14 }])
    expect(l.missTokens).toBe(41_000)
  })

  test('another model, or a changed start of the request, are misses too; a compaction is expected', () => {
    let l = addStep(emptyLedger(0), step(0, 30_000, 10_000))
    l = addStep(l, step(1 * MIN, 0, 40_000, { model: 'sonnet' }))
    expect(l.misses.at(-1)?.why).toBe('the model changed to sonnet')
    l = addStep(l, step(2 * MIN, 1000, 39_000, { model: 'sonnet' }))
    expect(l.misses.at(-1)?.why).toMatch(/start of the request changed/)
    l = addStep(l, step(3 * MIN, 0, 9000, { model: 'sonnet' }), { compactedAt: 2.5 * MIN })
    expect(l.misses.length).toBe(2)
    expect(l.expected).toBe(1)
  })

  test("each subagent has its own cache: its first request is no miss, and its tokens are its own", () => {
    let l = addStep(emptyLedger(0), step(0, 30_000, 10_000))
    l = addStep(l, step(1 * MIN, 0, 25_000, { loop: 'agent1', model: 'haiku' }))
    l = addAgentRun(l)
    expect(l.misses).toEqual([])
    expect(l.agents).toEqual({ runs: 1, tokens: 25_102, models: ['haiku'] })
  })

  test('tool output adds up by tool; /context gives setup and conversation', () => {
    let l = addToolOutput(addToolOutput(emptyLedger(0), { Bash: 6000, Read: 1000 }), { Bash: 500 })
    expect(l.toolOutput).toEqual({ Bash: 6500, Read: 1000 })
    l = { ...l, ...readBreakdown([
      { name: 'System prompt', tokens: 3117, kind: 'used' },
      { name: 'System tools', tokens: 34_297, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 14_798, kind: 'deferred', isDeferred: true },
      { name: 'Skills', tokens: 7645, kind: 'used' },
      { name: 'Messages', tokens: 12_000, kind: 'used' },
      { name: 'Free space', tokens: 400_000, kind: 'free' },
    ]) }
    expect(l.setup).toEqual({ total: 45_059, parts: [['System tools', 34_297], ['Skills', 7645], ['System prompt', 3117]] })
    expect(l.conversation).toBe(12_000)
  })

  test('the pane section, and short counts', () => {
    expect([k(950), k(1234), k(12_345), k(1_250_000)]).toEqual(['950', '1.2k', '12k', '1.3M'])
    expect(ledgerRows(emptyLedger(0), 100)).toEqual([])
    let l = addStep(emptyLedger(0), step(0, 30_000, 10_000))
    l = addStep(l, step(8 * MIN, 0, 41_000), { turn: 14 })
    l = { ...addToolOutput(l, { Bash: 6000, Read: 1000 }), costUsd: 1.6734, costBase: 1.25, setup: { total: 45_059, parts: [['System tools', 34_297], ['Skills', 7645], ['System prompt', 3117]] }, conversation: 12_000 }
    expect(ledgerRows(l, 200).map(r => r.text)).toEqual([
      '',
      'Tokens · this window · $0.42',
      '  81k in over 2 requests, 200 out',
      '  every request carries 45k of setup: system tools 34k, skills 7.6k, system prompt 3.1k',
      '  conversation now 12k; tool output added 7.0k (Bash 6.0k, Read 1.0k)',
      '  cache: 37% read from cache · 1 miss, 41k re-cached · 10k cached by the first request',
      '    turn 14: 41k re-cached, the cache expired after 8 minutes idle',
    ])
  })
})
