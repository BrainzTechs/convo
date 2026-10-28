import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Verdict = { decision: 'allow' | 'ask' | 'deny'; rule?: string; reason?: string }

/** Claude Code with an empty convo repo, an engine verdict for convo's tools, and a person who answers (or nobody). */
function world(on: On, opts: { verdict: Verdict; answer?: string }, log: { asked: string[]; debug: string[] }): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess1234-0000-0000-0000-000000000000' }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/HEAD') }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__convo__${e.name}` } }))
  // The engine's own decision (rules, mode), beneath convo
  on('tool.check', { tool: ['mcp__convo__recall', 'mcp__convo__turn', 'mcp__convo__branches', 'mcp__convo__merge'] }, () => opts.verdict)
  // $.ui.ask is a call of AskUserQuestion: the person picks a label, or nobody is there (a -p run)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    log.asked.push(q)
    if (opts.answer === undefined) return { deny: 'nobody to ask' }
    return { result: { questions: [], answers: { [q]: opts.answer } } }
  })
  on('ui.log', ($, e) => {
    log.debug.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  mock.store(on)
  mock.env(on, { HOME: '/h', CONVO_FORCE: '1' })
  mock.clock(on)
}

const others = { tool: 'mcp__convo__recall', query: 'ledgerx', branch: 'all' } as const
const own = { tool: 'mcp__convo__recall', query: 'ledgerx' } as const

describe('permission for convo tools', () => {
  test("this conversation's own history needs no one's word", async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow' } }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call(own)
    expect('deny' in r && r.deny).toBeFalsy()
    expect(log.asked).toEqual([])
  })

  test('reading other conversations asks the person, and runs on their yes', async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow' }, answer: 'Allow once' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call(others)
    expect('deny' in r && r.deny).toBeFalsy()
    expect(log.asked).toEqual(["Let Claude read other conversations' history in this project?"])
    expect(log.debug.some(l => l.includes('convo: permission for mcp__convo__recall') && l.includes('the person chose "Allow once"'))).toBe(true)
    // Once only: the next call asks again
    await $.tool.call(others)
    expect(log.asked.length).toBe(2)
  })

  test('"allow this session" is remembered; a no is passed on to Claude', async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow' }, answer: 'Allow this session' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    await $.tool.call(others)
    await $.tool.call(others)
    expect(log.asked.length).toBe(1)
  })

  test('with nobody to ask it declines, and says how to allow it', async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow' } }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call(others)
    expect('deny' in r ? r.deny : '').toContain('add "mcp__convo__recall" to permissions.allow')
  })

  test('the person declining, or typing something else, refuses', async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow' }, answer: 'only the fork, please' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__convo__merge', branch: 'x' })
    expect('deny' in r ? r.deny : '').toBe('The person declined this and said: only the fork, please')
    expect(log.asked).toEqual(['Let Claude merge another line of this project into this conversation?'])
  })

  test("an allow rule the person wrote runs it silently; the engine's deny always stands", async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'allow', rule: 'mcp__convo__recall' } }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call(others)
    expect('deny' in r && r.deny).toBeFalsy()
    expect(log.asked).toEqual([])
  })

  test('a deny from the settings refuses without asking', async ($, on) => {
    const log = { asked: [] as string[], debug: [] as string[] }
    world(on, { verdict: { decision: 'deny', reason: 'denied by rule mcp__convo__merge' }, answer: 'Allow once' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__convo__merge', branch: 'x' })
    expect('deny' in r ? r.deny : '').toBe('Not allowed: denied by rule mcp__convo__merge')
    expect(log.asked).toEqual([])
  })
})
