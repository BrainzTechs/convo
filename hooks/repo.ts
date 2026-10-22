// The project's history folder and its bare repo.

import type { Io } from './io.ts'
import { sha256 } from './turns.ts'
import { S } from './state.ts'

/**
 * The project's history folder: its path made readable, cut to a safe
 * length, plus a hash of the exact path, so /a/my-proj and /a/my_proj never
 * share one. A folder an older convo made without the hash is kept when the
 * path it recorded (its `cwd` file) is this project's, or it recorded none.
 */
export async function projectRoot(io: Io, home: string, dir: string): Promise<string> {
  const base = `${home}/.claude/convo`
  const readable = dir.replace(/[^A-Za-z0-9]/g, '-')
  const hashed = `${base}/${readable.slice(-120)}-${(await sha256(dir)).slice(0, 8)}`
  if (await io.fs.exists(hashed)) return hashed
  const legacy = `${base}/${readable}`
  if (readable.length <= 200 && (await io.fs.exists(`${legacy}/repo.git/HEAD`))) {
    const mark = `${legacy}/cwd`
    if (!(await io.fs.exists(mark)) || (await io.fs.read(mark)).trim() === dir) return legacy
  }
  return hashed
}

/** Sets up the project's history folder, private to this user; the reason it could not, or undefined. */
export async function ensureRepo(io: Io): Promise<string | undefined> {
  try {
    const v = await io.process.run(['git', '--version'], { timeoutMs: 10_000 })
    if (v.exitCode !== 0) return 'git was not found'
    // Index files, the row index, spool claims and heartbeats live here; git cannot create their folders
    const made = await io.process.run(['mkdir', '-p', `${S.root}/index`, `${S.root}/rows`, `${S.root}/alive`, `${S.root}/spool-failed`])
    if (made.exitCode !== 0) return `could not create ${S.root}: ${made.stderr.trim().slice(0, 120)}`
    // Conversations are as private as Claude Code's own transcripts: only this user can read them
    const convoDir = S.root.slice(0, S.root.lastIndexOf('/'))
    await io.process.run(['chmod', '700', convoDir, S.root])
    // Which project this folder holds, so two paths that read alike never share it
    if (!(await io.fs.exists(`${S.root}/cwd`))) await io.fs.write(`${S.root}/cwd`, `${S.cwd}\n`)
    if (!(await io.fs.exists(`${S.repo}/HEAD`))) {
      const init = await io.process.run(['git', 'init', '--bare', '-q', '--shared=0600', S.repo], { timeoutMs: 20_000 })
      // Another session in this project may have made it at the same moment: theirs is as good
      if (init.exitCode !== 0 && !(await io.fs.exists(`${S.repo}/HEAD`))) return `git init failed: ${init.stderr.trim().slice(0, 120)}`
    } else {
      await io.process.run(['git', `--git-dir=${S.repo}`, 'config', 'core.sharedRepository', '0600'], { timeoutMs: 10_000 })
    }
    return undefined
  } catch (err) {
    return String(err).slice(0, 160)
  }
}
