# convo

A Claude Code mod that keeps every conversation as git history and replaces
compaction with a structured **keyframe**, so nothing a session learned is
lost when its context is compacted. Each turn becomes a commit, each session a
branch, each subagent a side branch. A fork or `/branch` starts a git branch
at the turn it came from, and a rewind branches off the earlier turn while
keeping the line you left. Ask Claude to bring a branch back and it merges
it; ask about something from earlier and it looks it up.

Everything is automatic: there are no commands to learn.

Needs `git` on macOS or Linux (not Windows yet). Tested on Claude Code
2.1.296 and 2.1.303.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install convo --marketplace brainztechs/convo
```

Answer `y` to add the marketplace, then pick a scope (the user scope keeps it
on in every project). It is active at once, with nothing to restart.

From a shell:

```bash
claude plugin install convo --marketplace brainztechs/convo
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `brainztechs/convo`, then Add plugin.

## Where it goes

`~/.claude/convo/<project>-<hash>/repo.git`, a bare repo per project (its
path made readable plus a hash of the exact path; a `cwd` file inside says
which project it holds), separate from
your project's own git. Local only: no remote, never pushed, and readable only
by you (the folder is 0700, like Claude Code's own transcripts).

| Branch or path | Holds |
| --- | --- |
| `session/<session-id>` | One commit per turn of that session |
| `agent/<session-id>/<agent-id>` | A subagent's turns, branched from its session |
| `rewound/<session-id>/<commit>` | The turns a rewind left behind, kept rather than lost |
| `turns/0001-<turn>.md` | Prompt, answer, tools used with result previews, files touched, token use |
| `agents/<agent-id>/turns/…` | The same, for a subagent |
| `keyframe.md` | The latest keyframe: what Claude read after the last compaction |
| `records.json` | Decisions, assumptions, tasks and pins, each with the turn it came from |
| `keyframes/0002.md` | Every keyframe ever made; `-native.md` ones are Claude Code's own summaries |
| `kf/<session-id>/<n>` (tag) | The commit holding keyframe *n* |
| `merges/0003-<branch>.md` | What a merge brought in, and what it left for you to decide |
| `merged/<branch>/turns/…` | A merged branch's own turns, so recall finds them here |
| `blobs/…` | Tool results over 8,000 characters, stored once by content hash |

Each commit message carries `Turn-Id`, `Session`, `Model`, `Files`, `Agents`,
`Reason` and `Tail-Hash` trailers, so `git log --grep` works without opening files.

## Branches follow the conversation

Claude Code links every transcript row to the row before it, and a fork keeps
those links. convo records which rows each turn commit holds, so every new
turn is placed after the exact turn it continues:

| You do | In git |
| --- | --- |
| Keep chatting, resume, compact | The next commit on `session/<id>` |
| `/branch`, fork a session, `--fork-session` | A new `session/<new-id>` branch starting at the turn you forked from, with a `Branched-From: <session>@<commit>` trailer |
| Rewind to an earlier message and carry on | `session/<id>` moves back to that turn and goes on from there; the turns you left are kept on `rewound/<id>/<commit>`, and the new commit says `Rewound-To` and `Kept-As` |
| `/clear` | A new branch with no parent: a fresh conversation |

Turn numbers follow the line: a fork of turn 2 numbers its first turn 3, and
so does a rewind to turn 2. The row index lives in `~/.claude/convo/<project>/rows/`.

## Keyframes replace compaction

When Claude Code compacts (`/compact`, or its own threshold), convo answers in
its place:

1. Haiku reads the turns since the last keyframe (in several calls when there are many) and pulls out
   records: **decisions**, **assumptions**, **tasks** (open or done) and
   **pins**, each pointing at the turn it came from. Records merge and are
   never deleted: a new decision supersedes an old one, a task gets ticked.
2. A pin is anything you asked Claude to keep in mind, remember or always
   follow. Just say it; there is no command. Only your own prompt can make a
   pin: text in a file, a web page or tool output that claims to be your
   instruction is not kept as one. Each pin carries your words exactly as you
   typed them, checked against that turn's prompt, and the keyframe shows them
   beside it.
3. The keyframe is the records plus a short State line, capped at about
   2,500 tokens. It is committed and tagged before Claude sees it.
4. Claude continues from the keyframe and the last two turns word for word.
   Text after `/compact` steers what the records stress.

```markdown
# Keyframe 4 · session cccccccc · turns 1–5

## State
ratelimit.go now implements a sliding-window log per customer; not run yet.

## Decisions
- D3 Sliding-window log, per-customer timestamps (turn 5) — supersedes D2

## Tasks
- [ ] T1 Run go test after go mod init (turn 3)
- [x] T2 Retry path for a store outage (turn 3, done turn 5)

## Pins
- P2 Never add a Redis dependency to ratelimit — they said "and never add Redis, please" (pinned turn 2)
```

It falls back rather than fail you:

| When | What happens |
| --- | --- |
| The keyframe can't be built (git, the model call, the last turn alone is too big to keep, or it would not shrink the conversation) | Native compaction runs; its summary is recorded as `keyframes/NNNN-native.md` |
| convo was installed partway into a conversation, so git lacks its early turns | Native, so nothing git never saw is dropped |
| Your organization manages Claude Code, so installed mods don't get the compaction hook | Native compaction runs, and the first prompt after it carries the keyframe as hidden context, so Claude reads both |
| A subagent compacts, or another mod asked for the compaction | Native, untouched |

Each keyframe ends by pointing Claude at the recall tools below.

## Merge and recall, by asking

convo gives Claude five tools. You never call them; you just say what you want.

| Tool | Claude uses it when you say something like | What it does |
| --- | --- | --- |
| `merge` | "Bring back what we worked out in the other branch" | Reads the other branch's turns since the two split and adds what it settled to this branch's records. Anything that contradicts them comes back as a question for you, and stays an open task until you decide. The result is a real two-parent merge commit with a new keyframe |
| `recall` | "What did we decide about caching back then?" | Searches every earlier turn word for word (prompts, answers, tool output up to 8,000 characters), including turns compaction removed from view, on this branch or on every branch in the project. What you said counts most, then Claude's answers, then tool output; rarer words count more; among equals the newer turn comes first, so it finds the last word on something. It says which of its words no turn has |
| `turn` | "What exactly did I say in my first message?" | Reads one turn in full, tool output included |
| `branches` | "What other lines do we have?" | Lists forks, `/branch` copies and rewound attempts, and where each split from this one |
| `pane` | "Show me convo's pane" | Opens the pane beside the chat (below), for when you closed it or the screen was too narrow for it to open by itself |

Recall and merge sit in Claude's tool list; the other three load when needed.
Searching and reading this conversation's own history never asks permission.
Reading other conversations in the project (recall or turn on another branch,
the branches list) and merging ask you first, in a small question with
"Allow once", "Allow this session" and "Don't allow", so an instruction planted
in a web page or file cannot quietly pull another conversation in. convo asks
this itself, whatever your permission mode (auto mode's approver does not
decide it): a deny rule in your settings still refuses, an allow rule
(`"permissions": {"allow": ["mcp__convo__recall"]}`) or bypass mode lets it
run without asking, dontAsk mode declines, and so does a `-p` run with nobody
to ask.

A subagent's branch merges back on its own: the turn that ran it becomes a
commit with the subagent's branch as a second parent (a `Merged-Agents`
trailer names it), and its turns are searchable from the session. Not merged:
background subagents still running when the turn ends, and a subagent started
in the first turn after a rewind (its branch grew from the line the rewind
left, which stays separate).

