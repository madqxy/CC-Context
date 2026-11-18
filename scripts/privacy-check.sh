#!/bin/bash
# Pre-publish scan: the repo must carry no machine paths, no addresses and no
# credentials. Generic classes only — a scanner that names one person's user name
# would leak it itself.
#
#   bash scripts/privacy-check.sh      (or: npm run privacy)
#
# Exits 1 and lists every hit. Generated directories are skipped: the engine
# rewrites .claude-plugin/types/, and the mod's own snapshots live in
# .claude/cc-context/ (both are ignored and never shipped).

set -u
cd "$(dirname "$0")/.." || exit 2

EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=types
  --exclude-dir=cc-context
)

fail=0
check() {
  local label="$1"
  local pattern="$2"
  local allow="${3:-}"
  local hits
  hits=$(grep -rnIE "$pattern" . "${EXCLUDES[@]}" 2>/dev/null | grep -v '^./scripts/privacy-check.sh:')
  if [ -n "$allow" ]; then
    hits=$(echo "$hits" | grep -vE "$allow")
  fi
  hits=$(echo "$hits" | grep -v '^$' | head -20)
  if [ -n "$hits" ]; then
    echo "LEAK [$label]"
    echo "$hits" | sed 's/^/  /'
    fail=1
  else
    echo "ok   $label"
  fi
}

# Machine paths: a home directory with a real user name in it.
check 'absolute home path'   '/(home|Users)/[A-Za-z0-9._-]+/'
check 'windows user path'    '[A-Za-z]:\\+Users\\+'
# Addresses and credentials.
check 'email address'        '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
check 'private key'          'BEGIN [A-Z ]*PRIVATE KEY'
check 'cloud token'          '(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-|AKIA[0-9A-Z]{16})'
check 'assignment secret'    '(password|passwd|api[_-]?key|secret)[[:space:]]*[=:][[:space:]]*[^[:space:]]'
# Numbers that should not travel with code.
check 'phone number'         '(^|[^0-9])1[3-9][0-9]{9}([^0-9]|$)'
check 'id number'            '(^|[^0-9])[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]([^0-9]|$)'
# Loopback is not an address that identifies anybody: the live check binds one.
check 'ipv4 literal'         '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)' '127\.0\.0\.1|0\.0\.0\.0'

if [ "$fail" -ne 0 ]; then
  echo
  echo "privacy check failed: fix or exclude the lines above before publishing"
  exit 1
fi
echo
echo "privacy check passed"
