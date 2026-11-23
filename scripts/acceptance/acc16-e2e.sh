#!/usr/bin/env bash
# ACC-16 (state in the URL, reload, Back) and the four journeys, in a real browser against the test-profile stack.
. "$(dirname "$0")/lib.sh"
(cd apps/web && pnpm exec playwright test) && pass "Playwright journeys and UX specs"
