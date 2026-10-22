// convo: every Claude Code conversation kept as git history.
//
// Each turn becomes one commit on `session/<id>` in a bare repo of its own at
// ~/.claude/convo/<project>/repo.git (private to the user); subagents get
// `agent/<session>/<id>` branches, forks and rewinds branch at the turn they
// came from, and compaction is answered with a keyframe built from git.
// Claude reads the history back through four tools: recall, turn, branches
// and merge; a fifth shows convo's pane beside the chat, which this file also
// draws from the view view.ts builds.
//
// A finished turn is written to a spool file and committed by a background
// timer, so turns never wait on git. The exceptions run where the engine is
// already busy: a compaction's keyframe, a merge Claude asked for, and a
// session switch's flush. A spool left behind by a session that ended early
// is committed by the next one.


import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { Io } from './io.ts'
import { messageTokens, tailStart, tokensOf, turnStarts } from './checkpoint.ts'
import { KEPT_DOORS, assembleTurn, refs, toBlocks, turnDir } from './turns.ts'
import { S, agentBase, agentRows, agentSession, agentsByToolUse, finishedAgents, startText } from './state.ts'
import { transcriptOf, transcripts } from './rows.ts'
import { ensureRepo, projectRoot } from './repo.ts'
import { adoptOrphans, enqueue, flush, heartbeat } from './spool.ts'
import { noticeCompaction, recordCompaction, rowsFor, useSession } from './session.ts'
import { permit } from './permission.ts'
import { buildCheckpoint, buildOwed } from './keyframes.ts'
import { branchList, mergeBranch, readTurn, recall, registerTools } from './tools.ts'
import { buildView, emptyView, paneRows, type PaneRow } from './view.ts'

/**
 * The engine as convo's modules use it. Claude Code follows `$` only into
 * functions of this file (2.1.296 and earlier refuse a module that hands it
 * across an import), so each call is spelled out here and the modules get
 * this in its place.
 */
function ioOf($: EngineInterface): Io {
  return {
    process: { run: (argv, init) => $.process.run(argv, init) },
    fs: {
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
      read: path => $.fs.read(path),
      stat: path => $.fs.stat(path),
      write: (path, text) => $.fs.write(path, text),
    },
    model: { complete: request => $.model.complete(request) },
    session: { messages: () => $.session.messages() },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    tool: { check: query => $.tool.check(query), register: spec => $.tool.register(spec) },
    ui: { ask: (question, options) => $.ui.ask(question, options), log: (text, options) => $.ui.log(text, options) },
  }
}

// ── The pane beside the chat ─────────────────────────────────────────
const PANE = 'convo'
const VIEW = { plugin: 'convo', key: 'view' } as const
/** What the published view was built from: the history's move count and, when checked, its refs. */
let published = { moved: -1, sid: '', refs: '' }

/**
 * Rebuilds the pane's view when the history moved: this process's commits
 * (S.moved) at once, another session's (a fork growing) when `look` reads
 * the refs. The view lives in session state; the pane redraws on its write.
 */
async function publish($: EngineInterface, look = false): Promise<void> {
  try {
    if (!S.gitOk) {
      await $.state.set(VIEW, emptyView(S.sid, S.offWhy || 'it has not started'))
      return
    }
    const io = ioOf($)
    let refsNow = published.refs
    if (look) {
      const r = await io.process.run(['git', `--git-dir=${S.repo}`, 'for-each-ref', '--format=%(objectname)', 'refs/heads/'], { timeoutMs: 10_000 })
      refsNow = r.stdout
    }
    if (published.moved === S.moved && published.sid === S.sid && published.refs === refsNow) return
    const at = { moved: S.moved, sid: S.sid }
    const view = await buildView(io, S.sid)
    await $.state.set(VIEW, view)
    published = { ...at, refs: look ? refsNow : published.refs }
  } catch (err) {
    $.ui.log(`convo: the pane's view was not rebuilt: ${String(err).slice(0, 200)}`, { to: 'debug' })
  }
}

