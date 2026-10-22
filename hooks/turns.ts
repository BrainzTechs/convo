// Pure turn assembly: rows in, a turn file and its commit message out.
// No `$` here, so everything is unit-tested directly.

import { mask } from './redact.ts'

/** The parts of a stored conversation row the mod keeps. */
export type Row = {
  door: string
  uuid: string
  name?: string
  type: string
  blocks: Block[]
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean }

/** Doors whose rows are part of the conversation history. */
export const KEPT_DOORS = new Set(['prompt', 'response', 'tool-result', 'command', 'delivery'])

/** Copies the blocks of a row's content that history needs; drops thinking, images and unknown kinds. */
export function toBlocks(content: readonly { type: string; [k: string]: unknown }[]): Block[] {
  const out: Block[] = []
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input })
    else if (b.type === 'tool_result') out.push({ type: 'tool_result', toolUseId: String(b.tool_use_id ?? ''), text: resultText(b.content), isError: b.is_error === true })
  }
  return out
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(c => (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '[non-text content]'))
    .join('\n')
}

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }

/** Placeholders the committer replaces with the next number on the branch. */
export const N = '{N}'
export const NNNN = '{NNNN}'

export type TurnInput = {
  turnId: string
  sessionId: string
  agentId?: string
  /** turn.start's text: the fallback when no prompt row came. */
  startText?: string
  rows: readonly Row[]
  answer: string
  reason: string
  durationMs?: number
  usage?: Usage
  /** tool_use id → subagent id, from agent.spawn. */
  agents: ReadonlyMap<string, string>
  at: string
}

/** A file to add: its text, or (for one too big to spool) the git blob already holding it, with text empty. */
export type FileOut = { path: string; text: string; blob?: string }
export type TurnOut = { files: FileOut[]; message: string; tailHash: string; rowIds: string[] }

/** Results longer than this go to a blob file; the turn file keeps a preview. */
export const BLOB_CHARS = 8000
const PREVIEW_CHARS = 600
const INPUT_CHARS = 300

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [${s.length} chars]` : s)

/** One line describing a tool call's input. */
export function inputSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as Record<string, unknown>
  const first = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'description', 'skill']
    .map(k => i[k])
    .find(v => typeof v === 'string')
  const text = typeof first === 'string' ? first : JSON.stringify(input)
  return cut(mask(text.replace(/\s+/g, ' ').trim()), INPUT_CHARS)
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead'])

/** Paths a turn read or changed, from its file tool calls. */
export function touchedFiles(rows: readonly Row[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    for (const b of r.blocks) {
      if (b.type !== 'tool_use' || !FILE_TOOLS.has(b.name)) continue
      const i = (b.input ?? {}) as Record<string, unknown>
      const p = i.file_path ?? i.notebook_path ?? i.path
      if (typeof p === 'string') out.add(p)
    }
  }
  return [...out].sort()
}

const yamlList = (xs: readonly string[]): string => `[${xs.map(x => JSON.stringify(x)).join(', ')}]`

/** A line of conversation text that reads like one of convo's section headings is indented, so it cannot pose as one. */
const unheaded = (t: string): string => t.replace(/^(## (?:Command|Prompt|Delivered|Answer|Tools))$/gm, ' $1')

/** Builds the turn file, any blob files, and the commit message. All text is redacted. */
export async function assembleTurn(t: TurnInput): Promise<TurnOut> {
  const prompts: string[] = []
  const commands: string[] = []
  const deliveries: string[] = []
  const uses: { id: string; name: string; input: unknown }[] = []
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const r of t.rows) {
    for (const b of r.blocks) {
      if (b.type === 'text') {
        if (r.door === 'prompt') prompts.push(b.text)
        else if (r.door === 'command') commands.push(b.text)
        else if (r.door === 'delivery') deliveries.push(b.text)
      } else if (b.type === 'tool_use') {
        uses.push(b)
      } else if (b.type === 'tool_result') {
        results.set(b.toolUseId, { text: b.text, isError: b.isError })
      }
    }
  }

  const prompt = unheaded(mask((prompts.join('\n\n') || t.startText || '').trim()))
  const answer = unheaded(mask(t.answer.trim()))
  const files: FileOut[] = []
  const toolLines: string[] = []
  const agentIds: string[] = []
  for (const u of uses) {
    const res = results.get(u.id)
    const agent = t.agents.get(u.id)
    if (agent) agentIds.push(agent)
    let line = `- ${u.name} \`${inputSummary(u.name, u.input).replace(/`/g, "'")}\``
    if (agent) line += ` → agent/${t.sessionId.slice(0, 8)}/${agent}`
    if (res) {
      const text = mask(res.text)
      const status = res.isError ? 'error' : 'ok'
      const lines = text.split('\n').length
      if (text.length > BLOB_CHARS) {
        const hash = await sha256(text)
        const path = `blobs/${hash.slice(0, 2)}/${hash.slice(2, 16)}.txt`
        files.push({ path, text })
        line += ` → ${status}, ${lines} lines, ${text.length} chars, full output: ${path}`
      } else {
        line += ` → ${status}, ${lines} lines`
      }
      // Output up to BLOB_CHARS stays whole in the turn, so recall finds it; longer output is in its blob, previewed here
      const shown = unheaded(text.length > BLOB_CHARS ? cut(text.trim(), PREVIEW_CHARS) : text.trim()).replace(/\n/g, '\n    ')
      if (shown) line += `\n    ${shown}`
    }
    toolLines.push(line)
  }

  const rowIds = t.rows.map(r => r.uuid)
  const touched = touchedFiles(t.rows)
  const tailHash = (await sha256(`${prompt}\n\u0000\n${answer}`)).slice(0, 16)
  const u = t.usage ?? {}
  const front = [
    '---',
    'schema: 1',
    `turn: ${N}`,
    `turnId: ${t.turnId}`,
    `session: ${t.sessionId}`,
    ...(t.agentId ? [`agent: ${t.agentId}`] : []),
    `at: ${t.at}`,
    `reason: ${t.reason}`,
    ...(t.durationMs !== undefined ? [`durationMs: ${t.durationMs}`] : []),
    ...(u.model ? [`model: ${u.model}`] : []),
    `usage: { in: ${u.input_tokens ?? 0}, out: ${u.output_tokens ?? 0}, cacheRead: ${u.cache_read_input_tokens ?? 0}, cacheWrite: ${u.cache_creation_input_tokens ?? 0} }`,
    `rows: ${yamlList(rowIds)}`,
    `files: ${yamlList(touched)}`,
    `agents: ${yamlList(agentIds)}`,
    `tailHash: ${tailHash}`,
    '---',
  ]
  const body = [
    ...(commands.length ? ['## Command', unheaded(mask(commands.join('\n'))), ''] : []),
    '## Prompt',
    prompt || '(none)',
    '',
    ...(deliveries.length ? ['## Delivered', unheaded(mask(deliveries.join('\n\n'))), ''] : []),
    '## Answer',
    answer || '(none)',
    '',
    ...(toolLines.length ? ['## Tools', ...toolLines, ''] : []),
  ]
  const short = t.turnId.slice(0, 8)
  files.unshift({ path: `${turnDir(t.agentId)}/${NNNN}-${short}.md`, text: [...front, ...body].join('\n') })

  const isNotification = prompt.startsWith('<task-notification>')
  const subjectSource = isNotification
    ? `(subagent finished) ${/<summary>([^<]*)<\/summary>/.exec(prompt)?.[1] ?? ''}`
    : (prompt || commands.join(' ') || '(no prompt)').split('\n')[0] ?? ''
  const subject = `turn ${N}: ${cut(subjectSource.trim(), 60).replace(/… \[\d+ chars\]$/, '…')}`
  const trailers = [
    `Turn-Id: ${t.turnId}`,
    `Session: ${t.sessionId}`,
    ...(t.agentId ? [`Agent: ${t.agentId}`] : []),
    ...(u.model ? [`Model: ${u.model}`] : []),
    ...(touched.length ? [`Files: ${touched.join(', ')}`] : []),
    ...(agentIds.length ? [`Agents: ${agentIds.join(', ')}`] : []),
    `Reason: ${t.reason}`,
    `Tail-Hash: ${tailHash}`,
  ]
  return { files, message: `${subject}\n\n${trailers.join('\n')}\n`, tailHash, rowIds }
}

