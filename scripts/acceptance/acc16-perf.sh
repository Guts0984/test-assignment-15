#!/usr/bin/env bash
# ACC-16 (speed): search < 300 ms, queue < 200 ms, 90-day report < 1 s on the FULL seed (default compose profile).
. "$(dirname "$0")/lib.sh"
(cd apps/api && pnpm exec vitest run -c vitest.perf.config.ts) && pass "performance budgets on the full seed"
