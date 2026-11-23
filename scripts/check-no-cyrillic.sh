#!/usr/bin/env bash
# Fails if any tracked or untracked (non-ignored) file except ASSIGNMENT.md contains Cyrillic characters.
set -euo pipefail
cd "$(dirname "$0")/.."
bad=0
while IFS= read -r f; do
  [ "$f" = "ASSIGNMENT.md" ] && continue
  [ -f "$f" ] || continue
  if grep -qP '[\x{0400}-\x{04FF}]' "$f" 2>/dev/null; then
    echo "Cyrillic found in: $f"
    bad=1
  fi
done < <(git ls-files --cached --others --exclude-standard)
exit $bad
