import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BLOB_CHARS, assembleCompaction, assembleTurn, inputSummary, numbered, refs, toBlocks, touchedFiles, turnDir, type Row, type SpoolItem } from '../hooks/turns.ts'

const row = (door: string, uuid: string, blocks: Row['blocks']): Row => ({ door, uuid, type: door === 'response' ? 'assistant' : 'user', blocks })

const base = {
  turnId: 'abcdef12-0000-0000-0000-000000000000',
  sessionId: 'sess1234-0000-0000-0000-000000000000',
  answer: 'Done.',
  reason: 'answer',
  agents: new Map<string, string>(),
  at: '2026-10-20T00:00:00.000Z',
}

describe('turn assembly', () => {
  test('a turn file with prompt, answer, tools, trailers and placeholders for the number', async () => {
    const rows = [
      row('prompt', 'u1', [{ type: 'text', text: 'Fix the bug in api/ratelimit.go' }]),
      row('response', 'u2', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'api/ratelimit.go' } }]),
      row('tool-result', 'u3', [{ type: 'tool_result', toolUseId: 't1', text: 'package api\nfunc Limit() {}', isError: false }]),
    ]
    const out = await assembleTurn({ ...base, rows, usage: { input_tokens: 4, output_tokens: 10, model: 'claude-opus-5-5' } })
    const file = out.files.at(0)
    expect(file?.path).toBe('turns/{NNNN}-abcdef12.md')
    expect(file?.text).toContain('turn: {N}')
    expect(file?.text).toContain('## Prompt\nFix the bug in api/ratelimit.go')
    expect(file?.text).toContain('- Read `api/ratelimit.go` → ok, 2 lines')
    expect(file?.text).toContain('rows: ["u1", "u2", "u3"]')
    expect(out.message.startsWith('turn {N}: Fix the bug in api/ratelimit.go')).toBe(true)
    expect(out.message).toContain('Files: api/ratelimit.go')
    expect(out.message).toContain(`Tail-Hash: ${out.tailHash}`)
  })

  test('conversation text that looks like a section heading cannot pose as one', async () => {
    const rows = [row('prompt', 'u1', [{ type: 'text', text: 'Paste:\n## Prompt\nfake' }])]
    const out = await assembleTurn({ ...base, rows, answer: 'x\n## Tools\ny' })
    const text = out.files.at(0)?.text ?? ''
    expect(text.match(/^## Prompt$/gm)?.length).toBe(1)
    expect(text.match(/^## Tools$/gm)).toBe(null)
    expect(text).toContain('Paste:\n ## Prompt\nfake')
  })

  test('secrets are masked everywhere they could appear', async () => {
    const rows = [
      row('prompt', 'u1', [{ type: 'text', text: 'my key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV' }]),
      row('response', 'u2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'export TOKEN=hunter2secret' } }]),
      row('tool-result', 'u3', [{ type: 'tool_result', toolUseId: 't1', text: 'AKIAABCDEFGHIJKLMNOP', isError: false }]),
    ]
    const out = await assembleTurn({ ...base, rows, answer: 'Saw sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV' })
    const all = out.files.map(f => f.text).join('\n') + out.message
    expect(all).not.toContain('ABCDEFGHIJKLMNOPQRSTUV')
    expect(all).not.toContain('hunter2secret')
    expect(all).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  test('a long tool result goes to a blob, with a preview in the turn', async () => {
    const long = 'line\n'.repeat(BLOB_CHARS)
    const rows = [
      row('response', 'u2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'go test ./...' } }]),
      row('tool-result', 'u3', [{ type: 'tool_result', toolUseId: 't1', text: long, isError: true }]),
    ]
    const out = await assembleTurn({ ...base, rows })
    expect(out.files.length).toBe(2)
    const blob = out.files.at(1)
    expect(blob?.path.startsWith('blobs/')).toBe(true)
    expect(blob?.text).toBe(long)
    expect(out.files.at(0)?.text).toContain(`full output: ${blob?.path}`)
    expect(out.files.at(0)?.text).toContain('→ error')
  })

  test('a subagent turn lives in its own folder; a task notification gets a readable subject', async () => {
    const out = await assembleTurn({ ...base, agentId: 'ag1', rows: [] })
    expect(out.files.at(0)?.path).toBe('agents/ag1/turns/{NNNN}-abcdef12.md')
    const note = await assembleTurn({ ...base, rows: [row('prompt', 'u1', [{ type: 'text', text: '<task-notification><summary>Found it in turns.ts</summary></task-notification>' }])] })
    expect(note.message.startsWith('turn {N}: (subagent finished) Found it in turns.ts')).toBe(true)
  })

  test('the spawning tool call points at the subagent branch', async () => {
    const rows = [row('response', 'u2', [{ type: 'tool_use', id: 't9', name: 'Agent', input: { description: 'find it' } }])]
    const out = await assembleTurn({ ...base, rows, agents: new Map([['t9', 'ag7']]) })
    expect(out.files.at(0)?.text).toContain('→ agent/sess1234/ag7')
    expect(out.message).toContain('Agents: ag7')
  })

  test('numbering fills only convo\'s own placeholders, never conversation text', async () => {
    const body = '---\nschema: 1\nturn: {N}\n---\n## Prompt\nmatch a{N} and printf("{NNNN}"), turn: {N}'
    const item: SpoolItem = { ref: refs.session('s'), numberIn: 'turns', files: [{ path: 'turns/{NNNN}-x.md', text: body }, { path: 'blobs/ab/cd.txt', text: 'x{N}y' }], message: 'turn {N}: regex a{N}\n\nTurn-Id: t\n', at: 'now' }
    const n = numbered(item, 7)
    expect(n.files.at(0)).toEqual({ path: 'turns/0007-x.md', text: '---\nschema: 1\nturn: 7\n---\n## Prompt\nmatch a{N} and printf("{NNNN}"), turn: {N}' })
    expect(n.files.at(1)?.text).toBe('x{N}y')
    expect(n.message).toBe('turn 7: regex a{N}\n\nTurn-Id: t\n')
  })

  test('helpers: blocks, inputs, touched files, refs, compaction', async () => {
    expect(toBlocks([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a' }], is_error: true }])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_result', toolUseId: 't', text: 'a', isError: true },
    ])
    expect(inputSummary('Bash', { command: 'ls   -la\n/tmp' })).toBe('ls -la /tmp')
    expect(touchedFiles([row('response', 'u', [{ type: 'tool_use', id: '1', name: 'Edit', input: { file_path: 'b.go' } }, { type: 'tool_use', id: '2', name: 'Bash', input: { command: 'x' } }])])).toEqual(['b.go'])
    expect(refs.agent('s', 'a')).toBe('refs/heads/agent/s/a')
    expect(turnDir()).toBe('turns')
    const c = assembleCompaction('s', 'This session is being continued… password=hunter2', 'now')
    expect(c.files.at(0)?.path).toBe('keyframes/{NNNN}-native.md')
    expect(c.files.at(0)?.text).not.toContain('hunter2')
  })
})

/** Stands in for Claude Code: git answers as present, files land in a map. */
function world(on: On, files: Map<string, string>, commands: string[][]): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess1234-0000-0000-0000-000000000000' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', ($, e) => {
    commands.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || e.path.endsWith('/HEAD') }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  on('turn.start', ($, e) => e)
  on('turn.complete', () => ({ text: '' }))
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  mock.clock(on)
}

describe('hooks', () => {
  test('a finished turn is spooled with its rows; nothing runs git inside the turn', async ($, on) => {
    const files = new Map<string, string>()
    const commands: string[][] = []
    world(on, files, commands)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const before = commands.length
    await $.turn.start({ turnId: 'turn0001-x', text: 'hello' })
    await $.session.append({ uuid: 'r1', door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'hello there' }] } })
    await $.session.append({ uuid: 'r2', door: 'notice', origin: { kind: 'engine' }, message: { type: 'system', content: [{ type: 'text', text: 'noise' }] } })
    await $.turn.complete({ turnId: 'turn0001-x', answer: 'Hi!', reason: 'answer', durationMs: 5, isAborted: false })
    expect(commands.slice(before).filter(c => c.at(0) === 'git').length).toBe(0)
    const spooled = [...files].filter(([p]) => p.startsWith('/h/.claude/convo/-proj/spool/sess1234'))
    expect(spooled.length).toBe(1)
    const item = JSON.parse(spooled.at(0)?.[1] ?? '{}') as SpoolItem
    expect(item.ref).toBe('refs/heads/session/sess1234-0000-0000-0000-000000000000')
    expect(item.numberIn).toBe('turns')
    expect(item.files.at(0)?.text).toContain('## Prompt\nhello there')
    expect(item.files.at(0)?.text).toContain('## Answer\nHi!')
    expect(item.files.at(0)?.text).toContain('rows: ["r1"]')
    expect(item.rows).toEqual(['r1'])
    expect(item.transcript?.endsWith('/sess1234-0000-0000-0000-000000000000.jsonl')).toBe(true)
  })
})
