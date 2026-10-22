import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { CLEARED, applyClearing, briefInput, planClearing, shouldClear, stubFor } from '../hooks/clearing.ts'

const big = (n: number, ch = 'x'): string => ch.repeat(n)

/** A conversation of turns, each a prompt, optional tool calls with their outputs, and an answer; every message has a handle. */
function convo(turns: { prompt: string; tools?: { tool: string; input: Record<string, unknown>; output: string }[] }[]): SessionMessage[] {
  const out: SessionMessage[] = []
  let id = 0
  for (const t of turns) {
    out.push({ role: 'user', text: t.prompt, toolUses: [] })
    for (const c of t.tools ?? []) {
      const tool_use_id = `toolu_${(id += 1)}`
      out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id, tool: c.tool, input: c.input }] })
      out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id, text: c.output, isError: false }] })
    }
    out.push({ role: 'assistant', text: `answer to ${t.prompt}`, toolUses: [] })
  }
  return out.map((m, i) => ({ ...m, handle: `h${i}` }))
}

const six = convo([
  { prompt: 'run the tests', tools: [{ tool: 'Bash', input: { command: 'npm test' }, output: big(14_000) }] },
  { prompt: 'read the config', tools: [{ tool: 'Read', input: { file_path: '/p/config.ts' }, output: big(700) }, { tool: 'Agent', input: { prompt: 'look around' }, output: big(9000) }] },
  { prompt: 'grep for it', tools: [{ tool: 'Grep', input: { pattern: 'TODO' }, output: big(35_000) }] },
  { prompt: 'fix it', tools: [{ tool: 'Bash', input: { command: 'npm test' }, output: big(20_000) }] },
  { prompt: 'and again', tools: [{ tool: 'Bash', input: { command: 'npm test' }, output: big(20_000) }] },
  { prompt: 'done?' },
])

describe('clearing old tool output', () => {
  test('clears long outputs before the last three turns, and names the turn each came from', () => {
    const plan = planClearing(six, { lastTurn: 12 })
    // Turns 7 and 9 (of 7–12): the Bash and the Grep; the short Read and the subagent's answer stay
    expect([...plan.stubs.values()]).toEqual([
      `${CLEARED} this output to save context: Bash npm test, 4.0k tokens. It is kept word for word: mcp__convo__turn with n 7 reads it back.]`,
      `${CLEARED} this output to save context: Grep TODO, 10.0k tokens. It is kept word for word: mcp__convo__turn with n 9 reads it back.]`,
    ])
    expect(plan.first).toBe(2)
    expect(plan.tokens).toBeGreaterThan(13_500)
    expect(plan.tokens).toBeLessThan(14_000)
  })

  test('the stubbed conversation keeps every unchanged message as the engine has it', () => {
    const plan = planClearing(six, { lastTurn: 12 })
    const after = applyClearing(six, plan)
    expect(after.length).toBe(six.length)
    const changed = after.flatMap((m, i) => (m === six[i] ? [] : [i]))
    expect(changed).toEqual([2, 12])
    expect(after[2]?.handle).toBeUndefined()
    expect(after[2]?.toolResults?.[0]?.text.startsWith(CLEARED)).toBe(true)
    // Cleared once: a second plan over the result finds nothing more
    expect(planClearing(after, { lastTurn: 12 }).stubs.size).toBe(0)
  })

  test('nothing to clear in a short conversation; without a turn number the stub points to recall', () => {
    expect(planClearing(six.slice(0, 12)).stubs.size).toBe(0)
    const plan = planClearing(six)
    expect([...plan.stubs.values()][0]).toMatch(/mcp__convo__recall finds it/)
  })

  test('only a lot at once, and only for a short re-cache', () => {
    // About 14k is not enough to pay for re-caching what follows it
    expect(shouldClear(planClearing(six, { lastTurn: 12 }))).toBe(false)
    const heavy = convo([
      { prompt: 'a', tools: [{ tool: 'Bash', input: { command: 'cat big.log' }, output: big(150_000) }] },
      { prompt: 'b' }, { prompt: 'c' }, { prompt: 'd' },
    ])
    expect(shouldClear(planClearing(heavy))).toBe(true)
    // The same output followed by a long stretch that would all be cached again
    const late = convo([
      { prompt: 'a', tools: [{ tool: 'Bash', input: { command: 'cat big.log' }, output: big(150_000) }] },
      { prompt: 'b', tools: [{ tool: 'Agent', input: { prompt: 'x' }, output: big(400_000) }] }, { prompt: 'c' }, { prompt: 'd' },
    ])
    expect(shouldClear(planClearing(late))).toBe(false)
    expect(shouldClear(planClearing([]))).toBe(false)
  })

  test('a call in a few words', () => {
    expect(briefInput('Bash', { command: 'git   log\n --oneline' })).toBe('Bash git log --oneline')
    expect(briefInput('WebFetch', { url: 'https://example.com', prompt: 'p' })).toBe('WebFetch https://example.com')
    expect(briefInput('Mystery', {})).toBe('Mystery')
    expect(briefInput('Bash', { command: big(100, 'a') })).toBe(`Bash ${'a'.repeat(77)}…`)
    expect(stubFor('Read /x', 500, undefined)).toMatch(/Read \/x, 500 tokens/)
  })
})
