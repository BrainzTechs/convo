import { describe, expect, test } from 'claude-code/testing'
import { agentFacts, callDetail, called, HANDBACK, modelName, priced, tierOf, weightOf, dur, endToast, finished, ordered, returned, spawned, statusLine, statusOf, stepped, stuckOf, trimmed, STUCK_MS } from '../hooks/agents.ts'
import { agentNodes, panelNodes } from '../hooks/panel.ts'
import type { ConvoAgent, ConvoView } from '../types/index.d.ts'

const T0 = 1_000_000
const base = (o: Partial<Parameters<typeof spawned>[0]> = {}): ConvoAgent => spawned({ id: 'a1', type: 'Explore', task: 'Find assembleTurn callers', background: false, turn: 14, at: T0, ...o })

describe('subagents as they run', () => {
  test('requests, tool calls and results add up; the current call is the open one', () => {
    let a = base()
    a = priced(stepped(a, { uncached: 2, read: 40_000, write: 1000, output: 300, model: 'claude-opus-5-5' }, T0 + 1000), 0.03 / ((2 + 1250 + 4000 + 1500) * 5))
    a = called(a, 'Grep', { pattern: 'assembleTurn', path: 'hooks/' }, T0 + 2000)
    expect(a.now).toEqual({ tool: 'Grep', detail: '"assembleTurn"', since: T0 + 2000 })
    a = returned(a, false, T0 + 3000)
    a = called(a, 'Read', { file_path: 'hooks/turns.ts' }, T0 + 4000)
    a = returned(a, true, T0 + 5000)
    expect(a).toMatchObject({ requests: 1, tools: 2, errors: 1, tokensIn: 41_002, read: 40_000, tokensOut: 300, weight: 33_760, model: 'claude-opus-5-5', recent: ['Grep "assembleTurn"', 'Read hooks/turns.ts'], lastAt: T0 + 5000 })
    expect(Math.abs(a.usd - 0.03) < 1e-9).toBe(true)
    expect(a.now).toBeUndefined()
    // Priced as list prices stand to each other: output 5, cache writes 1.25, reads 0.1; Opus 5, Sonnet 3, Haiku 1
    expect(weightOf({ uncached: 100, read: 1000, write: 100, output: 10 }, 'claude-haiku-5-5')).toBe(375)
    expect([tierOf('claude-opus-5-5'), tierOf('claude-sonnet-5-5'), tierOf('claude-haiku-5-5'), tierOf(undefined)]).toEqual([5, 3, 1, 3])
    expect(agentFacts(a, T0 + 130_000)).toBe('2m10s · 1 request · 2 tool calls (1 failed) · 41k in · ~$0.03')
    expect(callDetail('Bash', { command: 'go test ./...   -run X' })).toBe('"go test ./... -run X"')
    expect(callDetail('WebFetch', { url: 'https://x.dev', prompt: 'p' })).toBe('https://x.dev')
    expect(callDetail('Other', {})).toBe('')
  })

  test('a handback is its result, not a call; its answer at the end is the result', () => {
    let a = called(base(), 'Bash', { command: 'make' }, T0)
    a = returned(a, false, T0 + 1)
    a = called(a, 'SubagentHandback', { summary: 'done. The command printed\n step 1 through step 8.' }, T0 + 2)
    expect(HANDBACK.has('SubagentHandback')).toBe(true)
    expect(a).toMatchObject({ tools: 1, recent: ['Bash "make"'], result: 'done. The command printed step 1 through step 8.' })
    expect(a.now).toBeUndefined()
    expect(finished(a, 'done', T0 + 3).result).toBe('done. The command printed step 1 through step 8.')
    expect(finished(a, 'done', T0 + 3, 'Two callers: register.ts and tools.ts.').result).toBe('Two callers: register.ts and tools.ts.')
    expect(finished(base(), 'done', T0, '   ').result).toBeUndefined()
    expect(finished(base(), 'done', T0, 'x'.repeat(500)).result).toHaveLength(400)
  })

  test('the model as a person names it', () => {
    expect(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'haiku', 'claude-fable-5-1', 'gpt-x', undefined].map(modelName)).toEqual(['Opus 5.5', 'Haiku 4.5', 'Sonnet 5.5', 'Haiku', 'Fable 5.1', 'gpt-x', ''])
  })

  test('it looks stuck in one call, repeating itself, or with nothing new', () => {
    let a = called(base(), 'Bash', { command: 'sleep 999' }, T0)
    expect(stuckOf(a, T0 + 60_000)).toBeUndefined()
    expect(stuckOf(a, T0 + 6 * 60_000)).toBe('in Bash for 6m00s')
    a = base()
    for (let i = 0; i < 3; i++) a = returned(called(a, 'Grep', { pattern: 'x' }, T0 + i), false, T0 + i)
    expect(stuckOf(a, T0 + 10)).toBe('the same call 3 times in a row: Grep "x"')
    expect(stuckOf(base(), T0 + STUCK_MS + 60_000)).toBe('nothing new for 6m00s')
    expect(stuckOf(finished(base(), 'done', T0), T0 + STUCK_MS * 3)).toBeUndefined()
  })

  test('the engine says how each one stands; its end is a toast when it is worth one', () => {
    expect(['completed', 'failed', 'killed', 'idle', 'pending', 'odd'].map(statusOf)).toEqual(['done', 'failed', 'killed', 'waiting', 'running', undefined])
    const bg = { ...stepped(base({ background: true }), { uncached: 0, read: 0, write: 0, output: 0 }, T0), usd: 0.04 }
    expect(endToast(finished(bg, 'done', T0 + 40_000), T0 + 40_000)).toBe('subagent "Find assembleTurn callers" finished (1 request · ~$0.04 · 40s)')
    expect(endToast(finished(base(), 'done', T0), T0)).toBeUndefined()
    expect(endToast(finished(base(), 'failed', T0 + 1000), T0)).toMatch(/failed \(0 requests · <\$0\.01 · 1s\)$/)
    expect([dur(40_000), dur(130_000), dur(3_900_000)]).toEqual(['40s', '2m10s', '1h05m'])
  })

  test('the status line while any run; the list keeps every live one and the newest finished', () => {
    const one = { ...stepped(base(), { uncached: 0, read: 0, write: 0, output: 0 }, T0), usd: 0.09 }
    const two = called(base({ id: 'a2' }), 'Bash', { command: 'x' }, T0)
    expect(statusLine([one, two], T0 + 10 * 60_000)).toBe('2 agents running · ~$0.09 · 2 look stuck')
    expect(statusLine([finished(one, 'done', T0)], T0)).toBeUndefined()
    const done = Array.from({ length: 15 }, (_, i) => finished(base({ id: `d${i}` }), 'done', T0 + i))
    const kept = trimmed([...done, one])
    expect(kept).toHaveLength(13)
    expect(kept.some(a => a.id === 'd0')).toBe(false)
    // Live first, finished newest first, each one's own under it
    const child = base({ id: 'c1', parent: 'a1', at: T0 + 5 })
    expect(ordered([finished(base({ id: 'old' }), 'done', T0 + 9), child, one]).map(x => [x.a.id, x.depth])).toEqual([['a1', 0], ['c1', 1], ['old', 0]])
  })

  test('the Agents tab: rows, a warning, an open one with its calls and buttons', () => {
    const now = T0 + 130_000
    let a = { ...stepped(base(), { uncached: 2, read: 60_000, write: 1000, output: 200 }, T0), usd: 0.09 }
    a = called(a, 'Grep', { pattern: 'assembleTurn' }, now - 12_000)
    const done = { ...finished(base({ id: 'b2', type: 'general-purpose', task: 'Fix the transfer test', model: 'claude-haiku-4-5-20251001' }), 'done', T0 + 60_000, 'Fixed: the balance was read before the transfer committed.'), merged: 14 }
    const text = agentNodes([a, done], { tab: 'agents' }, 90, now).map(n => n.text)
    expect(text).toEqual([
      '⟳ Explore · Find assembleTurn callers',
      '│   2m10s · 1 request · 61k in · ~$0.09',
      '│   now: Grep "assembleTurn" (12s)',
      '✓ general-purpose (Haiku 4.5) · Fix the transfer test',
      '│   1m00s · 0 requests',
      '│   result: Fixed: the balance was read before the transfer committed.',
      '│   merged into turn 14',
    ])
    // Open, the result is whole, wrapped
    const long = { ...done, result: 'Fixed: the balance was read before the transfer committed, so the second read saw the old value; it now waits for the commit.' }
    const opened = agentNodes([long], { tab: 'agents', open: 'agent:b2' }, 60, now).map(n => n.text)
    expect(opened.slice(2, 5)).toEqual(['│   result: Fixed: the balance was read before the transfer', '│     committed, so the second read saw the old value; it', '│     now waits for the commit.'])
    expect(opened.every(t => t.length <= 60)).toBe(true)
    const open = agentNodes([a], { tab: 'agents', open: 'agent:a1' }, 90, now)
    expect(open.map(n => n.text).slice(3)).toEqual(['    · Grep "assembleTurn"', '  message it', '  stop it'])
    expect(open.find(n => n.text === '  stop it')).toMatchObject({ t: 'button', action: { kind: 'fill', text: 'Stop subagent a1 ("Find assembleTurn callers").' } })
    expect(agentNodes([a], { tab: 'agents' }, 90, T0 + 10 * 60_000).map(n => n.text)).toContain('│   ⚠ looks stuck: in Grep for 8m02s')
    expect(agentNodes([], { tab: 'agents' }, 90, now)[0]?.text).toMatch(/^No subagents/)
    // The tab's label counts the running ones, whichever tab is open
    const view: ConvoView = { sid: 'aaaaaaaa-1', turns: 2, questions: [], tasks: 0, lines: [], merges: [], agents: { all: 0, merged: 0 }, others: 0, at: '', history: [] }
    const tabs = panelNodes({ view, ledger: undefined, ui: { tab: 'history' }, width: 80, now, focused: false, agents: [a, done] })[1]
    expect(tabs?.t === 'row' && tabs.items.map(b => b.text)).toEqual(['[History]', 'Context', 'Lines', 'Agents (1)'])
  })
})
