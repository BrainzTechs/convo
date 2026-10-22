import { describe, expect, test } from 'claude-code/testing'
import { condense, condenseLines, crushJson, plainLines } from '../hooks/condense.ts'

/** A distinct word for each number, with no digits in it. */
const word = (n: number): string => {
  let s = ''
  let x = n + 1
  while (x > 0) {
    s = String.fromCharCode(97 + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return s
}

const goTest = [
  ...Array.from({ length: 300 }, (_, i) => `=== RUN   TestLedger${i}\n--- PASS: TestLedger${i} (0.00s)`),
  '=== RUN   TestTransfer',
  '    ledger_test.go:88: expected balance 100, got 90',
  '--- FAIL: TestTransfer (0.01s)',
  'FAIL',
  'FAIL\tledgerd/store\t0.412s',
  ...Array.from({ length: 40 }, (_, i) => `ok  \tledgerd/pkg${i}\t0.0${i % 10}s`),
].join('\n')

describe('condensing tool output', () => {
  test('a test run keeps its failures; passing lines are counted, and the note says how to read it all', () => {
    const r = condense({ tool: 'Bash', input: { command: 'go test ./...' }, text: goTest, id: 'toolu_01abc' })
    expect(r).toBeDefined()
    const t = r?.text ?? ''
    expect(t).toContain('ledger_test.go:88: expected balance 100, got 90')
    expect(t).toContain('--- FAIL: TestTransfer (0.01s)')
    expect(t).toContain('FAIL\tledgerd/store\t0.412s')
    expect(t).not.toContain('--- PASS: TestLedger17')
    expect(t).toContain('… 601 passing lines left out')
    expect(t).toContain('The full output, word for word: mcp__convo__turn with output "toolu_01abc".')
    expect((r?.after ?? 0) / (r?.before ?? 1)).toBeLessThan(0.1)
  })

  test('a long log: runs of like lines become first, count, last; the errors stay', () => {
    const log = [...Array.from({ length: 2000 }, (_, i) => `GET /healthz 200 ${i % 7}.${i % 10}ms`), 'ERROR db: connection refused', ...Array.from({ length: 500 }, (_, i) => `GET /metrics 200 ${i}ms`)].join('\n')
    const t = condense({ tool: 'Bash', input: { command: 'kubectl logs api' }, text: log, id: 'x1234567' })?.text ?? ''
    expect(t.split('\n').slice(0, 4)).toEqual(['GET /healthz 200 0.0ms', '… 1998 more lines like these', 'GET /healthz 200 4.9ms', 'ERROR db: connection refused'])
    expect(t).toContain('… 498 more lines like these')
  })

  test('progress and colour codes go; a carriage-return bar keeps its last state', () => {
    expect(plainLines('\u001b[32mok\u001b[0m\n10%\r55%\r100% done')).toEqual(['ok', '100% done'])
    const npm = [...Array.from({ length: 200 }, (_, i) => `Downloading pkg${i}@1.0.${i}`), 'npm WARN deprecated left-pad@1.3.0', 'added 812 packages in 9s'].join('\n')
    const t = condense({ tool: 'Bash', input: { command: 'npm install' }, text: npm, id: 'x1234567' })?.text ?? ''
    expect(t.startsWith('npm WARN deprecated left-pad@1.3.0\nadded 812 packages in 9s')).toBe(true)
    expect(t).toContain('200 progress lines')
  })

  test('large JSON keeps the ends of long arrays and the items that report errors', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, state: i === 50 ? 'failed: timeout' : 'ok' }))
    const out = crushJson(JSON.stringify({ items, total: 100 }), { passing: 0, repeats: 0, progress: 0, middle: 0, items: 0 })
    const v = JSON.parse(out ?? '{}')
    expect(v.total).toBe(100)
    expect(v.items.map((x: { id?: number } | string) => (typeof x === 'string' ? x : x.id))).toEqual([0, 1, 2, 50, '… 94 more items like these', 98, 99])
    expect(crushJson('{"a": [1, 2, 3]}', { passing: 0, repeats: 0, progress: 0, middle: 0, items: 0 })).toBeUndefined()
  })

  test('left alone: files and diffs, tools Claude edits from, convo and subagents, short output, excluded commands, little saved', () => {
    const long = 'line of real content\n'.repeat(500)
    expect(condense({ tool: 'Bash', input: { command: 'cat src/main.go' }, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Bash', input: { command: 'git diff HEAD~1' }, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Bash', input: { command: 'sed -n 1,400p a.ts' }, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Read', input: { file_path: '/a' }, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Grep', input: { pattern: 'x' }, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'mcp__convo__turn', input: {}, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Agent', input: {}, text: goTest, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Bash', input: { command: 'go test' }, text: 'ok  \tledgerd\t0.1s\n', id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Bash', input: { command: 'go test ./...' }, text: goTest, id: 'x', never: new Set(['go']) })).toBeUndefined()
    // Claude Code's own notice for an output it saved to a file stands as it is
    expect(condense({ tool: 'Bash', input: { command: 'yes | head -9000' }, text: `<persisted-output>\nOutput too large (67.4KB). Full output saved to: /tmp/x.txt\n\nPreview (first 2KB):\n${'GET /healthz 200 0.2ms\n'.repeat(120)}</persisted-output>`, id: 'x' })).toBeUndefined()
    // Listings keep every name, numbered ones too
    const listing = Array.from({ length: 200 }, (_, i) => `-rw-r--r--  1 me  staff  ${i * 13} Oct 22 file-${i}.txt`).join('\n')
    expect(condense({ tool: 'Bash', input: { command: 'ls -la' }, text: listing, id: 'x' })).toBeUndefined()
    expect(condense({ tool: 'Bash', input: { command: 'find . -name "*.txt"' }, text: listing, id: 'x' })).toBeUndefined()
    // Nothing to leave out: the original stands
    expect(condense({ tool: 'Bash', input: { command: 'make env' }, text: Array.from({ length: 300 }, (_, i) => `${word(i)}_SETTING=${word(i * 7)}`).join('\n'), id: 'x' })).toBeUndefined()
    void long
  })

  test('a very long log keeps its head, its tail and its error lines', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `compiled ${word(i)}/${word(i * 7 + 3)} into ${word(i * 13 + 5)}`)
    lines[1500] = 'error[E0308]: mismatched types in ledger.rs:41'
    const t = condense({ tool: 'Bash', input: { command: 'cargo build -vv' }, text: lines.join('\n'), id: 'x1234567' })?.text ?? ''
    expect(t).toContain('error[E0308]: mismatched types in ledger.rs:41')
    expect(t).toContain('lines left out; the 1 with errors or warnings follow')
    expect(t).toContain(lines[0] ?? '')
    expect(t).toContain(lines[2999] ?? '')
  })

  test('condenseLines alone: failures inside a passing run split it', () => {
    const d = { passing: 0, repeats: 0, progress: 0, middle: 0, items: 0 }
    expect(condenseLines(['ok  a 0.1s', 'ok  b 0.1s', '--- FAIL: TestX', 'ok  c 0.1s'], d)).toEqual(['… 2 passing lines left out', '--- FAIL: TestX', '… 1 passing line left out'])
  })
})
