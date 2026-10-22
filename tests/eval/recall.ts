// The recall eval: how often recall puts the turn that answers a question
// at the top, over a long conversation in real git.
//
//   node --experimental-strip-types --no-warnings tests/eval/recall.ts           ranking, offline (no model, no tokens)
//   node --experimental-strip-types --no-warnings tests/eval/recall.ts --live    real Claude asks each question (uses tokens)
//   (bun tests/eval/recall.ts works too)
//
// Offline, each question's query variants go straight to the recall tool and
// the rank of the first right turn is scored: hit@1, hit@3, hit@5 (recall
// shows five by default) and mean reciprocal rank, overall and by kind.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { World } from '../e2e/harness.ts'
import { register } from '../../hooks/register.ts'
import { AGENT, FORK, MAIN, QUESTIONS, build, type Question, type Where } from './corpus.ts'

/** Each turn recall listed, in order, as a Where. */
export function ranked(result: string): Where[] {
  const out: Where[] = []
  for (const line of result.split('\n')) {
    const m = /^turn (\d+)( of subagent (\S+))?( on (\S+))?(?: \[path: [^\]]+\])? · /.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (m[3]) out.push({ turn: n, on: m[3] === AGENT ? 'agent' : undefined })
    else if (m[5]?.includes(FORK)) out.push({ turn: n, on: 'fork' })
    else if (!m[5] || m[5].includes(MAIN)) out.push({ turn: n })
  }
  return out
}

const same = (a: Where, b: Where): boolean => a.turn === b.turn && (a.on ?? 'main') === (b.on ?? 'main')

/** 1-based rank of the first right turn, or 0 when none of the first `limit` is right. */
export const rankOf = (q: Question, got: readonly Where[]): number => got.findIndex(g => q.expect.some(e => same(e, g))) + 1

type Score = { id: string; kind: string; query: string; rank: number }

function summary(scores: readonly Score[]): string {
  const n = scores.length
  const at = (k: number) => scores.filter(s => s.rank > 0 && s.rank <= k).length
  const mrr = scores.reduce((t, s) => t + (s.rank ? 1 / s.rank : 0), 0) / n
  const pct = (x: number) => `${Math.round((100 * x) / n)}%`.padStart(4)
  return `hit@1 ${pct(at(1))}  hit@3 ${pct(at(3))}  hit@5 ${pct(at(5))}  MRR ${mrr.toFixed(2)}  (${n})`
}

async function offline(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'convo-eval-'))
  try {
    const w = new World({ home: join(dir, 'home'), cwd: join(dir, 'ledgerd'), verdict: { decision: 'allow', rule: 'mcp__convo__recall' } })
    register(w.on as never, {} as never)
    const t0 = Date.now()
    await build(w)
    console.log(`built ${w.git('rev-list', '--count', `session/${MAIN}`)} commits in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
    const scores: Score[] = []
    for (const q of QUESTIONS) {
      const ranks: number[] = []
      for (const query of q.queries) {
        const r = await w.tool('recall', { query, limit: 20, ...(q.branch ? { branch: q.branch } : {}) })
        const rank = rankOf(q, ranked(r.result ?? ''))
        ranks.push(rank)
        scores.push({ id: q.id, kind: q.kind, query, rank })
      }
      const shown = q.queries.map((x, i) => `${JSON.stringify(x)} → ${ranks[i] || '–'}`).join(', ')
      console.log(`${q.id.padEnd(12)} ${q.kind.padEnd(12)} ${shown}`)
    }
    console.log(`\nall           ${summary(scores)}`)
    for (const kind of [...new Set(scores.map(s => s.kind))]) console.log(`${kind.padEnd(13)} ${summary(scores.filter(s => s.kind === kind))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv.includes('--live')) {
  const { live } = await import('./live.ts')
  await live()
} else {
  await offline()
}
