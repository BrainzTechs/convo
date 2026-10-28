import { describe, expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.ts'
import { resume, S } from '../hooks/state.ts'

type Hook = (...a: unknown[]) => unknown
type Seen = { event: string; matcher?: unknown; hook: Hook }

/** An `on` that only records what is registered. */
function recorder(): { on: never; seen: Seen[] } {
  const seen: Seen[] = []
  const on = (event: string, a: unknown, b?: unknown): { catch(): void } => {
    seen.push(b === undefined ? { event, hook: a as Hook } : { event, matcher: a, hook: b as Hook })
    return { catch() {} }
  }
  return { on: on as never, seen }
}

// Rich enough that a hook which does not pass it straight back would read something off it
const SENTINEL = { sentinel: true, text: 'ok', agentId: 'ag1', usage: { input_tokens: 1, output_tokens: 1 } }
const isGenerator = (f: Hook): boolean => f.constructor.name === 'AsyncGeneratorFunction'

describe('the off switch', () => {
  test('while off, every hook but session.start and the classic two passes straight through', async () => {
    const { on, seen } = recorder()
    register(on, {})
    // History would otherwise be off and cover for a missing gate in many hooks
    S.gitOk = true
    S.active = false
    expect(seen.length).toBeGreaterThanOrEqual(15)
    const strict = new Proxy({}, { get: (_t, k) => { throw new Error(`touched $.${String(k)}`) } })
    // An event nobody may look into: a gated hook hands it on unread
    const sealed = new Proxy({}, { get: (_t, k) => { if (typeof k === 'symbol') return undefined; throw new Error(`read e.${k}`) } })
    const left: string[] = []
    for (const { event, hook } of seen) {
      if (event === 'session.start') continue
      if (event === 'classic.SessionStart' || event === 'classic.UserPromptSubmit') {
        left.push(event)
        continue
      }
      let got: unknown
      if (isGenerator(hook)) {
        const next = async function* () { return SENTINEL }
        const it = (hook as (...a: unknown[]) => AsyncGenerator<unknown, unknown>)(strict, sealed, next)
        let r = await it.next()
        while (!r.done) r = await it.next()
        got = r.value
      } else {
        got = await hook(strict, sealed, () => SENTINEL)
      }
      expect(got, event).toBe(SENTINEL)
    }
    expect(resume.pending).toBe(false)
    expect(left).toEqual(['classic.SessionStart', 'classic.UserPromptSubmit'])
    expect(seen.filter(s => s.event === 'session.start').length).toBe(1)
  })

  test('session.start in a non-interactive session leaves convo off and does nothing else', async () => {
    const { on, seen } = recorder()
    register(on, {})
    S.active = true
    const start = seen.find(s => s.event === 'session.start')!.hook
    const logs: string[] = []
    const $ = {
      env: { get: async (k: string) => (k === 'HOME' ? '/h' : undefined) },
      ui: { log: (t: string) => void logs.push(t) },
    }
    const got = await start($, { cwd: '/proj', isInteractive: false }, () => SENTINEL)
    expect(got).toBe(SENTINEL)
    expect(S.active).toBe(false)
    expect(logs.join('\n')).toContain('convo: off in this session: not interactive')
  })

  /** A `$` that allows only reading the environment and the debug log: anything else is a failure. */
  const strictStart = (env: Record<string, string>, logs: string[]) =>
    new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === 'env') return { get: async (name: string) => env[name] }
          if (k === 'ui') {
            return new Proxy({}, {
              get: (_u, m) => {
                if (m === 'log') return (t: string) => void logs.push(t)
                throw new Error(`touched $.ui.${String(m)}`)
              },
            })
          }
          if (typeof k === 'symbol' || k === 'then') return undefined
          throw new Error(`touched $.${String(k)}`)
        },
      },
    )

  test('an interactive session in an excluded folder stays off and touches nothing', async () => {
    const { on, seen } = recorder()
    register(on, { excludeFolders: '~/x' })
    S.active = true
    const start = seen.find(s => s.event === 'session.start')!.hook
    const logs: string[] = []
    const got = await start(strictStart({ HOME: '/h' }, logs), { cwd: '/h/x/proj', isInteractive: true, surface: 'terminal' }, () => SENTINEL)
    expect(got).toBe(SENTINEL)
    expect(S.active).toBe(false)
    expect(logs.join('\n')).toContain('convo: off in this session: excluded folder /h/x')
  })

  test('CONVO_FORCE=1 does not turn convo on in an excluded folder', async () => {
    const { on, seen } = recorder()
    register(on, { excludeFolders: '~/x' })
    S.active = true
    const start = seen.find(s => s.event === 'session.start')!.hook
    const logs: string[] = []
    const got = await start(strictStart({ HOME: '/h', CONVO_FORCE: '1' }, logs), { cwd: '/h/x/proj', isInteractive: false, surface: null }, () => SENTINEL)
    expect(got).toBe(SENTINEL)
    expect(S.active).toBe(false)
    expect(logs.join('\n')).toContain('excluded folder /h/x')
  })
})
