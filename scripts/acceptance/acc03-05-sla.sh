#!/usr/bin/env bash
# ACC-3, 4, 5: SLA arithmetic (Friday 16:00 Kyiv, DST + holiday, two paused hours) as exact-instant unit tests.
. "$(dirname "$0")/lib.sh"
(cd packages/shared && pnpm exec vitest run src/sla/sla.spec.ts -t "acceptance checks" ) && pass "ACC-3, ACC-4 and ACC-5 deadlines are exact"