## Looking at it

convo's pane sits beside the chat and follows the conversation as it goes:

```
Session 779e850b · 13 turns
Claude works from keyframe 3, made after turn 7, then 6 turns.
1 question open:
  HTTP port: undecided (here, turn 5) or 8080 (branch 3162559f, turn 5)?

Lines
  fork 3162559f · split after turn 4 · 1 turn · merged after turn 5, 2 questions · 2 hours ago
    “In this branch only, rename to ledgerx”
  rewound after turn 4 · 1 turn · 2 hours ago
    “One more decision: the HTTP port is 8080”
  1 subagent, 1 merged in
2 other conversations in this project.
```

It opens by itself in an interactive session when the screen is wide enough
(Claude Code places a pane nobody asked for from 144 columns). Close it and it
stays closed in later sessions; ask Claude to show convo's pane and it comes
back. "What Claude works from" is the newest compaction on this line: after
it, Claude sees that keyframe (or Claude Code's own summary) and the turns
since, not the turns before.

Below the lines, the pane keeps a token ledger for the window:

```
Tokens · this window · $0.06
  167k in over 2 requests, 153 out
  every request carries 25k of setup: skills 9.8k, custom agents 6.5k, system tools 4.2k
  conversation now 59k; tool output added 61 (Bash 61)
  cache: 98% read from cache · no misses
```

It counts every model request as Claude Code reports it (main thread and
subagents), takes the setup and conversation sizes from `/context`'s own
breakdown (counted locally, no tokens spent), and the cost from the status
line, this window's share only. A request that re-caches what the one before
it had cached is a cache miss: the pane names its turn, its size and the
likely cause (a pause long enough for the cache to expire, another model, or
a change at the start of the request). The re-cache after a compaction, and
the first request of a window, are expected and counted apart.

To look at the history yourself, use git directly, for example:

```bash
git --git-dir ~/.claude/convo/<project>/repo.git log --oneline --all
git --git-dir ~/.claude/convo/<project>/repo.git grep -i "rate limit" session/<id>
```

## How it stays out of the way

- **No git inside a turn.** A finished turn is written to a spool file; a timer
  commits the spool every 2 seconds with git plumbing (no checkout, no shared
  index), so two sessions in one project never block each other.
- **Nothing lost on exit.** A session that ends before its spool is committed
  leaves the files behind; the next session in that project commits them.
- **Redaction before writing.** API keys and tokens (Anthropic, OpenAI, AWS,
  GitHub, GitLab, Google, Stripe, Slack, npm, SendGrid, Twilio, JWTs), private
  keys, passwords in connection strings and `Authorization` headers, Azure
  keys, and secret-named values in env files, JSON and YAML are masked before
  anything reaches the spool or git. Ordinary code such as `token = getToken()`
  is left alone. Best effort: the repo is still kept private.
- **Nothing lost, nothing doubled.** A spool file is written whole and then
  renamed; each commit records its spool id, so a flush cut off midway never
  commits a turn twice; a file that keeps failing for 10 minutes moves to
  `spool-failed/` instead of holding up the turns after it.
- **Lineage worked out off the turn.** The committer reads the end of the
  transcript to find a turn's parent, the whole file only when it must.
- **Merging costs one or two small calls.** Haiku reads the other branch's
  turns, and this branch's newest turns if the records don't cover them yet.
- **Keyframes cost one small call.** The records call goes to Haiku and only
  over turns since the last keyframe; Claude Code's background pre-summary is
  skipped since the keyframe would replace it.

## Run it from a checkout

To work on convo itself, run Claude Code with the folder you cloned it to:

```bash
git clone https://github.com/brainztechs/convo.git
claude --plugin-dir ./convo
```

## Checks

```bash
claude plugin validate ./convo
claude plugin test ./convo                                   # unit tests, inside Claude Code's engine
node --experimental-strip-types --no-warnings convo/tests/e2e/run.ts   # real git (or: bun convo/tests/e2e/run.ts)
bash convo/live-test.sh                                      # all of it, with real Claude Code sessions
```

`claude plugin test` runs the hooks against Claude Code's engine, with git
stood in for. `tests/e2e` runs the same hooks against real git in a throwaway
home folder, with a scripted model and transcripts written the way Claude Code
writes them: turns, a fork, a rewind, a keyframe and the turn after it, a
native fallback, a merge, recall across branches, permission, a subagent, and
spool recovery (a repeated flush, a corrupt file, a session that ended early).
Each scenario runs in a process of its own. Node 22.6 or newer, or Bun.

### Recall eval

```bash
node --experimental-strip-types --no-warnings convo/tests/eval/recall.ts                  # ranking, offline: no model, no tokens
node --experimental-strip-types --no-warnings convo/tests/eval/recall.ts --live           # real Claude asks each question
node --experimental-strip-types --no-warnings convo/tests/eval/recall.ts --live --model sonnet
```

The live run's cost depends on the model and on what your setup loads into
each session (CLAUDE.md, plugins, MCP servers): about $1.20 for the 20
questions on a bare setup, about $6 with Opus and a full one.

`tests/eval/corpus.ts` builds a 130-turn conversation about a Go ledger
service in real git: 20 facts planted at known turns among filler that reads
like real work (config dumps, test runs, code) and shares their words. Some
facts change later (the latest is the answer), some appear only in tool
output, in Claude's answer, in a subagent's turn or on a fork, and some
questions use words the conversation never did.

Offline, each question's three query variants go straight to recall and the
rank of the right turn is scored. Live, each question is asked in a fresh
`claude -p` session in a scratch project seeded with that history, Claude
choosing its own search words; the answer is checked and the searches,
calls and cost are printed. Scratch history and transcripts are removed
afterwards.

## Code

`hooks/register.ts` holds the hooks; the rest of `hooks/` is what they call:

| File | What it does |
|---|---|
| `state.ts` | What convo knows about the session, shared by the modules |
| `io.ts` | The engine calls the modules make, handed to them by `register.ts` (Claude Code 2.1.296 and earlier follow `$` only within the hooks file) |
| `turns.ts` | Turn rows → a turn file and commit message |
| `spool.ts` | Finished turns wait as files; a timer commits them; leftovers are adopted |
| `commit.ts` | Plumbing commits: continue, branch, rewind, subagent merges, branch merges |
| `rows.ts`, `lineage.ts` | Which committed turn a new turn continues from |
| `git.ts`, `repo.ts` | Calling git; the project's history folder |
| `checkpoint.ts`, `keyframes.ts` | Records and keyframes |
| `session.ts` | Session switches and native compactions noticed |
| `history.ts`, `tools.ts` | recall, turn, branches, merge and pane |
| `view.ts` | What the pane beside the chat shows, built from git, and its rows (`types/index.d.ts` declares it) |
| `ledger.ts` | The token ledger and cache misses the pane shows |
| `permission.ts` | Asking before reading beyond this conversation |
| `redact.ts` | Masking secrets |

## License

MIT. See [LICENSE](LICENSE).
