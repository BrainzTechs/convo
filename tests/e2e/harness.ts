// A stand-in for Claude Code that runs convo's hooks against real git and a
// real folder, so the git plumbing is tested as it runs: refs, trees, merges,
// rewinds, the spool and its recovery. The model is scripted, the transcript
// is written the way Claude Code writes it (rows chained by parentUuid), and
// nothing else of Claude Code is imitated beyond what convo calls.
//
// Runs under Node 22+ (type stripping) or Bun; needs git on the PATH. Not a
// `*.test.ts` file: `claude plugin test` runs those inside the engine, where no
// real process or file can be reached.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** What a process returns to a hook: the engine cuts output at 4 MiB. */
const CAP = 4 * 1024 * 1024

type Hook = { event: string; matcher?: Record<string, string | string[]>; fn: (...a: any[]) => any; fallback?: (...a: any[]) => any }
type Block = { type: string; [k: string]: unknown }
export type Message = { role: 'user' | 'assistant'; text: string; toolUses: any[]; toolResults?: { tool_use_id: string; text: string; isError: boolean }[]; handle?: string }

export type WorldOptions = {
  home: string
  cwd: string
  /** The model's answer to each call convo makes (extraction, merge). */
  model?: (o: { system: string; prompt: string }) => string
  /** Claude Code's own permission verdict for convo's tools. */
  verdict?: { decision: 'allow' | 'ask' | 'deny'; rule?: string; reason?: string }
  /** The person's answer when convo asks; undefined: nobody is there. */
  answer?: string
  /** Where transcripts go (Claude Code's config folder); default <home>/.claude. Lets a run seed history in a real home without touching its transcripts. */
  configDir?: string
  /** The setup Claude Code lists: built-in tools (described at the start of a session), skills and agent types with their tokens. */
  setup?: { tools: { name: string; description: string }[]; skills: { name: string; tokens: number }[]; agents: { agentType: string; tokens: number }[] }
}

export class World {
  hooks: Hook[] = []
  sid = ''
  messages: Message[] = []
  store = new Map<string, unknown>()
  /** Session state ($.state), keyed plugin/key. */
  state = new Map<string, unknown>()
  /** Panes convo asked to open. */
  opened: string[] = []
  every: (() => unknown)[] = []
  after: { ms: number; f: () => unknown; cancelled: boolean }[] = []
  /** Compactions convo started itself ($.session.compact), with what came back. */
  pluginCompactions: any[] = []
  /** What convo answered when Claude Code described each tool, by name. */
  described = new Map<string, { description: string; isDeferred?: boolean }>()
  /** Settings convo changed ($.config.set). */
  configSets: { key: string; value: unknown }[] = []
  logs: string[] = []
  asked: string[] = []
  modelCalls: { system: string; prompt: string }[] = []
  /** The last row of the main thread in each session's transcript. */
  private tails = new Map<string, string | null>()

  readonly o: WorldOptions

  constructor(o: WorldOptions) {
    this.o = o
    mkdirSync(o.home, { recursive: true })
    mkdirSync(o.cwd, { recursive: true })
  }

  /** The context the model was last sent, in tokens, by loop: what the next request reads from the cache. */
  private cached = new Map<string, number>()
  /** Usage the next request reports in place of the usual, once (to stage a cache miss). */
  nextUsage?: { read?: number; write?: number; model?: string }

  /** The `on` a hooks module's register() takes. */
  on = (event: string, a: any, b?: any) => {
    const hook: Hook = typeof a === 'function' ? { event, fn: a } : { event, matcher: a, fn: b }
    this.hooks.push(hook)
    return { catch: (f: Hook['fallback']) => (hook.fallback = f) }
  }

  get configDir(): string {
    return this.o.configDir ?? `${this.o.home}/.claude`
  }
  get transcriptDir(): string {
    return `${this.configDir}/projects/${this.o.cwd.replace(/[^A-Za-z0-9]/g, '-')}`
  }
  transcript(sid = this.sid): string {
    return `${this.transcriptDir}/${sid}.jsonl`
  }
  /** This project's history folder: the one whose cwd file names the project. */
  get root(): string {
    const base = `${this.o.home}/.claude/convo`
    const dir = readdirSync(base).find(d => existsSync(`${base}/${d}/cwd`) && readFileSync(`${base}/${d}/cwd`, 'utf8').trim() === this.o.cwd)
    if (!dir) throw new Error(`no history folder for ${this.o.cwd}`)
    return `${base}/${dir}`
  }
  get repo(): string {
    return `${this.root}/repo.git`
  }

