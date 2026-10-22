// The recall eval with real Claude: the conversation is seeded into convo's
// history for a scratch project, then each question is asked in a fresh
// `claude -p` session there, with recall allowed. Claude picks its own search
// words, which is what the offline eval cannot tell. Uses tokens: about one
// short session per question.
//
//   node --experimental-strip-types --no-warnings tests/eval/recall.ts --live [--only id,id] [--model sonnet]
//
// What it costs depends on the model and on what your setup loads into every
// session (CLAUDE.md, plugins, MCP servers): from about $0.06 a question on a
// bare setup to $0.30 with Opus and a full one. --model picks the model the
// questions run on; the default is your own. Needs `claude` on the PATH, logged in. The scratch project's history folder
// (~/.claude/convo/…) and the scratch folders are removed afterwards.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { World } from '../e2e/harness.ts'
import { register } from '../../hooks/register.ts'
import { QUESTIONS, build } from './corpus.ts'

const MOD = join(import.meta.dirname ?? '.', '..', '..')

type Run = { id: string; kind: string; ok: boolean; answer: string; searches: string[]; calls: number; costUsd: number; seconds: number }

/** What a stream-json run did: its final text, the recall/turn calls it made, its cost. */
function readRun(out: string): { answer: string; searches: string[]; calls: number; costUsd: number } {
  let answer = ''
  let costUsd = 0
  const searches: string[] = []
  let calls = 0
  for (const line of out.split('\n')) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.type === 'result') {
      answer = String(d.result ?? '')
      costUsd = Number(d.total_cost_usd ?? 0)
    }
    for (const b of d.type === 'assistant' ? (d.message?.content ?? []) : []) {
      if (b.type !== 'tool_use' || !String(b.name).startsWith('mcp__convo__')) continue
      calls += 1
      const name = String(b.name).replace('mcp__convo__', '')
      searches.push(name === 'recall' ? `${JSON.stringify(b.input?.query ?? '')}${b.input?.branch ? ` (${b.input.branch})` : ''}` : `${name} ${JSON.stringify(b.input ?? {})}`)
    }
  }
  return { answer, searches, calls, costUsd }
}

export async function live(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const only = arg('--only') ? new Set((arg('--only') ?? '').split(',')) : undefined
  const model = arg('--model')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'convo-live-eval-')))
  const project = join(scratch, 'ledgerd')
  const home = homedir()
  let root: string | undefined
  try {
    // The history goes where the real convo will look for it (this home), the fake transcripts stay in scratch
    const w = new World({ home, cwd: project, configDir: join(scratch, 'claude-config'), verdict: { decision: 'allow', rule: 'mcp__convo__recall' } })
    register(w.on as never, {} as never)
    await build(w)
    root = w.root
    console.log(`seeded ${w.git('rev-list', '--count', '--all')} commits for ${project}; questions run on ${model ?? 'your default model'}\n`)
    const runs: Run[] = []
    for (const q of QUESTIONS) {
      if (only && !only.has(q.id)) continue
      const prompt = `Earlier in this project we had a long conversation building ledgerd, a Go ledger service. ${q.ask} Look it up in that history; answer in one line.`
      const t0 = Date.now()
      const r = spawnSync('claude', ['-p', ...(model ? ['--model', model] : []), '--plugin-dir', MOD, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__convo__recall', 'mcp__convo__turn', 'mcp__convo__branches', '--permission-mode', 'default', prompt], {
        cwd: project,
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
        // A child of another Claude Code session would otherwise join it
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'].includes(k))),
      })
      const got = readRun(r.stdout ?? '')
      const run: Run = { id: q.id, kind: q.kind, ok: q.answer.test(got.answer), ...got, seconds: Math.round((Date.now() - t0) / 1000) }
      runs.push(run)
      console.log(`${run.ok ? '\x1b[32mright\x1b[0m' : '\x1b[31mwrong\x1b[0m'} ${q.id.padEnd(12)} ${q.kind.padEnd(12)} ${run.calls} call${run.calls === 1 ? '' : 's'}, $${run.costUsd.toFixed(3)}, ${run.seconds}s`)
      console.log(`      searched: ${run.searches.join('; ') || '(nothing)'}`)
      console.log(`      answered: ${run.answer.replace(/\s+/g, ' ').slice(0, 220)}`)
    }
    const right = runs.filter(r => r.ok).length
    const cost = runs.reduce((t, r) => t + r.costUsd, 0)
    const calls = runs.reduce((t, r) => t + r.calls, 0)
    console.log(`\n${right} of ${runs.length} answered right; ${(calls / Math.max(1, runs.length)).toFixed(1)} history calls a question; $${cost.toFixed(2)} in all`)
    for (const kind of [...new Set(runs.map(r => r.kind))]) {
      const k = runs.filter(r => r.kind === kind)
      console.log(`  ${kind.padEnd(12)} ${k.filter(r => r.ok).length} of ${k.length}`)
    }
  } finally {
    // Only the scratch project's own history folder, found by the project path it records
    if (root && existsSync(`${root}/cwd`) && readFileSync(`${root}/cwd`, 'utf8').trim() === project) rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
    // Claude Code's own transcripts of the question sessions
    const tx = join(home, '.claude', 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
    if (existsSync(tx) && readdirSync(tx).every(f => f.endsWith('.jsonl') || f.endsWith('.json'))) rmSync(tx, { recursive: true, force: true })
  }
}
