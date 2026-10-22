// The tools Claude reads the history with: recall, turn, branches and merge; and one that shows convo's pane.

import type { Io } from './io.ts'
import { mask } from './redact.ts'
import { MERGE_SYSTEM, conflictQuestion, conflictTasks, formatBranches, formatRecall, labelOf, mergeNote, mergePrompt, parseGrep, parseMergeAnswer, pickBranch, promptLineOf, queryTerms, rankFiles, candidates, type BranchInfo, type BranchRef } from './history.ts'
import { chunkTurns, mergeRecords, onlyBackedPins, parseRecords, recordsJson, renderKeyframe, turnNumberOf } from './checkpoint.ts'
import { refs } from './turns.ts'
import { S, exclusive, toolNames } from './state.ts'
import { addedFiles, git, readTurns, revOf } from './git.ts'
import { commitMerge } from './commit.ts'
import { flushAll } from './spool.ts'
import { freshRecords, recallLine, relative } from './keyframes.ts'

/** Every conversation line in this project, most recently active first. */
export async function listBranches(io: Io): Promise<BranchRef[]> {
  const r = await git(io, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(objectname)%09%(committerdate:relative)%09%(subject)', 'refs/heads/session/', 'refs/heads/rewound/'])
  if (!r.ok || !r.out) return []
  return r.out.split('\n').flatMap(l => {
    const [ref, tip, when, subject] = l.split('\t')
    return ref && tip ? [{ ref, name: ref.replace(/^refs\/heads\//, ''), tip, when: when ?? '', subject: subject ?? '' }] : []
  })
}

/** How many turns a tree holds. */
export async function turnCount(io: Io, tree: string): Promise<number> {
  const ls = await git(io, ['ls-tree', '--name-only', tree, 'turns/'])
  return ls.ok && ls.out ? ls.out.split('\n').length : 0
}

/** The recall tool: full-text search over turns on this branch, a named one, or all of them. */
export async function recall(io: Io, input: { query?: unknown; limit?: unknown; branch?: unknown }): Promise<string> {
  const query = typeof input.query === 'string' ? input.query : ''
  const terms = queryTerms(query)
  if (!terms.length) return 'Give recall some words to search for.'
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(Math.trunc(input.limit), 20) : 5
  await flushAll(io)
  const all = await listBranches(io)
  const want = typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim() : 'this'
  let scope: BranchRef[]
  if (want === 'all') scope = all
  else {
    const p = pickBranch(all, want, refs.session(S.sid))
    if (!p.branch) return want === 'this' || want === 'current' ? `recall: ${p.why}. branch "all" searches every conversation in this project.` : `recall: ${p.why}. The branches tool lists them.`
    scope = [p.branch]
  }
  if (!scope.length) return 'Nothing is recorded in this project yet.'
  const grep = (perFile: string[]) => git(io, ['grep', '-n', '-i', '-F', ...perFile, ...terms.flatMap(t => ['-e', t]), ...scope.map(b => b.tip), '--', 'turns/', 'merged/', 'agents/'])
  // At most 20 matching lines a turn; git before 2.38 has no -m for grep and says so, so it searches without it
  let g = await grep(['-m', '20'])
  if (!g.ok && g.err) g = await grep([])
  const hits = parseGrep(g.out, true)
  // Where in each turn the hits are (prompt, answer, tool output): the section headings of the files worth scoring
  const pool = candidates(hits, terms)
  const paths = [...new Set(pool.map(c => c.path))]
  const refs_ = [...new Set(pool.map(c => c.ref ?? ''))].filter(Boolean)
  const heads = paths.length ? await git(io, ['grep', '-n', '-e', '^## ', ...refs_, '--', ...paths]) : undefined
  const keep = new Set(pool.map(c => `${c.ref ?? ''}:${c.path}`))
  const ranked = rankFiles(hits.filter(h => keep.has(`${h.ref ?? ''}:${h.path}`)), terms, heads?.ok ? parseGrep(heads.out, true) : undefined)
  const byTip = new Map(scope.map(b => [b.tip, b.name]))
  const top = []
  for (const f of ranked.slice(0, limit)) {
    const shown = await git(io, ['show', `${f.ref}:${f.path}`])
    top.push({ ...f, prompt: shown.ok ? promptLineOf(shown.out) : '', branch: scope.length > 1 ? byTip.get(f.ref ?? '') : undefined })
  }
  const label = want === 'all' ? 'every branch in this project' : scope[0]?.ref === refs.session(S.sid) ? 'this branch' : (scope[0]?.name ?? want)
  const unmatched = terms.filter(t => !hits.some(h => h.text.toLowerCase().includes(t)))
  const answer = formatRecall(query, label, top, ranked.length, unmatched)
  return g.cut ? `${answer}\n\n(The search matched more than one call can return; some turns may be missing. Narrower words find them.)` : answer
}

/** The most of a turn one call returns; `offset` reads on. */
export const TURN_PAGE = 30_000

/** The turn tool: one turn file in full, the tool output it stored as blobs inlined up to 8 KB each. */
export async function readTurn(io: Io, input: { n?: unknown; branch?: unknown; path?: unknown; offset?: unknown }): Promise<string> {
  await flushAll(io)
  const all = await listBranches(io)
  const p = typeof input.branch === 'string' && input.branch.trim() ? pickBranch(all, input.branch, refs.session(S.sid)) : { branch: all.find(b => b.ref === refs.session(S.sid)) }
  if (!p.branch) return `turn: ${p.why ?? 'this session has no turns recorded yet'}.`
  const tip = p.branch.tip
  let path = typeof input.path === 'string' && /^[\w./-]+\.md$/.test(input.path) ? input.path : undefined
  if (!path) {
    const n = typeof input.n === 'number' ? Math.trunc(input.n) : Number(input.n)
    if (!Number.isInteger(n) || n < 1) return 'turn: give the turn number (n), as recall or the keyframe shows it.'
    const ls = await git(io, ['ls-tree', '--name-only', tip, 'turns/'])
    path = (ls.ok ? ls.out.split('\n') : []).find(x => x.startsWith(`turns/${String(n).padStart(4, '0')}-`))
    if (!path) return `turn: ${p.branch.name} has no turn ${n}.`
  }
  const shown = await git(io, ['show', `${tip}:${path}`])
  if (!shown.ok) return `turn: ${path} is not on ${p.branch.name}.`
  let text = shown.out
  let room = 40_000
  for (const m of shown.out.matchAll(/full output: (blobs\/[0-9a-f]{2}\/[0-9a-f]+\.txt)/g)) {
    if (room <= 0 || !m[1]) break
    const blob = await git(io, ['show', `${tip}:${m[1]}`])
    if (!blob.ok) continue
    const body = blob.out.length > 8000 ? `${blob.out.slice(0, 8000)}\n… [${blob.out.length} chars in all]` : blob.out
    text += `\n\n--- ${m[1]} ---\n${body}`
    room -= body.length
  }
  const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.trunc(input.offset) : 0
  const page = text.slice(offset, offset + TURN_PAGE)
  const more = offset + TURN_PAGE < text.length ? `\n\n… [${text.length - offset - TURN_PAGE} more chars: call turn again with offset ${offset + TURN_PAGE}]` : ''
  return mask(page + more)
}

/** The branches tool: each other line and how it relates to this one. */
export async function branchList(io: Io): Promise<string> {
  await flushAll(io)
  const all = await listBranches(io)
  const mine = refs.session(S.sid)
  const oursTip = all.find(b => b.ref === mine)?.tip
  const infos: BranchInfo[] = await Promise.all(all.filter(x => x.ref !== mine).slice(0, 20).map(async (b): Promise<BranchInfo> => {
    const base = oursTip ? await git(io, ['merge-base', oursTip, b.tip]) : { ok: false, out: '', err: '' }
    const baseTip = base.ok && base.out ? base.out : undefined
    const own = baseTip ? await git(io, ['log', '--reverse', '--first-parent', '--format=%s', `${baseTip}..${b.tip}`]) : undefined
    return {
      name: b.name,
      turns: await turnCount(io, b.tip),
      shared: baseTip ? await turnCount(io, baseTip) : undefined,
      isContained: baseTip === b.tip,
      isAhead: baseTip !== undefined && baseTip === oursTip,
      lastSubject: b.subject,
      when: b.when,
      firstOwn: own?.out.split('\n').find(x => x.startsWith('turn ')),
    }
  }))
  return formatBranches(mine.replace(/^refs\/heads\//, ''), infos)
}

/**
 * The merge tool: the other branch's turns since the two split are read for
 * what they settled (one model call per prompt-sized run), its records join
 * this branch's (contradictions become questions), and a merge commit with
 * both tips as parents holds the new records, a keyframe, the note and the
 * other branch's turns under merged/.
 */
export function mergeBranch(io: Io, input: { branch?: unknown; focus?: unknown }): Promise<string> {
  return exclusive(() => mergeBranchNow(io, input))
}

export async function mergeBranchNow(io: Io, input: { branch?: unknown; focus?: unknown }): Promise<string> {
  const ref = refs.session(S.sid)
  await flushAll(io)
  const spool = `${S.root}/spool/${S.sid}`
  if ((await io.fs.exists(spool)) && (await io.fs.list(spool)).some(f => f.name.endsWith('.json'))) return 'merge: earlier turns are still being saved; ask again in a moment.'
  const all = await listBranches(io)
  if (typeof input.branch !== 'string' || !input.branch.trim()) return `${await branchList(io)}\n\nSay which one to merge.`
  const p = pickBranch(all, input.branch, ref)
  if (!p.branch) return `merge: ${p.why}.`
  const theirs = p.branch
  if (theirs.ref === ref) return 'merge: that is this branch.'
  const oursTip = await revOf(io, ref)
  if (!oursTip) return 'merge: this session has no turns recorded yet, so there is nothing to merge into.'
  const baseR = await git(io, ['merge-base', oursTip, theirs.tip])
  const base = baseR.ok && baseR.out ? baseR.out : undefined
  if (base === theirs.tip) return `merge: ${theirs.name} is already part of this branch.`
  const focus = typeof input.focus === 'string' ? input.focus : undefined
  // Their turns and stored outputs since the split, by path
  const lsTree = async (tree: string | undefined, dir: string): Promise<Map<string, string>> => {
    const m = new Map<string, string>()
    if (!tree) return m
    const r = await git(io, ['ls-tree', '-r', tree, dir])
    for (const l of r.ok ? r.out.split('\n') : []) {
      const t = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(l)
      if (t?.[1] && t[2]) m.set(t[2], t[1])
    }
    return m
  }
  const baseTurns = await lsTree(base, 'turns/')
  const theirTurns = [...(await lsTree(theirs.tip, 'turns/'))].filter(([path]) => !baseTurns.has(path)).sort(([a], [b]) => a.localeCompare(b))
  if (!theirTurns.length) return `merge: ${theirs.name} has no turns of its own since it split from this branch.`
  // This branch's own turns since the split, so what the person said here weighs against the other branch's findings
  const mine = await readTurns(io, oursTip, [...(await lsTree(oursTip, 'turns/')).keys()].filter(x => !baseTurns.has(x)).sort())
  const docs = await readTurns(io, theirs.tip, theirTurns.map(([path]) => path))
  const short = labelOf(theirs.name)
  // What the other branch already recorded since the split: read beside its turns, so findings it took in from
  // its own merges (seen in its turns only as tool previews) still count
  const baseStored = base ? await git(io, ['show', `${base}:records.json`]) : undefined
  const baseTexts = new Set(parseRecords(baseStored?.ok ? baseStored.out : undefined).records.map(r => r.text.toLowerCase()))
  const theirStored = await git(io, ['show', `${theirs.tip}:records.json`])
  const theirRecords = parseRecords(theirStored.ok ? theirStored.out : undefined).records.filter(r => !r.supersededBy && !baseTexts.has(r.text.toLowerCase()))
  // Their turns this branch left behind by rewinding: the same turn files sit on one of its rewound/ lines
  const rewoundPaths = new Set<string>()
  const rw = await git(io, ['for-each-ref', '--format=%(objectname)', `refs/heads/rewound/${S.sid}/`])
  for (const tip of rw.ok && rw.out ? rw.out.split('\n') : []) for (const [path] of await lsTree(tip, 'turns/')) rewoundPaths.add(path)
  const rewoundTurns = new Set(theirTurns.filter(([path]) => rewoundPaths.has(path)).map(([path]) => turnNumberOf(path) ?? 0))
  // This branch's records first, up to date; then what the other branch adds to them
  const { records: ours, lastTurn } = await freshRecords(io, oursTip, {})
  let records = ours
  const notes: string[] = []
  const conflicts: string[] = []
  const before = new Set(records.records.map(r => r.id))
  for (const chunk of chunkTurns(docs)) {
    const r = await io.model.complete({ model: 'haiku', system: MERGE_SYSTEM, prompt: mergePrompt(records, short, chunk, { focus, theirs: theirRecords, mine }), maxTokens: 8000, effort: 'low', timeoutMs: 90_000 })
    if (!r.isAnswered) throw new Error(`merge: the model did not answer (${r.reason})`)
    const answered = parseMergeAnswer(r.text)
    if (!answered) throw new Error('merge: the answer was not readable JSON')
    const m = onlyBackedPins(answered, chunk, pin => io.ui.log(`convo: merge left out a pin its turn's prompt does not back: turn ${pin.turn}: ${pin.text.slice(0, 120)}`, { to: 'debug' }))
    // A record with no turn of its own is dated to the run's last turn on that branch, not to one of ours
    const add = m.add.map(a => ({ ...a, turn: a.turn || (chunk.at(-1)?.n ?? 0) }))
    records = mergeRecords(records, { state: m.state, add, done: m.done }, records.throughTurn, chunk.flatMap(d => d.files), short)
    const questions = m.conflicts.map(c => conflictQuestion(c, `branch ${short}`, c.thereTurn !== undefined && rewoundTurns.has(c.thereTurn)))
    records = mergeRecords(records, { state: '', add: conflictTasks(questions), done: [] }, records.throughTurn, [])
    if (m.note) notes.push(m.note)
    conflicts.push(...questions.filter(Boolean))
  }
  records = relative(records)
  const added = records.records.filter(r => !before.has(r.id) && r.branch).map(r => `- ${r.id} [${r.kind}] ${r.text} (branch ${r.branch} turn ${r.turn})`)
  const kfs = await git(io, ['ls-tree', '--name-only', oursTip, 'keyframes/'])
  const n = (kfs.ok && kfs.out ? kfs.out.split('\n').length : 0) + 1
  const keyframe = renderKeyframe({ n, sid: S.sid, fromTurn: 1, toTurn: lastTurn, records, recall: recallLine(S.sid) })
  const note = mergeNote({ label: theirs.name, turns: docs.map(d => d.n), notes, added, conflicts, n })
  const nnnn = String(n).padStart(4, '0')
  const files = [
    { path: 'keyframe.md', text: keyframe },
    { path: `keyframes/${nnnn}.md`, text: keyframe },
    { path: 'records.json', text: recordsJson(records) },
    { path: `merges/${nnnn}-${short}.md`, text: note },
  ]
  // Their turns stay searchable under merged/<branch>/, and the outputs they point at come along; blobs are shared by hash
  // Branches it merged in turn come along, so their turns stay searchable here: only what theirs adds, by a diff
  const theirFiles = await addedFiles(io, oursTip, theirs.tip, ['blobs/', 'merged/'])
  const entries = [...theirTurns.map(([path, blob]) => `100644 blob ${blob}\tmerged/${short}/${path}`), ...theirFiles]
  const message = [
    `merge: ${theirs.name} (turns ${docs[0]?.n ?? '?'}–${docs.at(-1)?.n ?? '?'})`,
    '',
    `Session: ${S.sid}`,
    'Kind: merge',
    `Merged-From: ${theirs.name}@${theirs.tip.slice(0, 12)}`,
    ...(base ? [`Base: ${base.slice(0, 12)}`] : []),
    `Keyframe: ${n}`,
    `Brought-In: ${added.length}`,
    `Conflicts: ${conflicts.length}`,
    '',
  ].join('\n')
  const commit = await commitMerge(io, { ref, oursTip, theirsTip: theirs.tip, files, entries, message, indexFile: `${S.root}/index/${S.sid}-merge.idx` })
  const tag = await git(io, ['update-ref', `refs/tags/kf/${S.sid}/${n}`, commit])
  if (!tag.ok) io.ui.log(`convo: merge keyframe ${n} not tagged: ${tag.err.slice(0, 200)}`, { to: 'debug' })
  return `${note}\n\nThe records now read:\n\n${keyframe}`
}

/** convo's tools; recall and merge sit in the tool list, the others behind ToolSearch. */
export async function registerTools(io: Io): Promise<void> {
  const specs = [
    {
      key: 'recall' as const,
      isDeferred: false,
      description:
        'Search every earlier turn of this conversation word for word (prompts, answers, and tool output up to 8,000 characters each), including turns compaction removed from view. Use it whenever the person refers to something said, decided or done earlier that you no longer see. branch: "all" searches every line in this project (forks, rewinds), or a name from the branches tool.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to find; "quoted phrases" match whole' }, limit: { type: 'number', description: 'Turns to show, default 5' }, branch: { type: 'string', description: '"this" (default), "all", or a branch name or session id prefix' } }, required: ['query'] },
    },
    {
      key: 'merge' as const,
      isDeferred: false,
      description:
        'Bring what another line of this conversation worked out (a fork, /branch, or an attempt left by a rewind) into this one: its decisions, tasks and findings join this branch\'s records, and anything contradicting them comes back as questions for the person. Use it when the person asks to bring back, merge or take what was found elsewhere. With no branch it lists the candidates.',
      inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'Branch name or session id prefix, as the branches tool lists them' }, focus: { type: 'string', description: 'What the person wants from it, if they said' } } },
    },
    {
      key: 'turn' as const,
      isDeferred: true,
      description: 'Read one earlier turn of this conversation in full by its number (as recall and the keyframe show it), tool output included.',
      inputSchema: { type: 'object', properties: { n: { type: 'number', description: 'Turn number on the branch' }, branch: { type: 'string', description: 'Another branch, by name or session id prefix' }, path: { type: 'string', description: 'The [path: …] recall printed, for a merged or subagent turn' }, offset: { type: 'number', description: 'Where to read on from, for a long turn' } } },
    },
    {
      key: 'branches' as const,
      isDeferred: true,
      description: "List this project's other conversation lines (forks, /branch, rewinds, other sessions) and how each relates to this one.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      key: 'pane' as const,
      isDeferred: true,
      description: "Open convo's pane beside the chat: this conversation's turns, the keyframe Claude works from, open questions, and its forks, rewinds, merges and subagents. Use it when the person asks to see convo, its pane, or the conversation's branches at a glance.",
      inputSchema: { type: 'object', properties: {} },
    },
  ]
  for (const { key, ...spec } of specs) {
    try {
      const r = await io.tool.register({ name: key, ...spec })
      toolNames[key] = r.tool
    } catch (err) {
      io.ui.log(`convo: the ${key} tool is unavailable: ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
  }
}
