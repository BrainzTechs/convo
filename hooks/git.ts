// Git, as convo calls it: one process per call, output under the 4 MiB a process returns, files read in batches.

import type { Io } from './io.ts'
import { parseTurnFile, type TurnDoc } from './checkpoint.ts'
import { S } from './state.ts'

/** `gitDir` is this project's repo unless a caller reads another's (a peer's history). */
export async function git(io: Io, args: string[], init: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}, gitDir = S.repo): Promise<{ ok: boolean; out: string; err: string; cut?: true }> {
  const r = await io.process.run(['git', `--git-dir=${gitDir}`, ...args], { timeoutMs: 20_000, ...init })
  // Output past the 4 MiB a process returns is cut: callers that list or search say so instead of trusting it
  return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim(), ...(r.isStdoutTruncated ? { cut: true as const } : {}) }
}

export const utf8 = new TextEncoder()
export const utf8Out = new TextDecoder()

/**
 * Reads many `<tree>:<path>` files in one git process per 40 (cat-file
 * --batch), not one each: a long session's compaction reads every turn
 * since the last keyframe. A batch cut at the output cap is read one by one.
 * `init.cwd` is where the processes run: another project's repo is read from '/', the way `git` does it.
 */
export async function readFiles(io: Io, specs: readonly string[], gitDir = S.repo, init: { cwd?: string } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < specs.length; i += 40) {
    const chunk = specs.slice(i, i + 40)
    const r = await io.process.run(['git', `--git-dir=${gitDir}`, 'cat-file', '--batch'], { stdin: `${chunk.join('\n')}\n`, timeoutMs: 30_000, ...init })
    if (r.exitCode !== 0 || r.isStdoutTruncated) {
      for (const spec of chunk) {
        const one = await git(io, ['show', spec], init, gitDir)
        if (one.ok) out.set(spec, one.out)
      }
      continue
    }
    // Sizes are in bytes: read the reply as bytes, then each file back as text
    const bytes = utf8.encode(r.stdout)
    let pos = 0
    let synced = 0
    for (const spec of chunk) {
      const nl = bytes.indexOf(10, pos)
      if (nl < 0) break
      const header = utf8Out.decode(bytes.subarray(pos, nl))
      pos = nl + 1
      if (header.endsWith(' missing')) {
        synced += 1
        continue
      }
      const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(header)
      const size = Number(m?.[1])
      // A byte that did not survive decoding shifts every offset after it: stop and read the rest one by one
      if (!m || bytes[pos + size] !== 10) break
      out.set(spec, utf8Out.decode(bytes.subarray(pos, pos + size)))
      pos += size + 1
      synced += 1
    }
    for (const spec of chunk.slice(synced)) {
      const one = await git(io, ['show', spec], init, gitDir)
      if (one.ok) out.set(spec, one.out)
    }
  }
  return out
}

/** Turn files of a tree, parsed, oldest first. */
export async function readTurns(io: Io, tree: string, paths: readonly string[]): Promise<TurnDoc[]> {
  const texts = await readFiles(io, paths.map(p => `${tree}:${p}`))
  return paths.flatMap(p => {
    const d = parseTurnFile(texts.get(`${tree}:${p}`) ?? '')
    return d ? [d] : []
  })
}

export async function revOf(io: Io, ref: string): Promise<string | undefined> {
  const r = await git(io, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
  return r.ok && r.out ? r.out : undefined
}

/** Index lines for the files `to` adds or changes under `dirs` relative to `from`: what a merge brings in. */
export async function addedFiles(io: Io, from: string, to: string, dirs: readonly string[]): Promise<string[]> {
  // -z: NUL-separated, so no path is ever quoted
  const d = await git(io, ['diff-tree', '-r', '-z', '--no-commit-id', '--diff-filter=AM', from, to, '--', ...dirs])
  if (d.cut) throw new Error('too many files to merge in one go')
  const parts = d.ok ? d.out.split('\0') : []
  const lines: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) [AM]$/.exec(parts[i] ?? '')
    if (m) lines.push(`${m[1]} blob ${m[2]}\t${parts[i + 1]}`)
  }
  return lines
}
