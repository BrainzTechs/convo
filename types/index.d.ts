// convo's session state: what its pane beside the chat shows, and the token ledger.

/** One other line of this conversation, as the pane lists it. */
export type ConvoLine = {
  /** fork: a session that split from this one (or this one from it); rewound: turns a rewind left; other: another conversation in the project. */
  kind: 'fork' | 'rewound'
  /** The branch, as recall and merge take it (`session/<id>`, `rewound/<id>/<commit>`). */
  name: string
  /** Its own turns since it split from this line. */
  own: number
  /** The turn of this line it split after; 0 when it shares none. */
  splitAfter: number
  /**
   * split: it went its own way after splitAfter; merged: this line has merged
   * it; parent: this conversation was forked from it and it has not moved
   * since; ahead: it continues past this line's last turn.
   */
  relation: 'split' | 'merged' | 'parent' | 'ahead'
  /** The first turn of its own, as its subject reads. */
  first?: string
  /** When it last moved, as git says it ("2 hours ago"). */
  when: string
}

/** A merge on this line. */
export type ConvoMerge = { from: string; afterTurn: number; conflicts: number; /** Where the two lines split, as the merge recorded it. */ base?: string }

/** What the pane shows, rebuilt from git whenever this project's history moves. */
/** One entry of the pane's History: a turn, a keyframe or summary, or a merge of another line. */
export type ConvoEntry = {
  kind: 'turn' | 'keyframe' | 'native' | 'merge'
  /** The commit, short. */
  id: string
  /** The turn's number, or the keyframe's. */
  n?: number
  /** When it was committed (ISO). */
  at: string
  title: string
  /** A turn's tools ("Edit×2 Bash"), tokens (in, out), cost, what was condensed in it and cleared before it. */
  tools?: string
  tokens?: { in: number; out: number }
  usd?: number
  condensed?: string
  clearedBefore?: string
  /** The conversation the brief it began with came from. */
  brief?: string
  /** Subagents merged in this turn: their id and the task they were given. */
  agents?: { id: string; title: string }[]
  /** "branched from …" or "rewound to …", where the line turned. */
  mark?: string
  /** The turn file, for its detail. */
  path?: string
}

/** An open turn's detail in the pane: what was asked, the answer, its tools, the files it touched. */
export type ConvoDetail = { asked: string; answer: string; tools: string[]; files: string[] }

/** The pane's own state: the tab, and the turn (or `agent:<id>`) open in it, with a turn's detail. */
export type ConvoUi = { tab: 'history' | 'context' | 'lines' | 'agents' | 'live'; open?: string; detail?: ConvoDetail }

/** Another chat running inside this chat's folder, as the Live tab shows it. `name` is its folder from this one's; `unknown` is a chat with no beat yet (an older convo). */
export type ConvoLivePeer = { sid: string; name: string; state: 'working' | 'idle' | 'unknown'; since: number; prompt?: string; subjects: string[] }

/** The Live tab: the other live chats here, working ones first, how many work now, the chats convo does not record, and when this was read. */
export type ConvoLive = { peers: ConvoLivePeer[]; unseen: number; working: number; at: number }

/** A subagent of this session, as the Agents tab shows it: live while it runs, kept a while after. */
export type ConvoAgent = {
  id: string
  /** Its agent type (Explore, general-purpose, a plugin's) and the task it was given, in the Agent call's words. */
  type: string
  task: string
  /** The agent that spawned it; absent when the conversation did. */
  parent?: string
  background: boolean
  model?: string
  /** The conversation's turn it was spawned in, and the one its work merged into. */
  turn?: number
  merged?: number
  started: number
  ended?: number
  /** Its last request, tool call or result: what "nothing new for" counts from. */
  lastAt: number
  status: 'running' | 'waiting' | 'done' | 'failed' | 'killed'
  requests: number
  tools: number
  errors: number
  tokensIn: number
  tokensOut: number
  read: number
  /** Its requests' price in list-price units (agents.ts weightOf), and that in dollars at the rate the session's requests have cost. */
  weight: number
  usd: number
  /** The tool call it is in now. */
  now?: { tool: string; detail: string; since: number }
  /** Its last few tool calls, newest last, and how many times in a row the last one repeats. */
  recent: string[]
  repeat: number
  /** What it handed back: its answer, in one paragraph. */
  result?: string
  /** It was named in a "looks stuck" toast already. */
  warned?: boolean
}

