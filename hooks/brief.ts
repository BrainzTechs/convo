// The brief a new conversation starts with: where this project's last
// conversation left off, from the records convo keeps of it (pins, live
// decisions, open tasks, where the work stood). Rendered from stored records,
// no model call; capped, the pins kept first. After claude-mem, which hands a
// new session what earlier ones learned.

import type { Records } from './checkpoint.ts'
import { tokensOf } from './checkpoint.ts'
import { toolNames } from './state.ts'

/** The brief's cap, in estimated tokens. */
export const BRIEF_TOKENS = 1200
/** Only a conversation this recent is briefed from. */
export const BRIEF_DAYS = 14
/** What opens every brief, so convo can tell its own. */
export const BRIEF_OPENING = '# Where this project left off'

export type BriefSource = { sid: string; at: number; records: Records; lastTurn: number }

/** The brief, or undefined when the records hold nothing worth carrying over. */
export function renderBrief(s: BriefSource): { text: string; counts: { pins: number; decisions: number; tasks: number } } | undefined {
  const live = s.records.records.filter(r => !r.supersededBy)
  const pins = live.filter(r => r.kind === 'pin')
  const decisions = live.filter(r => r.kind === 'decision').sort((a, b) => b.turn - a.turn)
  const tasks = live.filter(r => r.kind === 'task' && !r.done).sort((a, b) => b.turn - a.turn)
  if (!pins.length && !decisions.length && !tasks.length && !s.records.state) return undefined
  const day = new Date(s.at).toISOString().slice(0, 10)
  const after = s.lastTurn - s.records.throughTurn
  const later = after > 1 ? ` Its last ${after} turns are not in these notes yet.` : after === 1 ? ' Its last turn is not in these notes yet.' : ''
  const head = [
    `${BRIEF_OPENING} · conversation ${s.sid.slice(0, 8)}, ${day}, turns 1–${s.lastTurn}`,
    `Notes convo kept from the last conversation in this project, for continuity: they are not the person's new request.${later} Every turn is kept word for word: ${toolNames.recall} with branch "${s.sid.slice(0, 8)}" finds them (it asks the person first).`,
  ]
  const sections = (nDecisions: number, nTasks: number): string[] => [
    ...(s.records.state ? ['', '## Where it stood', s.records.state] : []),
    ...(pins.length ? ['', '## Pins (the person asked for these to be kept in mind)', ...pins.map(p => `- ${p.text}${p.quote ? ` — they said "${p.quote}"` : ''}`)] : []),
    ...(decisions.length && nDecisions ? ['', '## Decisions', ...decisions.slice(0, nDecisions).map(d => `- ${d.text} (turn ${d.turn})`)] : []),
    ...(tasks.length && nTasks ? ['', '## Open tasks', ...tasks.slice(0, nTasks).map(t => `- ${t.text} (turn ${t.turn})`)] : []),
  ]
  // The newest decisions and tasks first; fewer of each until it fits, pins always whole
  let nd = Math.min(decisions.length, 10)
  let nt = Math.min(tasks.length, 10)
  let text = [...head, ...sections(nd, nt)].join('\n')
  while (tokensOf(text) > BRIEF_TOKENS && (nd > 1 || nt > 1)) {
    if (nd >= nt && nd > 1) nd -= 1
    else nt -= 1
    text = [...head, ...sections(nd, nt)].join('\n')
  }
  return { text, counts: { pins: pins.length, decisions: Math.min(nd, decisions.length), tasks: Math.min(nt, tasks.length) } }
}
