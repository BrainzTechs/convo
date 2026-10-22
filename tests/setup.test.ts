import { describe, expect, test } from 'claude-code/testing'
import { addUsage, commandName, emptyUsage, namesFromHistory, setupSavings } from '../hooks/setup.ts'
import { trimRows } from '../hooks/ledger.ts'
import type { Row } from '../hooks/turns.ts'

const row = (door: string, blocks: Row['blocks']): Row => ({ door, uuid: 'u', type: 'assistant', blocks })

describe('what the setup could drop', () => {
  test("a turn's rows say which tools, skills and agent types it used", () => {
    const u = addUsage(emptyUsage(0), [
      row('command', [{ type: 'text', text: '<command-name>/review</command-name>\n<command-args></command-args>' }]),
      row('response', [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'anthropic-skills:docx' } },
        { type: 'tool_use', id: 't3', name: 'Agent', input: { prompt: 'look', subagent_type: 'Explore' } },
        { type: 'tool_use', id: 't4', name: 'Agent', input: { prompt: 'do' } },
      ]),
    ], 5)
    expect(u.tools).toEqual({ Bash: 5, Skill: 5, Agent: 5 })
    expect(u.skills).toEqual({ review: 5, 'anthropic-skills:docx': 5 })
    expect(u.agents).toEqual({ Explore: 5, 'general-purpose': 5 })
  })

  test("git's turn files: tool lines and commands", () => {
    const tools = '- Bash `go test ./...` → ok, 3 lines\n- Skill `pdf` → ok, 1 lines\n- mcp__convo__recall `ledgerd` → ok\n    - not a tool line'
    expect(namesFromHistory(tools, '## Command\n/compact keep the plan\n--\n## Command\n<command-name>/review</command-name>')).toEqual({
      tools: ['Bash', 'Skill', 'mcp__convo__recall'],
      skills: ['pdf', 'compact', 'review'],
    })
    expect(commandName('  /plugin:skill-x args')).toBe('plugin:skill-x')
    expect(commandName('plain text')).toBeUndefined()
  })

  test('what was not used, less what is always kept, largest first; tools share the total by description', () => {
    const t = setupSavings({
      tools: [{ name: 'Bash', chars: 4000 }, { name: 'NotebookEdit', chars: 1000 }, { name: 'WebFetch', chars: 2000 }, { name: 'CronCreate', chars: 3000 }],
      toolTokens: 10_000,
      skills: [{ name: 'anthropic-skills:docx', tokens: 120 }, { name: 'anthropic-skills:pptx', tokens: 150 }, { name: 'review', tokens: 80 }],
      agents: [{ name: 'general-purpose', tokens: 300 }, { name: 'Explore', tokens: 400 }, { name: 'statusline-setup', tokens: 200 }],
    }, { tools: new Set(['WebFetch']), skills: new Set(['docx']), agents: new Set(['Explore']) }, { days: 30, sessions: 12, agentsCounted: true })
    expect(t.tools).toEqual([['CronCreate', 3000], ['NotebookEdit', 1000]])
    expect(t.skills).toEqual([['anthropic-skills:pptx', 150], ['review', 80]])
    expect(t.agents).toEqual([['statusline-setup', 200]])
    expect(t.tokens).toBe(4430)
    // Before a week of convo's own records, agent types are not judged
    const early = setupSavings({ tools: [], toolTokens: 0, skills: [], agents: [{ name: 'Explore', tokens: 400 }] }, { tools: new Set(), skills: new Set(), agents: new Set() }, { days: 2, sessions: 1, agentsCounted: false })
    expect(early.agents).toEqual([])
  })

  test('the pane says it in a line and the largest items; nothing when it is little', () => {
    const t = { tokens: 18_400, tools: [['CronCreate', 3000], ['NotebookEdit', 1000]] as [string, number][], skills: [['anthropic-skills:pptx', 1500]] as [string, number][], agents: [] as [string, number][], days: 12, sessions: 5, agentsCounted: false }
    expect(trimRows(t)).toEqual([
      '  setup could drop 18k: 2 tools, 1 skill unused here in the 12 days convo has seen (agents counted after a week)',
      '    largest: CronCreate 3.0k, anthropic-skills:pptx 1.5k, NotebookEdit 1.0k',
    ])
    expect(trimRows({ ...t, days: 30, agentsCounted: true })[0]).toBe('  setup could drop 18k: 2 tools, 1 skill unused here in the last 30 days')
    expect(trimRows({ ...t, tokens: 400 })).toEqual([])
  })
})