/** How each kind of row reads. */
function toneOf(tone: PaneRow['tone']): Record<string, unknown> {
  if (tone === 'title') return { bold: true }
  if (tone === 'dim') return { dimColor: true }
  if (tone === 'warn') return { color: 'warning' }
  if (tone === 'good') return { color: 'success' }
  return {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const io = ioOf($)
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    S.cwd = e.cwd
    S.root = home ? await projectRoot(io, home, e.cwd) : ''
    S.repo = `${S.root}/repo.git`
    S.projectsDir = `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : '.')}/projects`
    await useSession(io, await $.session.id())
    const why = !home
      ? 'no home folder to keep history in'
      : (await $.env.get('OS')) === 'Windows_NT'
        ? 'Windows is not supported yet'
        : await ensureRepo(io)
    S.gitOk = why === undefined
    S.offWhy = why ?? ''
    if (!S.gitOk) {
      $.ui.status(`convo: history is off (${why})`)
    } else {
      $.clock.every(2000, () => flush(io))
      await heartbeat(io)
      $.clock.every(30_000, () => heartbeat(io))
      $.clock.after(5000, () => adoptOrphans(io))
      $.clock.every(300_000, () => adoptOrphans(io))
      await registerTools(io)
      // The pane follows the history: after each flush, and every 30 s for other sessions' moves
      $.clock.every(2000, () => publish($))
      $.clock.every(30_000, () => publish($, true))
    }
    await publish($, true)
    // Beside the chat on a wide enough screen, unless the person closed it; asking Claude brings it back
    if (e.isInteractive && (await $.store.get('pane-closed')) !== true) void $.ui.open({ id: PANE, title: 'convo' })
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set('pane-closed', true)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const got = await $.state.get(VIEW)
    const rows = paneRows(got.value, Math.max(20, e.props.bodyColumns))
    // Drawn with h() rather than JSX, so this module stays a .ts file Node can run in the tests
    return h(Box, { flexDirection: 'column' }, ...rows.map(r => h(Text, toneOf(r.tone), r.text || ' '))) as RenderElement
  })

  on('session.end', async ($, e, next) => {
    try {
      await flush(ioOf($))
    } catch {
      // What is left is committed by the next session here
    }
    return next(e)
  })

  // ── Rows: buffered per conversation until their turn ends ────────────
  on('session.append', { door: ['prompt', 'response', 'tool-result', 'command', 'delivery', 'compaction'] }, async ($, e, next) => {
    const result = await next(e)
    try {
      const blocks = toBlocks(e.message.content as { type: string; [k: string]: unknown }[])
      if (e.door === 'compaction') {
        // The summary row is the user-role one; the boundary notice carries no text worth keeping
        const summary = blocks.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
        if (e.message.type === 'user' && summary && !e.agentId) {
          await recordCompaction(ioOf($), summary)
          // Held back: start the keyframe now, so the next prompt need not wait for it
          if (S.keyframeOwed) $.clock.after(0, () => buildOwed(ioOf($)))
        }
      } else if (KEPT_DOORS.has(e.door)) {
        rowsFor(e.agentId).push({ door: e.door, uuid: e.uuid, name: e.message.name, type: e.message.type, blocks })
      }
    } catch {
      // Recording never gets in the way of the conversation
    }
    return result
  }).catch(($, e, next) => next(e))

  // ── The tools ──────────────────────────────────────────────────────────
  // They read and write convo's own repo only. A mod serves its tools in a `tool.call` hook, which answers before
  // Claude Code's own permission step is reached, so convo asks here itself: reading this branch's own history
  // needs nothing; reading other sessions' history, listing them, and merging (which writes records and calls a
  // model) wait for the person, so an instruction injected into a turn cannot quietly pull another conversation in.
  // One hook serves all four; a registered tool's arguments arrive on the event itself, beside `tool`
  on('tool.call', { tool: ['mcp__convo__recall', 'mcp__convo__turn', 'mcp__convo__branches', 'mcp__convo__merge', 'mcp__convo__pane'] }, async ($, e) => {
    // Showing the pane reads nothing beyond what the person sees: no permission, and it works with history off
    if (e.tool === 'mcp__convo__pane') {
      await $.store.set('pane-closed', false)
      await publish($, true)
      const opened = await $.ui.open({ id: PANE, title: 'convo' })
      return { result: opened.isPlaced ? "convo's pane is open beside the chat." : `convo's pane is open but not shown here: ${opened.reason}.` }
    }
    if (!S.gitOk) return { result: `convo is off in this session: ${S.offWhy}.` }
    const input = e as { readonly [k: string]: unknown }
    const gate = await permit(ioOf($), e.tool, input)
    if (gate) return { deny: gate }
    try {
      if (e.tool === 'mcp__convo__recall') return { result: await recall(ioOf($), input) }
      if (e.tool === 'mcp__convo__turn') return { result: await readTurn(ioOf($), input) }
      if (e.tool === 'mcp__convo__branches') return { result: await branchList(ioOf($)) }
      return { result: await mergeBranch(ioOf($), input) }
    } catch (err) {
      return { result: `convo could not do that: ${String(err).slice(0, 300)}` }
    }
  }).catch(() => ({ deny: 'convo could not check whether this may run, so it did not.' }))

  // ── Compaction: a keyframe in place of the native summary ─────────────
  on('session.compact', async ($, e, next) => {
    if (!S.gitOk) return next(e)
    // The session compacting now, not the one the last event named (/resume and /clear fire no session.start)
    if (!e.agentId) await useSession(ioOf($), await $.session.id())
    // A subagent's own compaction stays native; so does one a plugin started, which is not held back either
    if (e.agentId) return next(e)
    if (e.trigger === 'plugin') {
      S.compactHookRan = true
      return next(e)
    }
    // No background summary is paid for that the keyframe would discard
    if (e.trigger === 'precompute') return { skip: 'convo builds a keyframe when the conversation compacts' }
    S.compactHookRan = true
    // Each way back to native says why in the debug log (claude --debug), so a fallback is never silent
    const native = (why: string): ReturnType<typeof next> => {
      $.ui.log(`convo: compacting natively: ${why}`, { to: 'debug' })
      return next(e)
    }
    const before = e.messages.reduce((s, m) => s + messageTokens(m), 0)
    // Automatic compaction must free room, so the kept turns stay under 40% of it; a typed /compact only caps them
    const tailCap = e.trigger === 'auto' ? Math.min(40_000, Math.floor(before * 0.4)) : 40_000
    const from = tailStart(e.messages, 2, tailCap)
    // Even the last turn is too big to keep whole, or cut, or there is nothing before it: native does better
    if (from === undefined) return native(`the last turn is too big to keep whole or its tool calls are cut (${before} tokens in all)`)
    if (from === 0) return native('there is nothing before the turns kept word for word')
    const tail = e.messages.slice(from)
    const tailTokens = tail.reduce((s, m) => s + messageTokens(m), 0)
    // Turns the keyframe stands in for; one may be an earlier summary or keyframe, which git already covers
    const minTurns = Math.max(0, turnStarts(e.messages.slice(0, from)).length - 1)
    try {
      $.ui.status('convo: writing a keyframe…')
      // An automatic compaction must free room; a /compact the person typed gets the keyframe whatever the size
      const accept = (text: string): string | undefined => {
        const size = tokensOf(text) + tailTokens
        return e.trigger === 'auto' && size >= before ? `the keyframe would not shrink the conversation (${size} ≥ ${before} tokens)` : undefined
      }
      const kf = await buildCheckpoint(ioOf($), { sid: S.sid, guidance: e.instructions, trigger: e.trigger, minTurns, accept })
      if (!kf) return native('this session has no turns in git yet')
      const after = tokensOf(kf.text) + tailTokens
      S.compactHookRan = false
      $.ui.log(`convo: keyframe ${kf.n} replaced the compaction (${before} → ${after} tokens)`, { to: 'debug' })
      return { messages: [{ role: 'user', text: kf.text, toolUses: [] }, ...tail], tokensBefore: before, tokensAfter: after }
    } catch (err) {
      // Fallback 1: native compaction runs, and its summary is recorded as a native keyframe
      $.ui.log(`convo: keyframe failed, compacting natively: ${String(err).slice(0, 200)}`, { to: 'debug' })
      return next(e)
    } finally {
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => next(e))

  // Fallback 2: where the guard holds the compaction hook back, the first
  // prompt after a native compaction carries the keyframe as context
  on('prompt.submit', async ($, e, next) => {
    if (!S.gitOk) return next(e)
    let extra: string | undefined
    try {
      await useSession(ioOf($), await $.session.id())
      if (e.command) return next(e)
      S.submittedAt = Date.now()
      await noticeCompaction(ioOf($))
      // Noticed only now (no compaction row reached the mod): build it here, with a short bound
      if (S.keyframeOwed && !S.owedRun && !S.owed && S.owedTries < 2) {
        $.ui.status('convo: writing a keyframe…')
        await buildOwed(ioOf($), 30_000)
      }
      if (S.owed?.sid === S.sid) {
        extra = S.owed.text
        S.owed = undefined
      }
    } catch (err) {
      $.ui.log(`convo: no keyframe for this prompt: ${String(err).slice(0, 200)}`, { to: 'debug' })
    } finally {
      $.ui.status(undefined)
    }
    return next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
  }).catch(($, e, next) => next(e))

  // The classic events name each session's transcript file exactly
  on('classic.SessionStart', async ($, e, next) => {
    transcripts.set(e.session_id, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    transcripts.set(e.session_id, e.transcript_path)
    if (e.permission_mode) S.permissionMode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      agentsByToolUse.set(e.tool_use_id, r.agentId)
      agentSession.set(r.agentId, S.sid)
      // The main turn's rows so far (a nested subagent's spawner is not named here, so it starts from the same point)
      agentBase.set(r.agentId, S.mainRows.map(x => x.uuid))
    }
    return r
  })

  // ── Turns ────────────────────────────────────────────────────────────
  on('turn.start', async ($, e, next) => {
    // A changed session id means /clear, /branch, a fork or a rewind: a new branch
    await useSession(ioOf($), await $.session.id())
    startText.set(e.turnId, e.text)
    try {
      // prompt.submit already looked for this turn; a delivered turn (a notification) had none
      if (Date.now() - S.submittedAt > 10_000) await noticeCompaction(ioOf($))
    } catch {
      // Recording never gets in the way of the conversation
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      const agentId = e.agentId
      const rows = agentId ? (agentRows.get(agentId) ?? []) : S.mainRows
      if (agentId) agentRows.delete(agentId)
      else S.mainRows = []
      // A subagent's turn belongs to the session that spawned it, whatever the session is now
      const owner = agentId ? (agentSession.get(agentId) ?? S.sid) : S.sid
      const ref = agentId ? refs.agent(owner, agentId) : refs.session(S.sid)
      const at = new Date().toISOString()
      const usage = e.usage as Record<string, unknown> | undefined
      const out = await assembleTurn({
        turnId: e.turnId,
        sessionId: owner,
        agentId,
        startText: startText.get(e.turnId),
        rows,
        answer: e.answer ?? '',
        reason: e.reason,
        durationMs: e.durationMs,
        usage: usage as never,
        agents: agentsByToolUse,
        at,
      })
      startText.delete(e.turnId)
      // Main-thread turns carry their rows so the committer can tell a fork or rewind from a plain next turn
      if (agentId) finishedAgents.add(agentId)
      // Subagents this turn spawned that have finished: merged into the turn's commit (background ones still running are not)
      const spawned = rows.flatMap(r => r.blocks.flatMap(b => (b.type === 'tool_use' ? [agentsByToolUse.get(b.id)] : []))).filter((a): a is string => !!a && finishedAgents.has(a))
      // A subagent's branch starts where the turn that spawned it continues from (its rows so far say where)
      const baseRows = agentId ? (agentBase.get(agentId) ?? []) : []
      const lineage = agentId
        ? baseRows.length ? { baseRows, transcript: transcriptOf(owner) } : {}
        : { rows: rows.map(r => r.uuid), transcript: transcriptOf(S.sid), ...(spawned.length ? { merge: spawned.map(a => refs.agent(S.sid, a)) } : {}) }
      await enqueue(ioOf($), { ref, base: agentId ? refs.session(owner) : undefined, numberIn: turnDir(agentId), files: out.files, message: out.message, at, ...lineage })
      // A subagent whose spawning turn has already ended (a background one) is never merged: forget it now
      if (agentId && !S.mainRows.some(r => r.blocks.some(b => b.type === 'tool_use' && agentsByToolUse.get(b.id) === agentId))) {
        finishedAgents.delete(agentId)
        agentSession.delete(agentId)
        agentBase.delete(agentId)
        for (const [k, v] of agentsByToolUse) if (v === agentId) agentsByToolUse.delete(k)
      }
      // Used once: a finished subagent's ids are not needed after the turn that merges it
      if (!agentId) {
        for (const a of spawned) {
          finishedAgents.delete(a)
          agentSession.delete(a)
          agentBase.delete(a)
        }
        for (const r of rows) for (const b of r.blocks) if (b.type === 'tool_use' && agentsByToolUse.has(b.id) && spawned.includes(agentsByToolUse.get(b.id) ?? '')) agentsByToolUse.delete(b.id)
      }
    } catch (err) {
      $.ui.log(`convo: turn not recorded: ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    return result
  })
}