  /** Raises an event through convo's hooks; `core` is what Claude Code itself would answer. */
  async fire(event: string, e: any, core: (e: any) => any = () => ({})): Promise<any> {
    const chain = this.hooks.filter(h => h.event === event && matches(h.matcher, e))
    const call = async (i: number, ev: any): Promise<any> => {
      const h = chain[i]
      if (!h) return core(ev)
      let called = false
      const next = Object.assign((x: any) => {
        called = true
        return call(i + 1, x)
      }, { get called() { return called } })
      try {
        return await h.fn(this.$, ev, next)
      } catch (err) {
        if (h.fallback) return h.fallback(this.$, ev, next)
        throw err
      }
    }
    return call(0, e)
  }

  /** Raises a streaming event (turn.step): each hook is an async generator over the one beneath. */
  async fireStream(event: string, e: any, core: (e: any) => any): Promise<any> {
    const chain = this.hooks.filter(h => h.event === event && matches(h.matcher, e))
    const call = (i: number, ev: any): AsyncGenerator<unknown, any> => {
      const h = chain[i]
      if (!h) return (async function* () { return core(ev) })()
      return h.fn(this.$, ev, (x: any) => call(i + 1, x))
    }
    const gen = call(0, e)
    for (;;) {
      const r = await gen.next()
      if (r.done) return r.value
    }
  }