export type ConvoView = {
  /** Why history is off in this session, when it is. */
  off?: string
  sid: string
  /** Turns on this conversation's line. */
  turns: number
  /** What Claude's context starts from: the newest compaction on this line, or none (it sees every turn). */
  context?: { kind: 'keyframe' | 'native'; n: number; afterTurn: number; turnsSince: number }
  /** Decide: questions merges raised that are still open, and other open tasks. */
  questions: string[]
  tasks: number
  lines: ConvoLine[]
  merges: ConvoMerge[]
  /** Subagents this conversation ran, and how many of them are merged into it. */
  agents: { all: number; merged: number }
  /** Other conversations in this project that share no history with this one. */
  others: number
  /** When it was built. */
  at: string
  /** A session resumed or forked under a new id, before its first turn of its own: the session whose turns it goes on from (`tip` is that line's). */
  continues?: string
  /** A session resumed under a new id: the session it went on from, whose line reads as continued rather than forked. */
  resumedFrom?: string
  /** The line's tip, and its newest commits for the History tab. */
  tip?: string
  history?: ConvoEntry[]
}

/** A prompt-cache miss: a request that re-cached what the last one had cached. */
export type ConvoMiss = {
  at: number
  /** 'main', or the subagent's id. */
  loop: string
  /** The turn of this conversation it happened in, when known. */
  turn?: number
  /** Tokens written to the cache again. */
  tokens: number
  /** The likely cause, in words. */
  why: string
}

/** Where this window's tokens went, request by request, as the model's usage reported them. */
/** What every request's setup could drop: what this project has not used lately, largest first, in tokens. */
export type ConvoTrim = {
  tokens: number
  tools: [string, number][]
  skills: [string, number][]
  agents: [string, number][]
  /** Built-in tools convo held back behind ToolSearch, with what they would take in front. */
  held: [string, number][]
  heldTokens: number
  /** The days of use it is judged on (up to 30), and how many sessions' records. */
  days: number
  sessions: number
  /** Whether agent types were judged: only once convo's own records span a week. */
  agentsCounted: boolean
}

export type ConvoLedger = {
  /** When counting began (this window, or the reload that started it). */
  since: number
  requests: number
  /** Input tokens: not cached, read from the cache, written to the cache; and output tokens. */
  uncached: number
  read: number
  write: number
  output: number
  misses: ConvoMiss[]
  missTokens?: number
  /** Re-caches that followed a compaction: expected, so counted but not listed. */
  expected: number
  agents: { runs: number; tokens: number; models: string[] }
  /** Tool output finished turns added to the context, by tool, in estimated tokens. */
  toolOutput: Record<string, number>
  /** What every request carries before the conversation (tools, skills, system prompt), from /context's breakdown. */
  setup?: { total: number; parts: [string, number][] }
  /** The conversation's own tokens, from the same breakdown. */
  conversation?: number
  /** The session's cost as the status line has it now, and what it was when this window started counting. */
  costUsd?: number
  costBase?: number
  /** Tokens the window's first request cached: a new window, or a resumed session, starts with a cold cache. */
  warmup?: number
  /** Each loop's last request: when, on which model, and its whole input. */
  last: Record<string, { at: number; model: string; input: number; output?: number }>
  /** Old tool output convo cleared from the context: how often, how many outputs, and their tokens. */
  cleared?: { times: number; outputs: number; tokens: number }
  /** The project's last seven days, as the pane words them. */
  history?: string
  /** The brief this conversation began with: the conversation it came from, what it carried, its tokens. */
  brief?: { from: string; pins: number; decisions: number; tasks: number; tokens: number }
  /** Tool output condensed as it arrived: how many outputs, and their estimated tokens before and after. */
  condensed?: { outputs: number; before: number; after: number }
  /** What the setup holds back, and what it could also drop. */
  trim?: ConvoTrim
  /** Where the conversation compacts: convo's setting, and Claude Code's own limit. */
  compactAt?: number
  autoCompactAt?: number
  /** The prompt cache's lifetime and where it came from, and the dollars a list-price unit has cost (agents.ts weightOf), for the warm or cold line. */
  cache?: { ttl: '5m' | '1h'; from: 'setting' | 'seen' | 'plan'; rate: number }
}

declare module 'claude-code' {
  interface PluginState {
    /** held: the built-in tools convo held back behind ToolSearch in this process, by name, with their descriptions' length. */
    /** agents: this session's subagents, live and recently finished. */
    /** live: the other chats running inside this folder, for the Live tab. */
    convo: { view: ConvoView; ledger: ConvoLedger; ui: ConvoUi; held: Record<string, number>; agents: ConvoAgent[]; live: ConvoLive }
  }
}
