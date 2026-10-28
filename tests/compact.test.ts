import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const SID = 'sess1234-0000-0000-0000-000000000000'
const TURN = ['---', 'schema: 1', 'turn: 1', 'turnId: t', 'files: ["/proj/limit.go"]', '---', '## Prompt\nUse per-customer keys. And never add Redis, please.\n\n## Answer\nDone.'].join('\n')
const ANSWER = '{"state":"Limiter written.","add":[{"kind":"decision","text":"Per-customer keys","turn":1},{"kind":"pin","text":"Never add Redis","turn":1}],"done":[]}'

/** Claude Code with a git that already holds one turn, and a model that answers records (or fails). */
function world(on: On, opts: { model: 'ok' | 'fails' }, log: { commits: string[]; refs: string[][]; prompts: string[] }): void {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', ($, e) => {
    const a = e.argv.filter(x => !x.startsWith('--git-dir='))
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] !== 'git') return out('')
    const [cmd, ...rest] = a.slice(1)
    if (cmd === 'rev-parse') return out('tip0000000000000000000000000000000000000')
    if (cmd === 'show') return rest[0]?.endsWith(':turns/0001-t.md') ? out(TURN) : out('', 128)
    if (cmd === 'cat-file' && rest[0] === '--batch') {
      // One reply per requested <tree>:<path>, as git prints them: "<sha> blob <bytes>\n<content>\n" or "<spec> missing"
      const specs = (e.init?.stdin ?? '').split('\n').filter(Boolean)
      return out(specs.map(x => (x.endsWith(':turns/0001-t.md') ? `abc blob ${new TextEncoder().encode(TURN).length}\n${TURN}\n` : `${x} missing\n`)).join(''))
    }
    if (cmd === 'ls-tree') return rest.at(-1) === 'turns/' ? out('turns/0001-t.md') : out('')
    if (cmd === 'hash-object') return out('blob')
    if (cmd === 'write-tree') return out('tree')
    if (cmd === 'commit-tree') {
      log.commits.push(e.init?.stdin ?? '')
      return out('kfcommit0000000000000000000000000000000000')
    }
    if (cmd === 'update-ref') log.refs.push(rest)
    return out('')
  })
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('/HEAD') }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('model.complete', ($, e) => {
    log.prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: opts.model === 'ok' ? { isAnswered: true as const, text: ANSWER, usage } : { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
  })
  // The engine's own compaction, for when the mod falls back to it
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'This session is being continued from a previous conversation… native', toolUses: [] }] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.store(on)
  mock.env(on, { HOME: '/h', CONVO_FORCE: '1' })
  mock.clock(on)
}

const msg = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle })
const transcript = [msg('user', 'one', 'h1'), msg('assistant', 'a long first answer '.repeat(2000), 'h2'), msg('user', 'two', 'h3'), msg('assistant', 'a2', 'h4'), msg('user', 'three', 'h5'), msg('assistant', 'a3', 'h6')]

describe('compaction', () => {
  test('a keyframe replaces the summary: committed, tagged, then the last two turns by handle', async ($, on) => {
    const log = { commits: [] as string[], refs: [] as string[][], prompts: [] as string[] }
    world(on, { model: 'ok' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.session.compact({ trigger: 'manual', instructions: 'the keys', messages: transcript })
    const messages = r.messages ?? []
    expect(messages.at(0)?.text.startsWith('# Keyframe 1 · session sess1234 · turns 1–1')).toBe(true)
    expect(messages.at(0)?.text).toContain('- D1 Per-customer keys (turn 1)')
    expect(messages.at(0)?.text).toContain('- P1 Never add Redis (pinned turn 1)')
    expect(messages.at(0)?.text).toContain('## Files touched\nlimit.go')
    expect(messages.slice(1).map(m => m.handle)).toEqual(['h3', 'h4', 'h5', 'h6'])
    expect(log.prompts.at(0)).toContain('keep or stress: the keys')
    expect(log.commits.at(0)?.startsWith('keyframe 1: turns 1–1')).toBe(true)
    expect(log.commits.at(0)).toContain('Trigger: manual')
    expect(log.refs).toContainEqual(['refs/tags/kf/sess1234-0000-0000-0000-000000000000/1', 'kfcommit0000000000000000000000000000000000'])
  })

  test('a conversation with turns git never saw (installed mid-session) compacts natively', async ($, on) => {
    const log = { commits: [] as string[], refs: [] as string[][], prompts: [] as string[] }
    world(on, { model: 'ok' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const long = [
      msg('user', 'early one', 'e1'), msg('assistant', 'answer '.repeat(3000), 'e2'),
      msg('user', 'early two', 'e3'), msg('assistant', 'answer', 'e4'),
      msg('user', 'early three', 'e5'), msg('assistant', 'answer', 'e6'),
      ...transcript.slice(2),
    ]
    const r = await $.session.compact({ trigger: 'auto', messages: long })
    expect(r.messages?.at(0)?.text).toContain('native')
    expect(log.commits.length).toBe(0)
  })

  test('a short conversation gets the keyframe on a /compact the person typed, but stays native when automatic', async ($, on) => {
    const log = { commits: [] as string[], refs: [] as string[][], prompts: [] as string[] }
    world(on, { model: 'ok' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const tiny = [msg('user', 'one', 't1'), msg('assistant', 'a1', 't2'), msg('user', 'two', 't3'), msg('assistant', 'a2', 't4'), msg('user', 'three', 't5'), msg('assistant', 'a3', 't6')]
    const manual = await $.session.compact({ trigger: 'manual', messages: tiny })
    expect(manual.messages?.at(0)?.text.startsWith('# Keyframe 1')).toBe(true)
    const commitsAfterManual = log.commits.length
    const auto = await $.session.compact({ trigger: 'auto', messages: tiny })
    expect(auto.messages?.at(0)?.text).toContain('native')
    // Nothing was committed for the compaction that went native
    expect(log.commits.length).toBe(commitsAfterManual)
  })

  test('when records cannot be made it falls back to native compaction', async ($, on) => {
    const log = { commits: [] as string[], refs: [] as string[][], prompts: [] as string[] }
    world(on, { model: 'fails' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    const r = await $.session.compact({ trigger: 'auto', messages: transcript })
    expect(r.messages?.at(0)?.text).toContain('native')
    expect(log.commits.length).toBe(0)
  })

  test('precompute is skipped, and a subagent compacts natively', async ($, on) => {
    const log = { commits: [] as string[], refs: [] as string[][], prompts: [] as string[] }
    world(on, { model: 'ok' }, log)
    await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
    expect((await $.session.compact({ trigger: 'precompute', messages: transcript })).skip).toBeTruthy()
    expect((await $.session.compact({ trigger: 'auto', agentId: 'ag1', messages: transcript })).messages?.at(0)?.text).toContain('native')
    expect(log.prompts.length).toBe(0)
  })
})
