#!/usr/bin/env bash
# Verifies the FULL seed profile in the running compose postgres (or the database named by $1).
# Usage: scripts/acceptance/check-seed.sh [database]
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${1:-${POSTGRES_DB:-helpdesk}}"
q() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-helpdesk}" -d "$DB" -At -c "$1"; }
fail=0
expect() { # label actual expected
  if [ "$2" = "$3" ]; then printf 'ok    %-40s %s\n' "$1" "$2"; else printf 'FAIL  %-40s got %s, expected %s\n' "$1" "$2" "$3"; fail=1; fi
}
expect_ge() {
  if [ "$2" -ge "$3" ]; then printf 'ok    %-40s %s (>= %s)\n' "$1" "$2" "$3"; else printf 'FAIL  %-40s got %s, expected >= %s\n' "$1" "$2" "$3"; fail=1; fi
}
expect "teams" "$(q 'select count(*) from teams')" 4
expect "time zones" "$(q 'select count(distinct time_zone) from teams')" 2
expect "agents" "$(q "select count(*) from team_members where role = 'agent'")" 80
expect "customers" "$(q 'select count(*) from customers')" 200000
expect "tickets" "$(q 'select count(*) from tickets')" 500000
expect "messages" "$(q 'select count(*) from messages')" 3000000
expect "history span (days >= 700)" "$(q "select (extract(epoch from max(created_at) - min(created_at)) / 86400 >= 700)::int from tickets")" 1
expect "open tickets with timers" "$(q "select count(*) from tickets where status in ('new','open','waiting_customer','on_hold')")" 2000
expect_ge "breaches due within 10 minutes" "$(q "select count(*) from jobs where status = 'pending' and kind = 'sla_breach' and run_at > now() and run_at <= now() + interval '10 minutes'")" 1
expect "agent counters match real load" "$(q "select count(*) from users u where open_count <> (select count(*) from tickets t where t.assignee_id = u.id and t.status in ('new','open','waiting_customer','on_hold'))")" 0
exit $fail
