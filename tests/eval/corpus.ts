// The conversation the recall eval searches: about 130 turns of building a
// small Go ledger service, with facts planted at known turns among filler
// that reads like real work (file dumps, test runs, logs) and shares their
// words. Some facts change later (the latest is the answer), some appear only
// in tool output or a subagent's turn, one only on a fork, and some questions
// use words the conversation never did.

import type { World } from '../e2e/harness.ts'

export const MAIN = 'eva10000-0000-4000-8000-00000000000a'
export const FORK = 'eva20000-0000-4000-8000-00000000000b'
export const AGENT = 'agentrecon01'

type Tool = { name: string; input: unknown; output: string }
type Step = { prompt: string; answer: string; tools?: Tool[]; agents?: { id: string; prompt: string; answer: string }[] }

/** Where an answer lives: a turn of the main session, of the fork, or of the subagent. */
export type Where = { turn: number; on?: 'fork' | 'agent' }

export type Question = {
  id: string
  /** What the person asks, in their words. */
  ask: string
  kind: 'plain' | 'latest' | 'tool-output' | 'answer-only' | 'paraphrase' | 'subagent' | 'fork'
  /** Words a model might hand recall for it, tersest first. */
  queries: string[]
  /** Any of these turns holds the answer (for "latest", only the newest). */
  expect: Where[]
  /** Text the answer must contain (for the live run): any case, any wording around it. */
  answer: RegExp
  branch?: 'all'
}

// ── Filler ──────────────────────────────────────────────────────────────

