#!/usr/bin/env bash
# ACC-2: typecheck, lint, generated client unchanged, tests, build (the exact CI commands).
. "$(dirname "$0")/lib.sh"
bash scripts/ci-local.sh && pass "scripts/ci-local.sh (same commands as .github/workflows/ci.yml)"
