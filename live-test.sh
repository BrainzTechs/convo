#!/usr/bin/env bash
# convo live test: runs real Claude Code sessions with convo loaded and checks
# what lands in git. Covers turns, a compaction (keyframe), a fork, a rewind,
# a merge and a recall asked for in plain words, and a subagent merging back.
#
#   bash live-test.sh   (from the convo folder)
#
# Uses your normal Claude Code login. About 12 short prompts plus a few small
# Haiku calls. Works in a throwaway folder; nothing in your projects is touched.
set -u

MOD="$(cd "$(dirname "$0")" && pwd -P)"
WORK="$(mktemp -d)/convo-live"
mkdir -p "$WORK" && cd "$WORK" && WORK="$(pwd -P)"
# convo names a project's folder by its path plus a hash; the folder records the path in its cwd file
CONVO=""
REPO=""
locate() {
  [ -n "$CONVO" ] && return
  local f
  for f in "$HOME"/.claude/convo/*/cwd; do
    [ "$(cat "$f" 2>/dev/null)" = "$WORK" ] && CONVO="$(dirname "$f")" && REPO="$CONVO/repo.git" && return
  done
}

new_id() { (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z'; }
S="$(new_id)"
FORK="$(new_id)"

pass=0; fail=0; notes=()
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '  \033[36mINFO\033[0m %s\n' "$1"; }
ask()  {
  printf '\n\033[1m> %s\033[0m\n' "${*: -1}"
  claude -p --plugin-dir "$MOD" "$@" 2>&1 | tee "$WORK/.last-answer" | sed 's/^/  /'
  # A mod Claude Code refuses to load records nothing: every check after would fail for the same reason
  if grep -q 'hooks module did not load' "$WORK/.last-answer"; then
    bad "Claude Code did not load convo (the line above says why); stopping here"
    echo; echo "Result: $pass passed, $fail failed."; exit 1
  fi
}
turns_on() { git --git-dir="$REPO" ls-tree --name-only "$1" turns/ 2>/dev/null | wc -l | tr -d ' '; }
# Waits for convo's background committer (every 2 s) to empty the spool
settle() { locate; for _ in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(ls "$CONVO/spool/$1" 2>/dev/null)" ] && return; sleep 1; done; }

echo "convo live test"
echo "  Claude Code: $(claude --version 2>&1 | head -1)"
echo "  mod:         $MOD"
echo "  folder:      $WORK"
echo "  session:     $S"

# 0. convo against real git with a scripted model (no Claude Code session, no tokens): needs Node 22.6+ or Bun
echo; echo "0. Real-git scenarios (tests/e2e)"
E2E=""
if command -v bun >/dev/null 2>&1; then E2E="bun"
elif command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)'; then E2E="node --experimental-strip-types --no-warnings"
fi
if [ -n "$E2E" ]; then
  e2e_out=$($E2E "$MOD/tests/e2e/run.ts" 2>&1)
  printf '%s\n' "$e2e_out" | grep -E 'FAIL|kept for a look' | sed 's/^/  /'
  summary=$(printf '%s\n' "$e2e_out" | tail -1)
  case "$summary" in
    *" of "*" scenarios passed") n=${summary%% of*}; t=${summary#* of }; t=${t%% *}; [ "$n" = "$t" ] && ok "$summary" || bad "$summary" ;;
    *) bad "the scenarios did not run: $(printf '%s\n' "$e2e_out" | tail -3 | tr '\n' ' ')" ;;
  esac
else
  info "skipped: needs Node 22.6 or newer, or Bun"
fi

echo; echo "1. Three turns that set a decision, a pin and a task"
ask --session-id "$S" "We're designing a tiny Go service. Decision: call it 'ledgerd' and keep its config in /etc/ledgerd/config.toml. Please keep in mind for the rest of this chat: it must run on Go 1.23 only. Reply in one line, no tools."
ask --resume "$S" "Note a task for later: add a health endpoint at /healthz. Don't do it now. One line, no tools."
ask --resume "$S" "Second decision: logs go to stdout as JSON via zerolog. One line, no tools."
settle "$S"
n=$(turns_on "session/$S")
[ "$n" = 3 ] && ok "3 turns committed on session/$S" || bad "expected 3 turn commits, found $n"

echo; echo "2. Compaction"
DEBUG="$WORK/compact-debug.log"
ask --resume "$S" --debug-file "$DEBUG" "/compact"
settle "$S"
# convo writes one debug line saying what it did with the compaction, or why it left it native
grep -h 'convo' "$DEBUG" 2>/dev/null | sed -n 's/.*\(convo: .*\)/\1/p' | grep -E 'compacting natively|replaced the compaction|keyframe failed|session\.compact|left out a pin' | tail -5 | while read -r line; do info "$line"; done
ask --resume "$S" "Without using any tools, answer in one line: the service name, the config path, the Go version rule, the pending task, and where logs go."
settle "$S"
kf=$(git --git-dir="$REPO" log --format='%H %s' "session/$S" 2>/dev/null | grep ' keyframe [0-9]*: turns' | head -1 | cut -d' ' -f1)
if [ -z "$kf" ]; then
  bad "no keyframe commit was made (the INFO line above says why, if convo saw the compaction)"
else
  trigger=$(git --git-dir="$REPO" log -1 --format=%b "$kf" | sed -n 's/^Trigger: //p')
  native=$(git --git-dir="$REPO" log --format=%s "session/$S" | grep -c 'native summary')
  if [ "$trigger" = manual ] && [ "$native" = 0 ]; then
    ok "MAIN PATH: the keyframe replaced Claude Code's compaction summary"
  elif [ "$trigger" = held-back ]; then
    ok "keyframe built (fallback: this setup holds the compaction hook back, so it rode the next prompt beside the native summary)"
    notes+=("Your setup holds back installed mods' compaction hook (organization-managed Claude Code). The main path needs convo listed in managed settings' prependPlugins.")
  else
    info "keyframe commit with trigger '$trigger', native summaries: $native"
  fi
  git --git-dir="$REPO" tag --list "kf/$S/*" | grep -q . && ok "keyframe tagged ($(git --git-dir="$REPO" tag --list "kf/$S/*" | tr '\n' ' '))" || bad "keyframe not tagged"
  recs=$(git --git-dir="$REPO" show "session/$S:keyframe.md" 2>/dev/null)
  for want in "ledgerd" "1.23" "healthz" "zerolog"; do
    printf '%s' "$recs" | grep -qi "$want" && ok "keyframe records mention '$want'" || bad "keyframe records miss '$want'"
  done
fi

ask --resume "$S" "One more decision: the HTTP port is 8080. One line, no tools."
settle "$S"

echo; echo "3. Fork (--fork-session, the same as /branch)"
ask --resume "$S" --fork-session --session-id "$FORK" "In this branch only, we rename the service to 'ledgerx'. One line, no tools."
settle "$FORK"
from=$(git --git-dir="$REPO" log -1 --format=%b "session/$FORK" 2>/dev/null | sed -n 's/^Branched-From: //p')
[ -n "$from" ] && ok "fork got its own branch session/$FORK, Branched-From: $from" || bad "the fork's branch is missing or has no Branched-From"

echo; echo "4. Rewind (back to the answer before the port decision, as Esc Esc does)"
T=$(ls "$HOME"/.claude/projects/*/"$S".jsonl 2>/dev/null | head -1)
# The second-to-last answer: the turn before the port decision (a rewind cannot reach past a compaction)
back=$(grep '"type":"assistant"' "$T" 2>/dev/null | grep '"type":"text"' | tail -2 | head -1 | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$back" ]; then
  info "could not find that answer in the transcript; rewind skipped"
else
  ask --resume "$S" --resume-session-at "$back" "Let's go a different way: no port decision yet, and plain log package instead of zerolog. One line, no tools."
  settle "$S"
  kept=$(git --git-dir="$REPO" for-each-ref --format='%(refname:short)' "refs/heads/rewound/$S/" | head -1)
  [ -n "$kept" ] && ok "rewind kept the abandoned turns on $kept" || bad "no rewound/ branch after the rewind (if the line above says 'unknown option', your version lacks --resume-session-at; try Esc Esc by hand)"
fi

echo; echo "5. Merge, asked for in plain words"
# Merging reads another session, so it asks permission; a headless run grants it up front
ask --resume "$S" --allowedTools "mcp__convo__merge,mcp__convo__branches" --permission-mode default "Bring back what we worked out in the other branch, the one where we renamed the service, into this conversation. Then tell me in one line what came in and whether anything needs my decision."
settle "$S"
mc=$(git --git-dir="$REPO" log --merges --first-parent --format='%H %s' "session/$S" | grep ' merge: ' | head -1 | cut -d' ' -f1)
if [ -n "$mc" ]; then
  ok "Claude merged the fork: $(git --git-dir="$REPO" log -1 --format=%s "$mc")"
  [ "$(git --git-dir="$REPO" log -1 --format=%P "$mc" | wc -w | tr -d ' ')" = 2 ] && ok "the merge commit has two parents" || bad "the merge commit does not have two parents"
  info "$(git --git-dir="$REPO" log -1 --format=%b "$mc" | grep -E '^(Brought-In|Conflicts):' | tr '\n' ' ')"
  # The fork carried "port 8080", which this branch's rewind undid ("no port decision yet"): it must not come in as decided
  if git --git-dir="$REPO" show "$mc:keyframe.md" | sed -n '/^## Decisions/,/^## [^D]/p' | grep -q '8080'; then
    bad "the merge brought in port 8080 as a decision, though this branch's rewind left the port undecided"
  else
    ok "the abandoned port 8080 stayed out of this branch's decisions"
  fi
  # Whatever the merge raises about the port must be an open task too, not only words in the note
  mnote=$(git --git-dir="$REPO" ls-tree --name-only "$mc" merges/ | tail -1)
  if git --git-dir="$REPO" show "$mc:$mnote" | grep -q '8080'; then
    git --git-dir="$REPO" show "$mc:keyframe.md" | grep -E '^- \[ \] T[0-9]+ Decide:' | grep -q '8080' \
      && ok "the port question the merge raised is an open task" \
      || bad "the merge mentions port 8080 but left no open task to decide it"
  else
    info "the merge did not raise the port at all"
  fi
else
  bad "no merge commit (did Claude call the merge tool? see its answer above)"
fi

if [ -n "$mc" ]; then
  mk=$(git --git-dir="$REPO" show "$mc:keyframe.md")
  nq=$(printf '%s\n' "$mk" | grep -c '^- \[ \] T[0-9]* Decide:')
  [ "$nq" -le 2 ] && ok "only real contradictions became questions ($nq: the name and the port)" || bad "$nq questions; expected the name and the port only: $(printf '%s\n' "$mk" | grep 'Decide:' | tr '\n' ' ')"
  printf '%s\n' "$mk" | grep 'Decide:' | grep -q '(here' && ok "each question says which side is here and which is the other branch" || bad "the questions do not say where each side came from"
fi

echo; echo "5b. Answering the merge's questions closes them"
ask --resume "$S" "My decisions: keep the name ledgerd, and the HTTP port stays undecided for now. One line, no tools."
ask --resume "$S" "/compact"
ask --resume "$S" "Reply with just: noted"
settle "$S"
lk=$(git --git-dir="$REPO" show "session/$S:keyframe.md" 2>/dev/null)
open=$(printf '%s\n' "$lk" | grep -c '^- \[ \] T[0-9]* Decide:')
closed=$(printf '%s\n' "$lk" | grep -c '^- \[x\] T[0-9]* Decide:')
[ "$open" = 0 ] && [ "$closed" -ge 1 ] && ok "the questions are closed in the next keyframe ($closed done, none open)" || bad "after answering: $open questions still open, $closed closed"
printf '%s\n' "$lk" | sed -n '/^## Decisions/,/^## [^D]/p' | grep -qi 'ledgerd' && ok "the answer is recorded as a decision" || bad "no decision records the chosen name"
nrw=$(git --git-dir="$REPO" for-each-ref --format='%(refname)' "refs/heads/rewound/$S/" | wc -l | tr -d ' ')
[ "$nrw" = 1 ] && ok "the compaction did not pass for a rewind (one rewound line: the real one)" || bad "$nrw rewound lines; the compaction's kept turns were taken for a rewind"
git --git-dir="$REPO" log --first-parent --format=%s "session/$S" | grep -q '^keyframe [0-9]*: turns' && ok "the keyframe is on the session's own line" || bad "the latest keyframe is not on the session's line"

echo; echo "6. Recall, asked for in plain words (default permission mode: this branch needs no approval)"
PERMLOG="$WORK/permission-debug.log"
ask --resume "$S" --permission-mode default --debug-file "$PERMLOG" "Search our history and tell me, in one line, the exact config path I gave in my very first message."
T=$(ls "$HOME"/.claude/projects/*/"$S".jsonl 2>/dev/null | head -1)
used=$(grep -o '"type":"tool_use","id":"[^"]*","name":"mcp__convo__\(recall\|turn\)"' "$T" 2>/dev/null | tail -1 | sed 's/.*mcp__convo__//; s/"$//')
[ -n "$used" ] && ok "Claude looked it up in the history with the $used tool" || bad "Claude did not use convo's recall or turn tool"

echo; echo "6b. Reading other conversations asks you first (a run with nobody to ask declines it)"
ask --resume "$S" --permission-mode default --debug-file "$PERMLOG" "Use the convo recall tool with branch set to \"all\" to search for the word ledgerx. Then say in one line whether it ran or was blocked."
rid=$(grep -o '"id":"[^"]*","name":"mcp__convo__recall","input":{[^}]*"branch":"all"' "$T" 2>/dev/null | tail -1 | cut -d'"' -f4)
if [ -z "$rid" ]; then
  info "Claude did not try a recall across all branches"
elif grep -F "\"tool_use_id\":\"$rid\"" "$T" | grep -q '"is_error":true'; then
  ok "recall across other sessions waited for your word: $(grep -F "\"tool_use_id\":\"$rid\"" "$T" | grep -o 'needs the person[^:]*' | head -1)"
else
  bad "recall across other sessions ran without asking"
fi
# What convo's permission hook saw and answered, from the debug log (no line means it did not run)
pl=$(grep -h 'convo: permission for' "$PERMLOG" 2>/dev/null | sed 's/.*\(convo: permission for.*\)/\1/' | sort -u)
if [ -n "$pl" ]; then printf '%s\n' "$pl" | while read -r line; do info "$line"; done; else info "convo's permission hook left no line in the debug log: it did not run"; fi


echo; echo "6c. An allow rule you set lets it run without asking"
ask --resume "$S" --allowedTools "mcp__convo__recall" --permission-mode default "Use the convo recall tool with branch set to \"all\" to search for the word zerolog. Then say in one line whether it ran or was blocked."
rid=$(grep -o '"id":"[^"]*","name":"mcp__convo__recall","input":{[^}]*"branch":"all"' "$T" 2>/dev/null | tail -1 | cut -d'"' -f4)
if [ -z "$rid" ]; then
  info "Claude did not try a recall across all branches"
elif grep -F "\"tool_use_id\":\"$rid\"" "$T" | grep -q '"is_error":true'; then
  bad "recall across other sessions was refused despite the allow rule"
else
  ok "with mcp__convo__recall allowed, recall across other sessions ran"
fi

echo; echo "7. A subagent's branch merges back on its own"
ask --resume "$S" "Use the Agent tool to have a general-purpose subagent answer: what is 17 times 23? Wait for it, then give me its answer in one line."
# A headless run exits right after its turn; the next session commits what the exit left in the spool
ask --resume "$S" "Reply with just: ok"
settle "$S"
am=$(git --git-dir="$REPO" log -3 --format='%H %P' "session/$S" | awk 'NF>=3 {print $1; exit}')
[ -n "$am" ] && git --git-dir="$REPO" log -1 --format=%b "$am" | grep -q '^Merged-Agents:' && ok "the turn that ran the subagent merged its branch: $(git --git-dir="$REPO" log -1 --format=%s "$am")" || bad "the subagent's branch was not merged into its turn"

echo; echo "History:"
git --git-dir="$REPO" log --all --graph --format='%h %d %s' 2>/dev/null | sed 's/^/  /'
echo; echo "Keyframe Claude read:"
git --git-dir="$REPO" show "session/$S:keyframe.md" 2>/dev/null | sed -n '1,30p' | sed 's/^/  /'

echo
for n in "${notes[@]+"${notes[@]}"}"; do echo "Note: $n"; done
echo "Result: $pass passed, $fail failed."
echo "Repo: $REPO"
[ "$fail" = 0 ]