/** A small deterministic random source, so every run builds the same conversation. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const CONFIG_DUMP = `# example config shipped with the dev container
[server]
port = 3000
read_timeout = "30s"
write_timeout = "30s"

[database]
url = "postgres://dev:dev@localhost:5432/dev"
max_conns = 10
statement_timeout = "30s"

[log]
level = "debug"
format = "text"

[retry]
attempts = 3
`

const COMPOSE = `services:
  db:
    image: postgres:15
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD", "pg_isready"]
      timeout: 5s
      retries: 5
  cache:
    image: redis:7
    ports: ["6379:6379"]
`

const GO_SNIPPETS = [
  `func (s *Server) routes() {\n\ts.mux.HandleFunc("/v1/accounts", s.handleAccounts)\n\ts.mux.HandleFunc("/v1/transfers", s.handleTransfers)\n\tlog.Printf("routes ready on port %d", s.cfg.Port)\n}`,
  `func retry(ctx context.Context, n int, f func() error) error {\n\tvar err error\n\tfor i := 0; i < n; i++ {\n\t\tif err = f(); err == nil {\n\t\t\treturn nil\n\t\t}\n\t\ttime.Sleep(100 * time.Millisecond)\n\t}\n\treturn err\n}`,
  `type Config struct {\n\tPort int\n\tDatabaseURL string\n\tTimeout time.Duration\n\tLogLevel string\n}`,
  `func (r *Repo) Balance(ctx context.Context, id AccountID) (int64, error) {\n\tvar b int64\n\terr := r.db.QueryRow(ctx, "select balance from accounts where id = $1", id).Scan(&b)\n\treturn b, err\n}`,
  `// handleTransfers moves money between two accounts in one database transaction.\nfunc (s *Server) handleTransfers(w http.ResponseWriter, r *http.Request) {\n\tctx, cancel := context.WithTimeout(r.Context(), s.cfg.Timeout)\n\tdefer cancel()\n}`,
]

const TEST_RUN = (r: () => number): string => {
  const names = ['TestTransfer', 'TestBalance', 'TestAccounts', 'TestConfigLoad', 'TestRetry', 'TestRoutes', 'TestMigrate']
  return names.map(n => `--- PASS: ${n} (0.${Math.floor(r() * 90 + 10)}s)`).join('\n') + '\nok  \tgithub.com/acme/ledgerd/internal\t1.2s'
}

const FILLER_PROMPTS = [
  'Read internal/server/routes.go and tell me what it registers.',
  'Run the tests.',
  'Show me the dev config file.',
  'What does the docker compose file start?',
  'Tidy up the imports in internal/ledger.',
  'Read the Config struct.',
  'Run go vet.',
  'Look at how Balance queries the database.',
  'Rename handleAccounts to listAccounts.',
  'Add a comment to handleTransfers.',
  'Check the git status.',
  'Format the code.',
]

function filler(i: number, r: () => number): Step {
  const p = FILLER_PROMPTS[i % FILLER_PROMPTS.length] ?? 'Carry on.'
  const pick = Math.floor(r() * 4)
  const tools: Tool[] =
    pick === 0 ? [{ name: 'Read', input: { file_path: 'config/dev.toml' }, output: CONFIG_DUMP }]
    : pick === 1 ? [{ name: 'Bash', input: { command: 'go test ./...' }, output: TEST_RUN(r) }]
    : pick === 2 ? [{ name: 'Read', input: { file_path: 'docker-compose.yml' }, output: COMPOSE }]
    : [{ name: 'Read', input: { file_path: 'internal/server/server.go' }, output: GO_SNIPPETS[Math.floor(r() * GO_SNIPPETS.length)] ?? '' }]
  return { prompt: p, answer: 'Done; nothing else changed.', tools }
}

// ── The planted facts, by turn ──────────────────────────────────────────

/** Turn number → what that turn is. Every other turn up to TURNS is filler. */
const PLANTED: Record<number, Step> = {
  1: { prompt: "We're building ledgerd, a small Go ledger service. Please keep in mind for the whole project: it must build with Go 1.23, nothing newer.", answer: 'Noted: ledgerd targets Go 1.23.' },
  2: { prompt: 'Config lives in /etc/ledgerd/config.toml in production.', answer: 'Noted: production config at /etc/ledgerd/config.toml.' },
  3: { prompt: 'Logs go to stdout as JSON via zerolog.', answer: 'Noted: zerolog, JSON on stdout.' },
  4: { prompt: 'Later we need a health endpoint at /healthz. Not now.', answer: 'Noted as a task for later.' },
  5: { prompt: 'The HTTP port is 8080.', answer: 'Noted: ledgerd serves HTTP on 8080.' },
  8: { prompt: 'Use Postgres 16 with pgx directly, no ORM.', answer: 'Noted: Postgres 16 through pgx, no ORM.' },
  15: { prompt: 'How should we retry calls to the card processor?', answer: 'I suggest exponential backoff starting at 200ms, doubling, at most 5 attempts, with jitter.' },
  16: { prompt: 'Go with that.', answer: 'Done: the processor client retries with exponential backoff from 200ms, 5 attempts, jitter.' },
  22: {
    prompt: 'Run the tests with the race detector.',
    answer: 'One test failed under the race detector; I will look at it.',
    tools: [{ name: 'Bash', input: { command: 'go test -race ./...' }, output: '--- FAIL: TestLedgerBalance (0.31s)\nWARNING: DATA RACE\nWrite at 0x00c000124 by goroutine 12:\n  ledger.(*Book).post() book.go:88\nPrevious read by goroutine 9:\n  ledger.(*Book).Balance() book.go:52\n  the race is on accountMu, which Balance reads without holding\nFAIL\tgithub.com/acme/ledgerd/internal/ledger\t1.9s' }],
  },
  30: { prompt: 'Rate limit the public API at 100 requests per minute per API key.', answer: 'Noted: 100 req/min per API key.' },
  33: { prompt: 'Services talk to each other over mTLS; external clients use JWT bearer tokens.', answer: 'Noted: mTLS inside, JWT for clients.' },
  40: { prompt: 'Change of plan on logging: drop zerolog and use the standard library log/slog with its JSON handler.', answer: 'Switched to log/slog with slog.NewJSONHandler; zerolog removed.' },
  45: { prompt: 'Use goose for database migrations, files under db/migrations.', answer: 'Noted: goose, migrations in db/migrations.' },
  50: { prompt: 'We deploy to Fly.io, region sin (Singapore).', answer: 'Noted: Fly.io, region sin.' },
  55: { prompt: 'Money amounts are stored as int64 minor units. Never floats.', answer: 'Noted: amounts are int64 minor units (cents), never float64.' },
  60: { prompt: 'Move the HTTP port to 9090; 8080 clashes with the sidecar.', answer: 'Changed: ledgerd now serves HTTP on 9090.' },
  70: {
    prompt: 'Have a subagent find out why the reconciliation job is slow.',
    answer: 'The subagent found it: an N+1 query in ReconcileAccounts.',
    agents: [{ id: AGENT, prompt: 'Find out why the nightly reconciliation job takes so long.', answer: 'ReconcileAccounts runs one query per account (an N+1 pattern), about 40s for 9,000 accounts; batching by 500 brings it under 2s.' }],
  },
  80: { prompt: 'Alerts go to the Slack channel #ledger-alerts.', answer: 'Noted: alerts to #ledger-alerts.' },
  85: { prompt: 'Request timeout is 3s at the edge; the database statement timeout is 1s.', answer: 'Noted: 3s request timeout, 1s statement timeout.' },
  90: { prompt: 'Now implement the /healthz endpoint; have it return the build sha.', answer: 'Implemented /healthz: it returns 200 with the build sha from -ldflags.' },
  95: { prompt: 'Error responses carry codes like LEDGER_INSUFFICIENT_FUNDS and LEDGER_ACCOUNT_FROZEN.', answer: 'Noted: LEDGER_* error codes in responses.' },
  100: { prompt: 'Idempotency keys are kept for 24 hours in Redis.', answer: 'Noted: idempotency keys, 24h TTL, in Redis.' },
  110: { prompt: 'Releases are tagged vMAJOR.MINOR.PATCH and built by GitHub Actions.', answer: 'Noted: semver tags, GitHub Actions builds.' },
}