  /** One model request, as Claude Code reports it: the cached context read back, the new part written. */
  private async request(turnId: string, index: number, newTokens: number, agentId?: string): Promise<void> {
    const loop = agentId ?? 'main'
    const before = this.cached.get(loop) ?? 0
    const staged = this.nextUsage
    this.nextUsage = undefined
    const read = staged?.read ?? before
    const write = staged?.write ?? (before ? newTokens : 10_000 + newTokens)
    const model = staged?.model ?? (agentId ? 'haiku' : 'opus')
    this.cached.set(loop, read + write)
    await this.fireStream('turn.step', { turnId, index, model, messageCount: index + 1, ...(agentId ? { agentId } : {}) }, () => ({ turnId, index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: write, model } }))
  }

  /** The engine interface, as much of it as convo calls. */
  $: any = {
    process: {
      run: async (argv: string[], init: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {}) => {
        const r = spawnSync(argv[0] ?? '', argv.slice(1), { input: init.stdin, env: { ...process.env, ...init.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: init.timeoutMs })
        const out = r.stdout ?? ''
        return { exitCode: r.status ?? 1, stdout: out.length > CAP ? out.slice(0, CAP) : out, stderr: r.stderr ?? '', isStdoutTruncated: out.length > CAP, isStderrTruncated: false }
      },
    },
    fs: {
      exists: async (p: string) => existsSync(p),
      read: async (p: string) => readFileSync(p, 'utf8'),
      write: async (p: string, text: string) => {
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, text)
      },
      list: async (p: string) => readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
      stat: async (p: string) => {
        const s = statSync(p)
        return { size: s.size, mtimeMs: s.mtimeMs }
      },
    },
    env: { get: async (k: string) => (k === 'HOME' ? this.o.home : k === 'CLAUDE_CONFIG_DIR' ? this.configDir : undefined) },
    clock: {
      every: (_ms: number, f: () => unknown) => void this.every.push(f),
      after: (ms: number, f: () => unknown) => {
        const t = { ms, f, cancelled: false }
        this.after.push(t)
        return { cancel: () => void (t.cancelled = true) }
      },
    },
    session: {
      id: async () => this.sid,
      messages: async () => this.messages,
      compact: (o: { instructions?: string }) => this.pluginCompact(o.instructions),
      usage: async () => ({
        startedAt: 0,
        context: { tokens: this.cached.get('main') ?? 0, window: 1_000_000, breakdown: { categories: [
          { name: 'System prompt', tokens: 3000, kind: 'used' },
          // As Claude Code's breakdown does: no system tools once any built-in tool is held back
          ...([...this.described.values()].some(d => d.isDeferred) ? [] : [{ name: 'System tools', tokens: 7000, kind: 'used' }]),
          { name: 'Messages', tokens: Math.max(0, (this.cached.get('main') ?? 0) - 10_000), kind: 'used' },
        ], ...(this.o.setup ? {
          skills: { totalSkills: this.o.setup.skills.length, includedSkills: this.o.setup.skills.length, tokens: this.o.setup.skills.reduce((s, x) => s + x.tokens, 0), skillFrontmatter: this.o.setup.skills.map(x => ({ ...x, source: 'plugin' })) },
          agents: this.o.setup.agents.map(a => ({ ...a, source: 'built-in' })),
        } : {}) } },
        rateLimits: [],
        cost: { usd: 0.01 * (this.cached.get('main') ?? 0) / 1000 },
      }),
    },
    config: {
      list: async () => ['compactAt', 'clearOldOutput', 'holdBackTools', 'keepTools'].map(f => ({ key: `convo.${f}`, label: f, kind: 'text', value: '', provider: { plugin: 'convo', tier: 'user' }, isLocked: false })),
      set: async (a: { key: string; value: unknown }) => {
        this.configSets.push(a)
        return { value: a.value }
      },
    },
    store: {
      get: async (k: string) => this.store.get(k),
      set: async (k: string, v: unknown) => void this.store.set(k, v),
    },
    state: {
      get: async (ref: { plugin: string; key: string }) => ({ value: this.state.get(`${ref.plugin}/${ref.key}`), version: 0 }),
      set: async (ref: { plugin: string; key: string }, value: unknown) => {
        this.state.set(`${ref.plugin}/${ref.key}`, value)
        return { isWritten: true, version: 1 }
      },
    },
    model: {
      complete: async (o: { system: string; prompt: string }) => {
        this.modelCalls.push(o)
        const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        if (!this.o.model) return { isAnswered: false, reason: 'empty-reply', usage }
        return { isAnswered: true, text: this.o.model(o), usage }
      },
    },
    tool: {
      register: async (spec: { name: string }) => ({ tool: `mcp__convo__${spec.name}` }),
      check: async () => this.o.verdict ?? { decision: 'allow' },
    },
    ui: {
      log: (text: string) => void this.logs.push(text),
      status: () => undefined,
      // No surface here: a pane opens undrawn, as in a -p run
      open: async (pane: { id: string }) => {
        this.opened.push(pane.id)
        return { isPlaced: false, reason: 'no-surface' }
      },
      ask: async (q: string) => {
        this.asked.push(q)
        if (this.o.answer === undefined) throw new Error('nobody to ask')
        return this.o.answer
      },
    },
  }

  // ── What Claude Code does ─────────────────────────────────────────────

  async start(sid: string, isInteractive = false): Promise<void> {
    this.sid = sid
    mkdirSync(this.transcriptDir, { recursive: true })
    await this.fire('session.start', { cwd: this.o.cwd, surface: null, isInteractive }, () => ({}))
    // Claude Code describes each tool once, as it first lists them
    for (const t of this.o.setup?.tools ?? []) this.described.set(t.name, await this.fire('tool.describe', { tool: t.name, description: t.description, provider: { plugin: 'engine', tier: 'core' } }, e => ({ description: e.description })))
  }

  /** The view convo published for its pane. */
  view(): any {
    return this.state.get('convo/view')
  }

  /** The token ledger convo keeps for its pane. */
  ledger(): any {
    return this.state.get('convo/ledger')
  }

  /** Writes a transcript row the way Claude Code does, chained to the session's last row (or to `parent`). */
  private row(type: 'user' | 'assistant', content: Block[], parent?: string | null): string {
    const uuid = randomUUID()
    const parentUuid = parent === undefined ? (this.tails.get(this.sid) ?? null) : parent
    appendFileSync(this.transcript(), `${JSON.stringify({ type, uuid, parentUuid, isSidechain: false, sessionId: this.sid, message: { role: type, content } })}\n`)
    this.tails.set(this.sid, uuid)
    return uuid
  }

  /** The id of a session's last transcript row (where a rewind or fork points back to). */
  tail(sid = this.sid): string | null {
    return this.tails.get(sid) ?? null
  }

  /**
   * One turn: the prompt, any tool calls (each a response and its result),
   * the answer. `parent` continues from an earlier row instead of the last
   * (a rewind). `agents` runs subagents inside it.
   */
  async turn(prompt: string, answer: string, o: { parent?: string | null; tools?: { name: string; input: unknown; output: string }[]; agents?: { id: string; prompt: string; answer: string }[] } = {}): Promise<void> {
    const turnId = randomUUID()
    await this.fire('prompt.submit', { text: prompt }, e => e)
    await this.fire('turn.start', { turnId, text: prompt }, () => ({}))
    const append = async (door: string, type: 'user' | 'assistant', content: Block[], parent?: string | null, agentId?: string) => {
      const uuid = agentId ? randomUUID() : this.row(type, content, parent)
      await this.fire('session.append', { door, uuid, agentId, message: { type, content } }, () => ({}))
    }
    await append('prompt', 'user', [{ type: 'text', text: prompt }], o.parent)
    this.messages.push({ role: 'user', text: prompt, toolUses: [] })
    let index = 0
    let fresh = Math.ceil(prompt.length / 3.5)
    for (const t of o.tools ?? []) {
      const id = `toolu_${randomUUID().slice(0, 8)}`
      await this.request(turnId, index++, fresh)
      fresh = Math.ceil(t.output.length / 3.5) + 20
      await append('response', 'assistant', [{ type: 'tool_use', id, name: t.name, input: t.input }])
      this.messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: t.name, input: t.input }] })
      await append('tool-result', 'user', [{ type: 'tool_result', tool_use_id: id, content: t.output }])
      this.messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: t.output, isError: false }] })
    }
    for (const a of o.agents ?? []) {
      const id = `toolu_${randomUUID().slice(0, 8)}`
      await append('response', 'assistant', [{ type: 'tool_use', id, name: 'Agent', input: { prompt: a.prompt } }])
      await this.fire('agent.spawn', { tool_use_id: id, subagentType: 'general-purpose', prompt: a.prompt }, () => ({ agentId: a.id }))
      await this.request(turnId, index++, fresh)
      fresh = Math.ceil(a.answer.length / 3.5) + 20
      const at = randomUUID()
      await this.fire('turn.start', { turnId: at, text: a.prompt, agentId: a.id }, () => ({}))
      await this.request(at, 0, Math.ceil(a.prompt.length / 3.5), a.id)
      await append('prompt', 'user', [{ type: 'text', text: a.prompt }], undefined, a.id)
      await append('response', 'assistant', [{ type: 'text', text: a.answer }], undefined, a.id)
      await this.fire('turn.complete', { turnId: at, agentId: a.id, answer: a.answer, reason: 'answer', durationMs: 5 }, () => ({}))
      await append('tool-result', 'user', [{ type: 'tool_result', tool_use_id: id, content: a.answer }])
    }
    await this.request(turnId, index++, fresh)
    await append('response', 'assistant', [{ type: 'text', text: answer }])
    this.messages.push({ role: 'assistant', text: answer, toolUses: [] })
    await this.fire('turn.complete', { turnId, answer, reason: 'answer', durationMs: 10 }, () => ({}))
  }

  /** A fork: a new session whose transcript copies this one's rows, ids kept (--fork-session, /branch). */
  async fork(newSid: string): Promise<void> {
    const rows = readFileSync(this.transcript(), 'utf8')
    const from = this.sid
    this.sid = newSid
    writeFileSync(this.transcript(newSid), rows)
    this.tails.set(newSid, this.tails.get(from) ?? null)
  }

  /** Switches the session events name (a resume, or going back to another conversation). */
  async resume(sid: string): Promise<void> {
    this.sid = sid
    // /resume fires no session.start: convo learns of the switch from the next prompt (here the command itself)
    await this.fire('prompt.submit', { text: '/resume', command: 'resume' }, e => e)
  }

  /** A compaction: convo answers with a keyframe and the last turns, or hands back to native. */
  async compact(trigger: 'manual' | 'auto', instructions?: string): Promise<any> {
    const native = { messages: [{ role: 'user', text: 'This session is being continued from a previous conversation. Native summary.', toolUses: [] }] }
    const r = await this.fire('session.compact', { trigger, instructions, messages: this.messages.map((m, i) => ({ ...m, handle: `h${i}` })) }, () => native)
    // Claude Code starts a new chain after a compaction: the summary (here the keyframe) as a root row, which
    // reaches hooks through the compaction door; the conversation is now the summary and the kept turns
    const text = r.messages?.[0]?.text ?? ''
    const uuid = this.row('user', [{ type: 'text', text }], null)
    await this.fire('session.append', { door: 'compaction', uuid, message: { type: 'user', content: [{ type: 'text', text }] } }, () => ({}))
    this.messages = (r.messages ?? []).map((m: Message) => ({ role: m.role, text: m.text, toolUses: m.toolUses ?? [], ...(m.toolResults ? { toolResults: m.toolResults } : {}) }))
    // The next request sends the smaller conversation, cached afresh
    this.cached.set('main', 0)
    this.nextUsage = { read: 0, write: 8000 }
    return r
  }

  /**
   * A compaction a plugin started: the hooks answer, or native does. As in
   * Claude Code, the conversation goes back into the transcript as new rows
   * after a boundary (each reaching hooks through the compaction door), and a
   * message kept by its handle is the one the engine had. The next request
   * reads only the setup from the cache and writes the conversation again,
   * as Claude Code's requests do after a live clearing.
   */
  async pluginCompact(instructions?: string): Promise<any> {
    const old = this.messages.map((m, i) => ({ ...m, handle: `h${i}` }))
    const native = { messages: [{ role: 'user', text: 'This session is being continued from a previous conversation. Native summary.', toolUses: [] }] }
    const r = await this.fire('session.compact', { trigger: 'plugin', instructions, messages: old }, () => native)
    this.pluginCompactions.push(r)
    if (r.skip !== undefined) return r
    const back: Message[] = r.messages.map((m: Message) => (m.handle ? { ...old[Number(m.handle.slice(1))]! } : m))
    let parent: string | null = this.row('user', [{ type: 'text', text: 'Conversation compacted' }], null)
    for (const m of back) {
      const content = m.toolResults?.length ? m.toolResults.map(t => ({ type: 'tool_result', tool_use_id: t.tool_use_id, content: t.text })) : m.toolUses.length ? m.toolUses.map(u => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input })) : [{ type: 'text', text: m.text }]
      parent = this.row(m.role, content, parent)
      await this.fire('session.append', { door: 'compaction', uuid: parent, message: { type: m.role, content } }, () => ({}))
    }
    const size = (ms: readonly Message[]): number => ms.reduce((n, m) => n + Math.ceil((m.text.length + JSON.stringify(m.toolUses).length + (m.toolResults ?? []).reduce((t, x) => t + x.text.length, 0)) / 3.5), 0)
    this.messages = back.map(({ handle: _h, ...m }) => m)
    this.nextUsage = { read: 10_000, write: size(back) }
    return r
  }

  /** Calls one of convo's tools as Claude would. */
  async tool(name: 'recall' | 'turn' | 'branches' | 'merge' | 'pane' | 'context', args: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
    return this.fire('tool.call', { tool: `mcp__convo__${name}`, tool_use_id: randomUUID(), ...args }, () => ({ deny: 'no hook answered' }))
  }

  /** Runs convo's timers once: the spool flush, the heartbeat, orphan adoption. */
  async timers(): Promise<void> {
    const due = this.after.filter(t => !t.cancelled)
    this.after = []
    for (const f of [...due.map(t => t.f), ...this.every]) await f()
  }

  async end(): Promise<void> {
    await this.fire('session.end', {}, () => ({}))
  }

  /** git against the history repo, for checks. */
  git(...args: string[]): string {
    const r = spawnSync('git', [`--git-dir=${this.repo}`, ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  tryGit(...args: string[]): string | undefined {
    const r = spawnSync('git', [`--git-dir=${this.repo}`, ...args], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : undefined
  }
}

function matches(m: Hook['matcher'], e: any): boolean {
  if (!m) return true
  return Object.entries(m).every(([k, v]) => (Array.isArray(v) ? v.includes(e[k]) : v === e[k]))
}
