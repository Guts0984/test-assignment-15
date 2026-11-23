#!/usr/bin/env bash
# Shared helpers for the acceptance scripts. Each script prints PASS/FAIL lines and exits non-zero on failure.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
set -a; [ -f .env ] && . ./.env; set +a
COMPOSE_TEST=(docker compose -f docker-compose.yml -f docker-compose.test.yml)
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
stack_vitest() { (cd apps/api && pnpm exec vitest run -c vitest.stack.config.ts "$@"); }
