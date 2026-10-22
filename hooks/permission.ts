// Permission for reading beyond this branch: convo asks the person itself.

import type { Io } from './io.ts'
import { S } from './state.ts'

/** Tools the person allowed for the rest of this session. */
export const allowedForSession = new Set<string>()

/** Whether a call reads only this branch's own history: no permission needed. */
export const isOwnHistory = (tool: string, input: { readonly [k: string]: unknown }): boolean => {
  const branch = typeof input.branch === 'string' ? input.branch.trim().toLowerCase() : ''
  return (tool === 'mcp__convo__recall' || tool === 'mcp__convo__turn') && (branch === '' || branch === 'this' || branch === 'current')
}

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_SESSION = 'Allow this session'
export const DECLINE = "Don't allow"

/**
 * Whether a convo tool call may run: undefined when it may, else why not. A deny from Claude Code's own decision
 * (a rule, the mode) stands; an allow rule the person wrote, bypass mode, or an earlier "allow this session"
 * lets it run; dontAsk mode declines; otherwise the person is asked. With nobody to ask (a -p run) it declines.
 */
export async function permit(io: Io, tool: string, input: { readonly [k: string]: unknown }): Promise<string | undefined> {
  if (isOwnHistory(tool, input)) return undefined
  const v = await io.tool.check({ tool, input }).catch(() => undefined)
  const said = `engine says ${v?.decision ?? 'nothing'}${v?.rule ? ` (rule ${v.rule})` : ''}, mode ${S.permissionMode || 'unknown'}`
  const log = (what: string): void => io.ui.log(`convo: permission for ${tool}: ${said}; ${what}`, { to: 'debug' })
  if (v?.decision === 'deny') {
    log('declined by that')
    return v.reason ? `Not allowed: ${v.reason}` : 'Not allowed by your permission settings.'
  }
  if ((v?.decision === 'allow' && v.rule) || S.permissionMode === 'bypassPermissions' || allowedForSession.has(tool)) {
    log('allowed')
    return undefined
  }
  const rule = `add "${tool}" to permissions.allow (or --allowedTools) to let it run without asking`
  if (S.permissionMode === 'dontAsk') {
    log('declined: dontAsk mode')
    return `This reads beyond this conversation and needs the person's approval, which dontAsk mode does not ask for: ${rule}.`
  }
  const what = tool === 'mcp__convo__merge' ? "merge another line of this project into this conversation" : tool === 'mcp__convo__branches' ? "list this project's other conversations" : "read other conversations' history in this project"
  let answer: string
  try {
    answer = await io.ui.ask(`Let Claude ${what}?`, { options: [ALLOW_ONCE, ALLOW_SESSION, DECLINE], header: 'convo' })
  } catch {
    log('declined: nobody to ask')
    return `This reads beyond this conversation and needs the person's approval, and nobody could be asked here (a run with no one at the keyboard): ${rule}.`
  }
  if (answer === ALLOW_SESSION) allowedForSession.add(tool)
  if (answer === ALLOW_ONCE || answer === ALLOW_SESSION) {
    log(`the person chose "${answer}"`)
    return undefined
  }
  log('the person declined')
  return answer === DECLINE ? 'The person declined this.' : `The person declined this and said: ${answer.slice(0, 500)}`
}
