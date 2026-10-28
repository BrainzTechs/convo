// What convo knows about the session it runs in, shared by its modules.
//
// One object, so every module reads and changes the same values (an imported
// `let` cannot be assigned from outside its module). Maps and sets that are
// only ever changed in place live beside it.

import type { Row } from './turns.ts'

export const S = {
  /** The project's history folder (~/.claude/convo/<project>), its bare repo, and the project folder itself. */
  root: '',
  repo: '',
  cwd: '',
  /** Where Claude Code keeps transcripts. */
  projectsDir: '',
  /** The session the last event named. */
  sid: '',
  /** Whether history is on in this session, and why not when it is off. */
  gitOk: false,
  offWhy: '',
  /** Whether convo is on in this session at all (an automated session or an excluded folder leaves it off), and why not. */
  active: false,
  inactiveWhy: '',

  /** The spool flush in progress, if one is; how many spool files this process wrote. */
  flushRun: undefined as Promise<void> | undefined,
  seq: 0,
  /** Index files are named apart per commit, so a crash never leaves a lock behind. */
  indexSeq: 0,

  /** Rows of the main conversation since the last finished turn. */
  mainRows: [] as Row[],

  /** When the row index was last read, and how many lineage walks are using the parent map. */
  indexLoadedAt: 0,
  walking: 0,

  /** Whether this session's `session.compact` hook ran since the last native summary was recorded. */
  compactHookRan: false,
  /** When prompt.submit last ran, so turn.start does not read the whole transcript a second time. */
  submittedAt: 0,
  /** A native compaction happened with the hook held back: the next prompt carries a keyframe. */
  keyframeOwed: false,
  /** A keyframe built for the next prompt, and the session it was built for. */
  owed: undefined as { sid: string; text: string } | undefined,
  owedRun: undefined as Promise<void> | undefined,
  owedTries: 0,

  /** Keyframes and merges both rewrite records.json: they run one at a time, chained on this. */
  historyLock: Promise.resolve() as Promise<unknown>,

  /** The session's permission mode as the last prompt's hooks saw it ('' before one). */
  permissionMode: '',

  /** Goes up whenever this process moves the history (a commit, a merge, a session switch): the pane redraws on it. */
  moved: 0,

  /** When the conversation was last compacted: the requests after it re-cache, as expected. */
  compactedAt: undefined as number | undefined,
}

/** Running subagents' rows, each until its turn ends. */
export const agentRows = new Map<string, Row[]>()
/** tool_use id → subagent id. */
export const agentsByToolUse = new Map<string, string>()
/** Each turn's prompt text as turn.start saw it. */
export const startText = new Map<string, string>()
/** Subagents whose run has ended in this process: their branches merge into the turn that spawned them. */
export const finishedAgents = new Set<string>()
/** The session each subagent was spawned in: a background one may finish after /clear or /resume changed it. */
export const agentSession = new Map<string, string>()
/** The spawning turn's rows at the moment each subagent started: where its branch starts, even if it finishes later. */
export const agentBase = new Map<string, string[]>()
/** Subagents that finished after the turn that spawned them had ended (a background one), with their session: the next main turn there merges them. */
export const lateAgents = new Map<string, string>()
/** Sessions that went on from another conversation as a resume (`claude --resume`, /resume), not a fork: their first turn says "continued". */
export const resumed = new Set<string>()
/** A /resume was asked for (or a session ended for one): the next session switch is that resume. */
export const resume = { pending: false }

/** The full names the tools were registered under (mcp__<plugin>__<name>). */
export const toolNames = { recall: 'mcp__convo__recall', turn: 'mcp__convo__turn', branches: 'mcp__convo__branches', merge: 'mcp__convo__merge', pane: 'mcp__convo__pane', context: 'mcp__convo__context' }

/** Runs `fn` after every earlier history rewrite (keyframe, merge) has settled. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = S.historyLock.then(fn, fn)
  S.historyLock = run.catch(() => undefined)
  return run
}
