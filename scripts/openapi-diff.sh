#!/usr/bin/env bash
# Regenerates apps/api/openapi.json and the web client, then fails if they differ from what is committed
# (in CI) or staged (locally: stage the generated files first, as scripts/ci-local.sh does).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
PATHS="apps/api/openapi.json apps/web/src/shared/api/generated"
pnpm --filter @helpdesk/shared build >/dev/null
pnpm --filter @helpdesk/core build >/dev/null
pnpm --filter @helpdesk/api build >/dev/null
pnpm --filter @helpdesk/api openapi:emit
pnpm exec openapi-typescript apps/api/openapi.json -o apps/web/src/shared/api/generated/schema.d.ts >/dev/null
pnpm exec prettier --write $PATHS >/dev/null
if ! git diff --exit-code --stat -- $PATHS >&2; then
  echo "The generated OpenAPI schema or web client is out of date: regenerate with scripts/openapi-diff.sh and commit the result." >&2
  exit 1
fi
if [ -n "$(git ls-files --others --exclude-standard -- $PATHS)" ]; then
  echo "Generated files are not tracked by git." >&2
  exit 1
fi
echo "OpenAPI schema and generated client are up to date"
