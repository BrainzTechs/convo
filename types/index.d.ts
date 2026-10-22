// convo's session state: what its pane beside the chat shows.

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
}

declare module 'claude-code' {
  interface PluginState {
    convo: { view: ConvoView }
  }
}
