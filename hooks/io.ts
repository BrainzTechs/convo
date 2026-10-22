// The part of Claude Code's engine convo's modules use, handed to them by the hooks.
//
// Claude Code follows `$` (the engine) only into functions of the hooks file
// itself (2.1.296 and earlier refuse a module that passes it across an
// import), so register.ts builds this from `$` with each call spelled out,
// and the other modules take it in `$`'s place.

import type { EngineInterface, SessionMessage } from 'claude-code'

type E = EngineInterface

export type Io = {
  process: Pick<E['process'], 'run'>
  // A file read as text, and the conversation as messages: the forms convo uses
  fs: Pick<E['fs'], 'exists' | 'list' | 'stat' | 'write'> & { read: (path: string) => Promise<string> }
  model: Pick<E['model'], 'complete'>
  session: { messages: () => Promise<readonly SessionMessage[]> }
  store: Pick<E['store'], 'get' | 'set'>
  tool: Pick<E['tool'], 'check' | 'register'>
  ui: Pick<E['ui'], 'ask' | 'log'>
}
