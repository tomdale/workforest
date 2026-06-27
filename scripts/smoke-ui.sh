#!/usr/bin/env bash
#
# Smoke-test the workforest terminal UI.
#
# Runs every read-only command so you can eyeball the unified theme (red title,
# cyan section headers, ✓/✗/▲/⊘/○ status glyphs, muted labels) in a real
# terminal, sanity-checks the --json paths still parse, exercises the empty-state
# rendering in an isolated config, and (with --tui) drives the fullscreen setup
# grid through tmux.
#
# Read-only: it never creates, deletes, syncs, finishes, or applies a migration
# (--apply is never passed). Safe to run against your real workspace.
#
# Usage:
#   scripts/smoke-ui.sh            # static + json + empty-state checks
#   scripts/smoke-ui.sh --tui      # also capture the fullscreen grid via tmux
#   WF="node bin/workforest.js" scripts/smoke-ui.sh   # override the CLI entry
#
# Colors only render when stdout is a real terminal; pipe to a file and you get
# clean, glyph-only output (the same contract the CLI uses everywhere).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Run from source by default so a stale dist/ can't mask a regression.
WF="${WF:-node bin/workforest.js}"
export WORKFOREST_USE_SOURCE_CLI="${WORKFOREST_USE_SOURCE_CLI:-1}"
export FORCE_COLOR="${FORCE_COLOR:-3}"

ok=0
warn=0
json_broken=0

hr() { printf '\n\033[2m────────────────────────────────────────────────────\033[0m\n'; }

# run <label> <wf args...> — show a command's output; non-zero is a soft warning
# (e.g. `cache doctor` exits 1 on an unhealthy cache, which is not a UI fault).
run() {
  local label="$1"
  shift
  hr
  printf '\033[1m$ wf %s\033[0m  \033[2m— %s\033[0m\n\n' "$*" "$label"
  if $WF "$@"; then
    ok=$((ok + 1))
  else
    printf '\n\033[33m  ↳ exited %d (inspect above)\033[0m\n' "$?"
    warn=$((warn + 1))
  fi
}

# json <wf args...> — assert the machine-readable variant still emits valid JSON.
json() {
  hr
  printf '\033[1m$ wf %s\033[0m  \033[2m— json parses?\033[0m\n' "$*"
  if $WF "$@" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s);process.stdout.write("  \x1b[32m✓ valid JSON\x1b[0m\n")}catch(e){process.stdout.write("  \x1b[31m✗ "+e.message+"\x1b[0m\n");process.exit(1)}})'; then
    ok=$((ok + 1))
  else
    json_broken=1
  fi
}

# Pull live selectors from the inventory so `status`/`cache show` hit real targets.
first_change="$($WF list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).data;const e=(j.workspaces[0]||j.repositories[0]);process.stdout.write(e?e.selector:"")}catch{}})')"
first_repo="$($WF cache list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).data;process.stdout.write(j[0]?(j[0].name||""):"")}catch{}})')"

printf '\033[1mworkforest UI smoke test\033[0m  (%s)\n' "$WF"
printf 'first change: \033[36m%s\033[0m   first cached repo: \033[36m%s\033[0m\n' \
  "${first_change:-<none>}" "${first_repo:-<none>}"

# ---- static, read-only surfaces ----
run "root help" --help
run "version" version
run "change list" list
run "change list (+paths)" list --paths
[ -n "$first_change" ] && run "change status" status "$first_change"
run "cache list" cache list
[ -n "$first_repo" ] && run "cache show" cache show "$first_repo"
run "cache doctor" cache doctor
run "ai status" ai status
run "task list" task list
run "template list" template list
run "skills list" skills list
run "config show" config show
run "migrate plan (no --apply)" migrate workspaces

# ---- machine output still parses ----
json list --json
json cache list --json
[ -n "$first_change" ] && json status "$first_change" --json
json ai status --json

# ---- empty-state rendering in an isolated config ----
hr
printf '\033[1mEmpty states\033[0m (isolated config dir)\n'
if TMP="$(mktemp -d 2>/dev/null)"; then
  printf '{"directory":{"base":"%s/base"}}' "$TMP" >"$TMP/config.json"
  export WORKFOREST_CONFIG_DIR="$TMP"
  run "list (empty)" list
  run "cache list (empty)" cache list
  run "template list (empty)" template list
  unset WORKFOREST_CONFIG_DIR
  rm -rf "$TMP"
else
  printf '  \033[33mcould not create a temp dir; skipping\033[0m\n'
fi

# ---- optional fullscreen TUI (needs a real PTY) ----
if [ "${1:-}" = "--tui" ]; then
  hr
  printf '\033[1mFullscreen setup grid\033[0m (tmux PTY)\n'
  if ! command -v tmux >/dev/null 2>&1; then
    printf '  \033[33mtmux not found; skipping\033[0m\n'
  else
    tmux kill-session -t wf-smoke 2>/dev/null
    tmux new-session -d -s wf-smoke -x 120 -y 40
    tmux send-keys -t wf-smoke \
      "cd $ROOT && WORKFOREST_USE_SOURCE_CLI=1 pnpm exec tsx bin/workforest.js dev simulate new --speed fast" Enter
    sleep 4
    tmux capture-pane -t wf-smoke -p
    tmux kill-session -t wf-smoke 2>/dev/null
    printf '\n  \033[2m(re-run `tmux attach -t wf-smoke` manually to interact)\033[0m\n'
  fi
fi

hr
printf '\033[1mSummary:\033[0m %d ok, %d non-zero exit(s)' "$ok" "$warn"
if [ "$json_broken" -ne 0 ]; then
  printf '  \033[31m— JSON output broke\033[0m\n'
  exit 1
fi
printf '\n'
