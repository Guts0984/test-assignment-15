#!/usr/bin/env bash
# ACC-6..15 against the running test-profile stack (docker-compose.test.yml): 500 mails, ownership race, mail chaos,
# follow-up ticket, undo, merge race, kill -9, FLUSHALL, two hours of downtime, live updates, forbidden access.
. "$(dirname "$0")/lib.sh"
stack_vitest && pass "ACC-6 .. ACC-15 stack suites"