/** A native compaction, recorded as a keyframe of its own so the history still has the boundary. */
export function assembleCompaction(sessionId: string, summary: string, at: string): { files: FileOut[]; message: string } {
  const text = ['---', 'schema: 1', 'kind: native-compaction', `session: ${sessionId}`, `at: ${at}`, '---', mask(summary.trim())].join('\n')
  return {
    files: [{ path: `keyframes/${NNNN}-native.md`, text }],
    message: `keyframe ${N}: native summary\n\nSession: ${sessionId}\nKind: native-compaction\n`,
  }
}

/** Where a turn's file goes: the session's turns, or a folder of the subagent's own. */
export const turnDir = (agentId?: string): string => (agentId ? `agents/${agentId}/turns` : 'turns')

/** Git branch names for a session and its subagents. */
export const refs = {
  session: (sid: string): string => `refs/heads/session/${sid}`,
  agent: (sid: string, agentId: string): string => `refs/heads/agent/${sid}/${agentId}`,
}

/** One unit of work waiting in the spool: files to add on a branch, and the message. */
export type SpoolItem = {
  ref: string
  base?: string
  /** The folder whose file count on the branch gives this commit its number. */
  numberIn?: string
  files: FileOut[]
  message: string
  at: string
  /** A main-thread turn's row ids, in order: indexed once committed, and where lineage starts. */
  rows?: string[]
  /** The transcript holding those rows, whose parent links say which turn this one continues. */
  transcript?: string
  /** Branches this commit also merges (a subagent's that finished in the turn): extra parents when they exist. */
  merge?: string[]
  /** A subagent's item: the rows of the turn that spawned it so far, so its branch starts where that turn continues from. */
  baseRows?: string[]
  /** The tip the files were built from: the commit fails rather than land on another (keyframes, records). */
  expectTip?: string
}

/**
 * Fills in the number placeholders where convo put them, and nowhere else:
 * every path, the front matter's `turn:` line and the subject's own number.
 * A `{N}` or `{NNNN}` in conversation text (a regex, a template, a format
 * string) is part of what was said and stays as written.
 */
export function numbered(item: SpoolItem, n: number): SpoolItem {
  const nnnn = String(n).padStart(4, '0')
  const path = (p: string): string => p.split(NNNN).join(nnnn)
  const text = (t: string): string => (t.startsWith('---\n') ? t.replace(/^(---\n(?:(?!---\n)[^\n]*\n)*?turn: )\{N\}$/m, `$1${n}`) : t)
  const [subject = '', ...rest] = item.message.split('\n')
  return {
    ...item,
    files: item.files.map(f => ({ ...f, path: path(f.path), text: f.path.includes(NNNN) ? text(f.text) : f.text })),
    message: [subject.replace(N, String(n)), ...rest].join('\n'),
  }
}
