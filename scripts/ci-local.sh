#!/usr/bin/env bash
# Runs exactly the commands of .github/workflows/ci.yml (jobs that exist at this point), locally.
# Usage: scripts/ci-local.sh [--with-integration]
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==== %s ====\n' "$1"; }

step "install (frozen lockfile)"
pnpm install --frozen-lockfile

step "start postgres and redis (CI uses service containers)"
docker compose up -d --wait postgres redis

step "build shared packages"
pnpm --filter @helpdesk/shared build
pnpm --filter @helpdesk/core build

step "typecheck"
pnpm typecheck

step "lint"
pnpm lint

if [ -f scripts/openapi-diff.sh ]; then
  step "openapi client diff"
  bash scripts/openapi-diff.sh
fi

step "unit tests"
pnpm test

step "build"
pnpm build

echo
echo "ci-local: ALL GREEN"
