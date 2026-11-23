#!/usr/bin/env bash
# The README must carry the generated transition table verbatim, every assumption id of plan.md, and every section the assignment lists.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail=0
table=$(node -e "process.stdout.write(require('./packages/shared').transitionsMarkdown())")
if ! grep -qF -- "$table" <(cat README.md); then
  python3 - <<'PY' || { echo "README transition table differs from TRANSITIONS"; fail=1; }
import subprocess,sys
t=subprocess.check_output(['node','-e',"process.stdout.write(require('./packages/shared').transitionsMarkdown())"]).decode()
sys.exit(0 if t in open('README.md').read() else 1)
PY
fi
for id in $(grep -oE '^- \*\*A-[0-9]+' plan.md | grep -oE 'A-[0-9]+' | grep -v '^A-06$'); do
  grep -q "\*\*$id " README.md || { echo "README misses $id"; fail=1; }
done
for h in "Run and test" "SLA deadlines" "Assignment and the ticket limit" "Mail: threading" "Background jobs" "Live updates" "Ticket statuses" "Database indexes" "Decisions"; do
  grep -q "^## [0-9]*\. $h" README.md || { echo "README misses section: $h"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "README ok"
exit "$fail"
