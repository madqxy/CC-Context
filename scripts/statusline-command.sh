#!/bin/bash
# CC-Context companion: a Claude Code status line that shows the same numbers
# as the band, but on the host's own status row.
#
# Install: copy this file somewhere, then point settings.json at it:
#   "statusLine": { "type": "command", "command": "bash $HOME/.claude/statusline-command.sh" }
# No mod data is needed: the host hands a status-line command the context
# window and the prompt-cache health on stdin, the same numbers /context uses.

input=$(cat)

# jq does the parsing; without it the line would be a row of empty segments.
if ! command -v jq >/dev/null 2>&1; then
  printf 'statusline: jq not found'
  exit 0
fi

model=$(echo "$input" | jq -r '.model.display_name')
dir=$(echo "$input" | jq -r '.workspace.current_dir')
dir_name=$(basename "$dir")

git_branch=""
if git -C "$dir" rev-parse --git-dir > /dev/null 2>&1; then
  branch=$(git -C "$dir" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    # $'...' puts a real ESC in the variable: this segment goes through %s,
    # which does not interpret backslash escapes.
    git_branch=" "$'\033[2m'"(${branch})"$'\033[0m'
  fi
fi

# k/M with just enough decimals to stay short.
fmt() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000) { v = n / 1000000; if (v == int(v)) printf "%dM", v; else printf "%.1fM", v }
    else if (n >= 1000) { v = n / 1000; if (v == int(v)) printf "%dk", v; else printf "%.1fk", v }
    else printf "%d", n
  }'
}

sep="\033[2m · \033[0m"
pct=$(echo "$input" | jq -r 'if .context_window.used_percentage != null then (.context_window.used_percentage | floor) else empty end')
used=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
cache=$(echo "$input" | jq -r 'if .prompt_cache.hit_ratio != null then (.prompt_cache.hit_ratio * 100 | floor) else empty end')

ctx=""
if [ -n "$pct" ] && [ -n "$used" ] && [ -n "$size" ]; then
  # The band's own colour ramp: green, yellow, magenta, red.
  if [ "$pct" -ge 90 ]; then colour="1;31"; elif [ "$pct" -ge 75 ]; then colour="1;35"; elif [ "$pct" -ge 50 ]; then colour="1;33"; else colour="1;32"; fi
  ctx="${sep}\033[${colour}m${pct}%\033[0m \033[2m$(fmt "$used")/$(fmt "$size")\033[0m"
  if [ -n "$cache" ]; then
    ctx="${ctx}${sep}\033[2mcache ${cache}%\033[0m"
  fi
fi

printf "\033[2m%s\033[0m%s%b\033[1;36m%s\033[0m%b" "$dir_name" "$git_branch" "$sep" "$model" "$ctx"