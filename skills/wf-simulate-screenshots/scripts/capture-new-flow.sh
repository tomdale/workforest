#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-/tmp/wf-simulate-new-ui-states}"
cols="${WF_SCREENSHOT_COLS:-120}"
rows="${WF_SCREENSHOT_ROWS:-40}"
speed="${WF_SCREENSHOT_SPEED:-slow}"

if command -v betamax >/dev/null 2>&1; then
  betamax_bin="$(command -v betamax)"
elif [[ -x /tmp/betamax/betamax ]]; then
  betamax_bin="/tmp/betamax/betamax"
else
  echo "betamax not found. Put betamax on PATH or clone it to /tmp/betamax." >&2
  exit 1
fi

for dep in tmux termshot pnpm; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "$dep is required for wf simulator screenshots." >&2
    exit 1
  fi
done

keys_file="$(mktemp "${TMPDIR:-/tmp}/wf-simulate-new.XXXXXX.keys")"
trap 'rm -f "$keys_file"' EXIT

cat >"$keys_file" <<'KEYS'
@sleep:4000
@capture:01-select-template.png
Down
Down
@sleep:500
@capture:02-manual-option.png
Enter
@sleep:500
@capture:03-repos-empty.png
vercel/api, vercel/front, vercel/agents
@sleep:500
@capture:04-repos-typed.png
Enter
@sleep:500
@capture:05-feature-empty.png
Build screenshot automation
@sleep:300
@capture:06-feature-description.png
Enter
@sleep:250
@capture:07-generating-feature-name.png
@sleep:1200
@capture:08-summary-before-setup.png
@sleep:1200
@capture:09-setup-grid-running.png
@sleep:1600
@capture:10-setup-grid-progress.png
@wait:Press any key for next steps
@capture:11-setup-complete-prompt.png
Space
@sleep:1000
@capture:12-final-next-steps.png
KEYS

mkdir -p "$output_dir"

"$betamax_bin" \
  --cols "$cols" \
  --rows "$rows" \
  -d 100 \
  -o "$output_dir" \
  "NCURSES_NO_UTF8_ACS=1 LANG=en_US.UTF-8 pnpm exec tsx bin/workforest.js dev simulate new --speed ${speed}; sleep 5" \
  -f "$keys_file"

file "$output_dir"/*.png
