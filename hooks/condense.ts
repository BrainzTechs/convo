// Condensing tool output as it arrives: what Claude reads of a long log is
// its errors and failures, with passing lines, repeats and progress noise
// counted instead of shown. Lossless where it matters: git keeps every output
// word for word, and convo keeps the original beside it for the turn tool to
// read back at once. Pure: register.ts decides which results to condense and
// stores the originals.
//
// After RTK (failures-only test output, deduplication, grouping) and Headroom
// (large JSON arrays kept to their ends and their errors), applied only to new
// content as it enters the conversation, so nothing already cached changes.

/** Shorter results are left alone: the note would cost more than it saves. */
export const MIN_CHARS = 2000
/** A condensed result must be this much smaller than the original, or the original stands. */
export const MAX_RATIO = 0.7
/** Past this, a log keeps its head, its tail and its error lines. */
export const LONG_CHARS = 20_000
const HEAD_LINES = 40
const TAIL_LINES = 40
const ERROR_LINES = 120

/** Tools whose output is never condensed: what Claude edits from, reads as prose, or gets from convo or a subagent. */
export const NEVER_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion'])
/** Commands whose output is file content, a diff or a listing of names, which Claude needs exactly: never condensed. */
const VERBATIM = /^\s*(?:sudo\s+)?(?:cat|head|tail|sed|awk|less|more|bat|nl|tac|xxd|od|jq|yq|diff|patch|ls|find|fd|tree|du|wc|stat|file|git\s+(?:ls-files|ls-tree|status)\b|git\s+(?:diff|show|blame|format-patch|cat-file|log\s+(?:-p|--patch))|(?:sh|bash|zsh)\s+-c\s+['"]?(?:cat|head|sed))\b/

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
/** A line that is progress or transfer noise. */
const PROGRESS = /^\s*(?:\d{1,3}(?:\.\d+)?%|\[[=#>\-. ]{4,}\]|(?:Downloading|Downloaded|Fetching|Resolving|Receiving objects|Resolving deltas|Counting objects|Compressing objects|Writing objects|remote: (?:Counting|Compressing|Enumerating|Total))\b|[⠁-⣿]\s)/u
/** A line that says a test passed, in the runners' own words. */
const PASSING = /^\s*(?:ok\s+\S|--- PASS|=== (?:RUN|PAUSE|CONT)|PASS(?:ED)?\b|[✓✔√]\s|test \S+ \.\.\. ok$|\S+::\S+ PASSED|\.{8,}\s*(?:\[\s*\d+%\])?$)/u
/** A line worth keeping wherever it is. */
const NOTABLE = /error|fail|panic|exception|traceback|fatal|warning|warn\b|✗|✘|×|assert|expected|undefined|cannot|unable|denied|not found|exit code|segfault|timeout/i

/** What condensing left out, by kind, for the note. */
export type Dropped = { passing: number; repeats: number; progress: number; middle: number; items: number }

const none = (): Dropped => ({ passing: 0, repeats: 0, progress: 0, middle: 0, items: 0 })

/** Lines as a terminal would leave them: colour codes gone, a carriage-return rewrite kept at its last state. */
export function plainLines(text: string): string[] {
  return text.replace(ANSI, '').split('\n').map(l => {
    const parts = l.split('\r').filter(p => p.length)
    return parts.length ? (parts[parts.length - 1] ?? '') : ''
  })
}

/** A line with its numbers, hashes and times blanked: lines alike but for those are one kind. */
const shape = (l: string): string => l.replace(/0x[0-9a-f]+|[0-9a-f]{7,}|\d+(?:\.\d+)?/gi, '#').trim()

/** Progress lines out, passing test lines out (failures kept), runs of like lines counted. */
export function condenseLines(lines: readonly string[], dropped: Dropped): string[] {
  const out: string[] = []
  let passing = 0
  const flushPassing = (): void => {
    if (passing) out.push(`… ${passing} passing line${passing === 1 ? '' : 's'} left out`)
    passing = 0
  }
  for (const l of lines) {
    if (PROGRESS.test(l) && !NOTABLE.test(l)) {
      dropped.progress += 1
      continue
    }
    if (PASSING.test(l) && !NOTABLE.test(l)) {
      passing += 1
      dropped.passing += 1
      continue
    }
    flushPassing()
    out.push(l)
  }
  flushPassing()
  // Runs of five or more lines alike (numbers aside): the first and the last, and how many between
  const runs: string[] = []
  for (let i = 0; i < out.length; ) {
    const s = shape(out[i] ?? '')
    let j = i + 1
    while (j < out.length && s && shape(out[j] ?? '') === s) j++
    const n = j - i
    if (n >= 5 && !NOTABLE.test(out[i] ?? '')) {
      runs.push(out[i] ?? '', `… ${n - 2} more lines like these`, out[j - 1] ?? '')
      dropped.repeats += n - 2
    } else {
      for (let k = i; k < j; k++) runs.push(out[k] ?? '')
    }
    i = j
  }
  return runs
}

/** A long log as its head, its tail, and the notable lines between. */
export function headTail(lines: readonly string[], dropped: Dropped): string[] {
  if (lines.length <= HEAD_LINES + TAIL_LINES + 10) return [...lines]
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES)
  const kept = middle.filter(l => NOTABLE.test(l)).slice(0, ERROR_LINES)
  dropped.middle += middle.length - kept.length
  return [
    ...lines.slice(0, HEAD_LINES),
    `… ${middle.length - kept.length} lines left out${kept.length ? `; the ${kept.length} with errors or warnings follow` : ''}`,
    ...kept,
    ...(kept.length ? ['…'] : []),
    ...lines.slice(lines.length - TAIL_LINES),
  ]
}

/** JSON with long arrays kept to their first and last items and any item that reports an error. */
export function crushJson(text: string, dropped: Dropped): string | undefined {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined
  let value: unknown
  try {
    value = JSON.parse(t)
  } catch {
    return undefined
  }
  let changed = false
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(walk)
      if (items.length <= 30) return items
      changed = true
      const errors = items.slice(3, -2).filter(x => NOTABLE.test(JSON.stringify(x))).slice(0, 10)
      const left = items.length - 5 - errors.length
      dropped.items += left
      return [...items.slice(0, 3), ...errors, `… ${left} more items like these`, ...items.slice(-2)]
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const crushed = walk(value)
  return changed ? JSON.stringify(crushed, null, 1) : undefined
}

/** The note at the end of a condensed result: what went, and how to read the original. */
export function condensedNote(before: number, after: number, d: Dropped, id: string): string {
  const parts = [
    d.passing ? `${d.passing} passing test lines` : '',
    d.repeats ? `${d.repeats} repeated lines` : '',
    d.progress ? `${d.progress} progress lines` : '',
    d.middle ? `${d.middle} lines from the middle` : '',
    d.items ? `${d.items} array items` : '',
  ].filter(Boolean)
  return `[convo condensed this output from ${before.toLocaleString('en-US')} to ${after.toLocaleString('en-US')} characters, leaving out ${parts.join(', ')}. The full output, word for word: mcp__convo__turn with output "${id}".]`
}

/**
 * The condensed text of a tool result, or undefined to leave it as it is:
 * a tool whose output is never condensed, a command that prints files or
 * diffs, one the person excluded, a short result, or too little saved.
 */
export function condense(o: { tool: string; input: unknown; text: string; id: string; never?: ReadonlySet<string> }): { text: string; before: number; after: number } | undefined {
  if (NEVER_TOOLS.has(o.tool) || o.tool.startsWith('mcp__convo__') || o.text.length < MIN_CHARS) return undefined
  // Claude Code saved a very large output to a file and sent a preview: its notice and preview stand as they are
  if (o.text.trimStart().startsWith('<persisted-output>')) return undefined
  const command = o.tool === 'Bash' && o.input && typeof o.input === 'object' ? String((o.input as Record<string, unknown>).command ?? '') : ''
  if (command && VERBATIM.test(command)) return undefined
  if (command && o.never?.size) {
    const words = command.trim().split(/\s+/)
    if (words.some(w => o.never?.has(w)) || [...(o.never ?? [])].some(n => command.trim().startsWith(n))) return undefined
  }
  if (!command && o.never?.has(o.tool)) return undefined
  const dropped = none()
  const json = crushJson(o.text, dropped)
  let body: string
  if (json !== undefined) body = json
  else {
    let lines = condenseLines(plainLines(o.text), dropped)
    if (lines.join('\n').length > LONG_CHARS) lines = headTail(lines, dropped)
    body = lines.join('\n').trim()
  }
  const note = condensedNote(o.text.length, body.length, dropped, o.id)
  if (body.length + note.length > MAX_RATIO * o.text.length) return undefined
  return { text: `${body}\n\n${note}`, before: o.text.length, after: body.length + note.length + 2 }
}