/** How many turns the main session has. */
export const TURNS = 130

/** The turn the fork splits after, and what it tries. */
const FORK_AT = 46
const FORK_STEPS: Step[] = [
  { prompt: 'In this branch, try sqlc instead of hand-written pgx queries.', answer: 'Generated the queries with sqlc.' },
  { prompt: 'sqlc cannot express our dynamic filters; we reject sqlc and stay on pgx.', answer: 'Noted: sqlc rejected because of the dynamic filters; back to pgx.' },
]

/** Builds the conversation in `w`: the main session, a fork at FORK_AT, a subagent at turn 70. */
export async function build(w: World): Promise<void> {
  const r = rng(7)
  await w.start(MAIN)
  for (let n = 1; n <= TURNS; n++) {
    const s = PLANTED[n] ?? filler(n, r)
    await w.turn(s.prompt, s.answer, { tools: s.tools, agents: s.agents })
    if (n % 10 === 0) await w.timers()
    if (n === FORK_AT) {
      await w.timers()
      await w.fork(FORK)
      await w.start(FORK)
      for (const f of FORK_STEPS) await w.turn(f.prompt, f.answer)
      await w.timers()
      await w.resume(MAIN)
    }
  }
  await w.timers()
}

export const QUESTIONS: Question[] = [
  { id: 'go-version', kind: 'plain', ask: 'Which Go version does ledgerd have to build with?', queries: ['go version', 'Go 1.23', 'build with Go'], expect: [{ turn: 1 }], answer: /1\.23/ },
  { id: 'config-path', kind: 'plain', ask: 'Where does the production config file live?', queries: ['config path', 'production config', 'config file location'], expect: [{ turn: 2 }], answer: /\/etc\/ledgerd\/config\.toml/ },
  { id: 'port', kind: 'latest', ask: 'What HTTP port did we end up on?', queries: ['port', 'HTTP port', 'port change'], expect: [{ turn: 60 }], answer: /9090/ },
  { id: 'logging', kind: 'latest', ask: 'Which logging library are we using now?', queries: ['logging', 'logging library', 'zerolog slog'], expect: [{ turn: 40 }], answer: /slog/i },
  { id: 'database', kind: 'plain', ask: 'Which database and driver did we pick?', queries: ['database driver', 'pgx', 'Postgres'], expect: [{ turn: 8 }], answer: /pgx/i },
  { id: 'retry', kind: 'answer-only', ask: 'What retry policy did we agree for the card processor?', queries: ['retry', 'retry policy', 'card processor retry backoff'], expect: [{ turn: 15 }, { turn: 16 }], answer: /200 ?ms/ },
  { id: 'flaky', kind: 'tool-output', ask: 'Which test failed under the race detector, and why?', queries: ['race detector', 'data race', 'TestLedgerBalance'], expect: [{ turn: 22 }], answer: /TestLedgerBalance|accountMu/ },
  { id: 'rate-limit', kind: 'plain', ask: 'What is the rate limit on the public API?', queries: ['rate limit', 'requests per minute', 'API rate limit'], expect: [{ turn: 30 }], answer: /100/ },
  { id: 'auth', kind: 'plain', ask: 'How do services and clients authenticate?', queries: ['auth', 'authentication', 'mTLS JWT'], expect: [{ turn: 33 }], answer: /mTLS/i },
  { id: 'migrations', kind: 'plain', ask: 'Which migration tool do we use?', queries: ['migrations', 'migration tool', 'goose'], expect: [{ turn: 45 }], answer: /goose/i },
  { id: 'deploy', kind: 'plain', ask: 'Where do we deploy, and which region?', queries: ['deploy', 'deployment region', 'Fly.io'], expect: [{ turn: 50 }], answer: /\bsin\b|Singapore/i },
  { id: 'currency', kind: 'paraphrase', ask: 'How do we represent currency values?', queries: ['currency', 'money amounts', 'int64 minor units float'], expect: [{ turn: 55 }], answer: /int64|minor units/i },
  { id: 'reconcile', kind: 'subagent', ask: 'Why was the reconciliation job slow?', queries: ['reconciliation slow', 'reconciliation', 'N+1 ReconcileAccounts'], expect: [{ turn: 70 }, { turn: 1, on: 'agent' }], answer: /N\+1|one query per account/i },
  { id: 'alerts', kind: 'plain', ask: 'Which Slack channel do alerts go to?', queries: ['alerts channel', 'Slack channel', 'alerts'], expect: [{ turn: 80 }], answer: /#ledger-alerts/ },
  { id: 'timeout', kind: 'plain', ask: 'What is the request timeout at the edge?', queries: ['timeout', 'request timeout', 'statement timeout'], expect: [{ turn: 85 }], answer: /\b3 ?s\b|\b3 seconds/i },
  { id: 'healthz', kind: 'latest', ask: 'Did we ever implement the health endpoint, and what does it return?', queries: ['healthz', 'health endpoint', 'implement /healthz'], expect: [{ turn: 90 }], answer: /\bsha\b/i },
  { id: 'error-codes', kind: 'plain', ask: 'What do our error codes look like?', queries: ['error codes', 'error code', 'INSUFFICIENT_FUNDS'], expect: [{ turn: 95 }], answer: /LEDGER_/ },
  { id: 'idempotency', kind: 'plain', ask: 'How long are idempotency keys kept?', queries: ['idempotency', 'idempotency keys', 'idempotency key TTL'], expect: [{ turn: 100 }], answer: /24/ },
  { id: 'releases', kind: 'paraphrase', ask: 'How do we version and ship builds?', queries: ['versioning', 'release tags', 'GitHub Actions'], expect: [{ turn: 110 }], answer: /semver|vMAJOR|GitHub Actions/i },
  { id: 'sqlc', kind: 'fork', ask: 'Did we ever try sqlc, and what happened?', queries: ['sqlc', 'sqlc rejected', 'tried sqlc'], expect: [{ turn: FORK_AT + 2, on: 'fork' }, { turn: FORK_AT + 1, on: 'fork' }], answer: /reject|dynamic filters/i, branch: 'all' },
]
