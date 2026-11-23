#!/usr/bin/env bash
# Mutation check: temporarily disable (a) the permission guards, (b) an input validator, (c) the agent-limit guard,
# and require the matching tests to FAIL. The code is restored (git checkout) after every mutation.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=${1:-/tmp/mutation.log}
: > "$LOG"
fails=0

mutate() { # name file python-edit test-command...
  local name="$1" file="$2" edit="$3"; shift 3
  echo "=== MUTATION: $name ($file)" | tee -a "$LOG"
  python3 - "$file" "$edit" <<'EOF'
import sys
path, edit = sys.argv[1], sys.argv[2]
old, new = edit.split('=>>', 1)
s = open(path).read()
if old not in s:
    sys.exit('pattern not found: ' + old)
open(path, 'w').write(s.replace(old, new, 1))
EOF
  if [ $? -ne 0 ]; then echo "could not apply the mutation" | tee -a "$LOG"; git checkout -- "$file"; fails=$((fails+1)); return; fi
  if "$@" >> "$LOG" 2>&1; then
    echo "RESULT: tests still PASS with the protection removed  <-- BAD" | tee -a "$LOG"; fails=$((fails+1))
  else
    echo "RESULT: tests FAIL as required (protection is covered)" | tee -a "$LOG"
  fi
  git checkout -- "$file"
}

API=apps/api
mutate "a1: ticket access guard allows every ticket" "$API/src/modules/tickets/tickets.service.ts" \
  "const allowed =
        b !== null &&=>>const allowed = true || b !== null &&" \
  bash -c "cd $API && pnpm exec vitest run test/adversarial/access.adv.spec.ts test/realtime.int.spec.ts"

mutate "a2: admin role check removed from the auth guard" "$API/src/common/auth/auth.guard.ts" \
  "if (access === 'admin' && principal.kind !== 'admin')=>>if (false && access === 'admin' && principal.kind !== 'admin')" \
  bash -c "cd $API && pnpm exec vitest run test/adversarial/route-table.adv.spec.ts test/adversarial/tokens.adv.spec.ts"

mutate "b: strict() removed from the note input (mass assignment) and the length cap from reply bodies" "packages/shared/src/schemas/inputs.ts" \
  "export const noteInput = z.object({ body: multiLineText(LIMITS.noteMax) }).strict();=>>export const noteInput = z.object({ body: multiLineText(LIMITS.noteMax) });" \
  bash -c "cd $API && pnpm exec vitest run test/adversarial/access.adv.spec.ts"

mutate "c: agent limit check removed from the load trigger" "packages/core/prisma/migrations/20260101000100_guards/migration.sql" \
  "WHERE id = agent AND open_count < ticket_limit;=>>WHERE id = agent;" \
  bash -c "cd packages/core && pnpm exec vitest run test/schema-constraints.int.spec.ts test/assignment.int.spec.ts"

echo
if [ "$fails" -eq 0 ]; then echo "MUTATION CHECK: every mutation was caught"; else echo "MUTATION CHECK: $fails mutation(s) NOT caught"; fi
exit "$fails"
