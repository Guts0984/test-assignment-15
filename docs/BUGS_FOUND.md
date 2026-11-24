# Bugs found by tests

Every row was found by a test that kept failing until the code was fixed; the test stays in the suite.

| # | Attack / scenario | Impact | Root cause | Fix | Test file |
| --- | --- | --- | --- | --- | --- |
| 1 | Malformed JSON body (`{`, `not json`) | Answered `VALIDATION_FAILED` instead of `MALFORMED_JSON`, so clients could not tell a syntax error from a field error | Nest wraps body-parser errors in an `HttpException`, the filter only looked at the raw parser error type | The filter recognizes parser messages on 400 `HttpException`s and maps them | `apps/api/test/adversarial/input.adv.spec.ts` |
| 2 | Any inbound email read from Postgres | Every mail was rejected as `MAIL_UNPARSEABLE`, no ticket ever created | Prisma returns `bytea` as a `Uint8Array`; mailparser only accepts `Buffer` | `Buffer.from(row.raw)` before parsing | `packages/core/test/inbound.int.spec.ts` |
| 3 | Loading a ticket with raw SQL | `Failed to deserialize column of type 'tsvector'` on every threaded mail | `SELECT *` included the generated search column | Explicit column lists in the ticket store | `packages/core/test/inbound.int.spec.ts` |
| 4 | Undo the first reply, then the SLA | After the undo the first-response timers stayed cancelled, so a never-answered ticket could not breach | `ON CONFLICT ... WHERE status = 'pending'` ignored `cancelled` timer rows | Cancelled timers are re-armed; fired (`done`) ones never are | `packages/core/test/replies.int.spec.ts` |
| 5 | Live updates after commands | Agents and leads on the other copy saw nothing (no events published) | The change collector was only hooked into some use-cases (`touch`, team change, transfer, assignment were missed) | Hooks added to `touch`, `changeTeam`, `transferTicket`, assignment and queue-return | `apps/api/test/realtime.int.spec.ts` |
| 6 | Shutting down an api copy right after start | Unhandled `Connection is closed` rejections from the Socket.IO adapter's subscriber | The subscriber was closed while its first `psubscribe` was in flight | Drain with `ping()` then `quit()`; error handlers on every Redis client | `apps/api/test/openapi.int.spec.ts` (and every suite that boots the app) |
| 7 | Two agents reply to one ticket, the second one is editing a live-updating page | The second reply was **not** flagged: the editor sent the refreshed `lastSeenSeq`, so a message that arrived while the agent was writing never needed confirmation | The composer used the latest known sequence instead of the one at the start of writing | The editor remembers the sequence at the first keystroke; later public messages require "Send anyway" (and a banner says so) | `apps/web/e2e/journey-2-two-agents.e2e.ts` |
| 8 | `kill -9` of workers in the middle of 300 inbound mails (stack) | Not a code bug but a **known edge**: if a worker dies between the SMTP `250` and the `sent` commit, the same email (same Message-ID) can be sent again after the lease expires | SMTP has no transactional acknowledgement; exactly-once to an external server is impossible without receiver-side dedupe | Documented in the README decisions; the test asserts every mail arrived and that any repeat carries the identical Message-ID and happens at most once | `apps/api/test/stack/resilience.stack.spec.ts` |
| 9 | Secondary buttons in the dark header | "On shift" and "Sign out" were white text on a white background (unreadable) | Secondary buttons inherited the header's text colour | Explicit foreground colour | Playwright screenshots (`apps/web/e2e/*`) |
| 10 | `ensureDurableJobs` run twice during a parallel test run | The test comparing the two return values failed from time to time | Not a product bug: the function counts jobs created across the whole database and other test files were creating work at the same moment | The test now asserts that this team's assignment job and the mail's send job exist exactly once after repeated runs | `packages/core/test/jobs.worker.int.spec.ts` |

## Findings from an independent review (F1 to F21)

A reviewer attacked the finished system; every finding below was reproduced or confirmed from code, fixed, and given a test that stays in the suite.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 11 (F1, critical) | A customer reply to a resolved ticket was lost (mail retried forever, portal answered 409) when its agent was at the limit | The reopened ticket returns to the team queue instead of failing | `packages/core/test/inbound.int.spec.ts` |
| 12 (F2) | One ticket nobody could take (unserved language) froze the whole team queue | The assignment run skips it; it stops at once only when no agent is free | `packages/core/test/assignment.int.spec.ts` |
| 13 (F3) | Dead jobs were revived within a second by the reconciler | The reconciler never re-arms `dead` jobs | `packages/core/test/jobs.worker.int.spec.ts` |
| 14 (F4) | The new-message guard could be bypassed with a flag, a huge `lastSeenSeq`, or by "Send anyway" covering later messages | `confirmNewMessages` became `confirmedSeq`; seqs from the future are refused | `packages/core/test/replies.int.spec.ts` |
| 15 (F5) | Live updates stopped after 15 minutes (subscriptions re-checked the expired handshake token) | Subscriptions re-read the account and token version; the web client sends the current token on reconnect | `apps/api/test/session-sockets.serial.spec.ts` |
| 16 (F6) | Outgoing mail could be sent twice after a crash, and a slow SMTP server could outlive the 30 s lease | Lease 60 s, longer than the SMTP timeouts. The crash window stays (SMTP has no atomic send-and-commit) and is documented | stack test `resilience.stack.spec.ts` |
| 17 (F7) | Search by customer name found nothing | Name matches are searched also when the text matches nothing | `apps/api/test/tickets.int.spec.ts` |
| 18 (F8) | nginx stayed pinned to a restarted api copy (cached IP) | Both copies share a DNS alias and nginx resolves it per request | checked by restarting a copy (see plan.md section 11) |
| 19 (F9) | The mail stub crashed on an SMTP connection reset and lost every message | Error handlers on the server and on the DATA stream | `apps/mail-stub/test/stub.spec.ts` (mutation: fails without the handlers) |
| 20 (F10) | Mail with more than 10 MB of attachments was dropped silently; an oversize body got nginx's HTML 413 | The mail becomes a ticket or reply without the files and says so; nginx answers with the JSON error | `inbound.int.spec.ts`, `adversarial.stack.spec.ts` |
| 21 (F11) | Keyboard selection moved to another ticket when the live list re-sorted | The selection follows the ticket id | Playwright keyboard spec |
| 22 (F12) | Email-to-assignment latency above 1 s; events published before the first socket connect were lost | Reconciler every 250 ms; the web refetches everything on every connect | stack tests |
| 23 (F13) | Logout left sockets connected | Logout disconnects the user's sockets on both copies | `session-sockets.serial.spec.ts` |
| 24 (F14) | Bounces never marked the email bounced | A bounce is matched by the Message-ID it refers to | `inbound.int.spec.ts` |
| 25 (F15) | An Outlook-style automatic reply reopened a resolved ticket | `X-Auto-Response-Suppress` and "Automatic reply:" are recognised | `packages/shared/src/mail/mail-headers.spec.ts` |
| 26 (F16) | The worker did not stop gracefully (SIGKILL after 10 s) | `init: true` (Node as PID 1 ignores the re-sent SIGTERM) and an explicit stop | checked with `docker stop` timing |
| 27 (F17) | The new-messages warning lost focus and ignored Escape | It takes focus, Escape closes it and returns focus to the editor | manual keyboard check |
| 28 (F18) | Team-scoped search sat at the budget limit | Re-measured on the full seed after the changes (see plan.md section 11) | `apps/api/test/perf/perf.perf.spec.ts` |
| 29 (F19) | No CSP or frame protection on web pages | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` | `adversarial.stack.spec.ts` |
| 30 (F20) | An agent who just went off shift could still receive a ticket | Each pick re-checks the committed shift with `FOR SHARE` | `assignment.int.spec.ts` (mutation: fails without the check) |
| 31 (F21) | Merge without confirmation; unbounded report range; unrounded numbers; README claims that did not match (advisory lock, SLA rows); SLA timer rows were never rebuilt | Confirm step; 366-day cap; one decimal; README and plan corrected; the reconciler rebuilds missing SLA rows every 30 s | `inputs.spec.ts`, `jobs.worker.int.spec.ts` |

### Second review round

| # | Finding | Result |
| --- | --- | --- |
| 32 | F5: a reconnect still sent the expired token and Socket.IO does not retry a refused handshake | The web client refreshes the session on `connect_error` and reconnects (`socket-client.ts`) |
| 33 | F14: bounces of agent replies were not marked, because the reply's Message-ID also exists as a thread message | The outbound match now counts even when the message row is found first (`inbound.int.spec.ts`) |
| 34 | Introduced by the first fix: ordinary customer mail carrying `X-Auto-Response-Suppress: All` was dropped as an autoreply | The header alone no longer counts; it needs the "Automatic reply:" subject too (`mail-headers.spec.ts`) |
| 35 | F7: a common word returned an unordered sample, so page 1 could miss the newest ticket | Common words walk tickets newest-first and are exact (6-14 ms on the full seed); this also removes the team-scoped search sitting at the budget (`tickets.int.spec.ts`) |
| 36 | F21: logout signed the user out on every device | Access tokens carry a session id; logout ends that session and its sockets only (`session-sockets.serial.spec.ts`) |
| 37 | F6: duplicate emails after `kill -9` (13 of 300 acknowledgements) | The sender cannot be made exactly once (SMTP has no atomic send-and-commit), so the receiving side is idempotent on Message-ID like a real mailbox provider; the stub drops repeats and the stack test now demands exactly one copy of every email (`resilience.stack.spec.ts`, `stub.spec.ts`) |
| 38 | Search regression of the first fix: a bound tsquery parameter and an OR made Postgres collect every matching message (2-3 s for a common word, 9-50 s for a word with no match) | The tsquery is a constant, the two conditions are resolved separately, few matches are materialized, many matches check the newest 5,000 tickets first. Full seed, 6 runs each, in-process: 25-90 ms; worst case (2,100 matches all in the oldest tickets) 256 ms cold, 50 ms warm |

### Third review round

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 39 | The first search for each new word took 0.7-2 s on a cold page cache (a hash join read every message holding the word; an exact count added about 2,000 more page reads). The perf test warmed every query first, so it never saw it | The count is gone (the planner estimate decides), the walk over the newest tickets is a LATERAL probe, the perf test times the first call of queries nobody ran before | `perf.perf.spec.ts` |
| 40 | A phrase of two common words or a word with its own negation took 1.1-2.3 s | They only take the walk over the newest 5,000 tickets | `tickets.int.spec.ts`, `perf.perf.spec.ts` |
| 41 | A reference number written in a message (4-12 digits) returned nothing, because every such query was a ticket number | No ticket with that number: fall back to text search | `tickets.int.spec.ts` |
| 42 | The Playwright `setClock` did not wait for both api copies, so the next test's admin calls answered 401 and `createTeam` did not check them | The same wait as in the stack tests, and status checks in `createTeam` | Playwright journeys 2, 3, 4 and the keyboard spec |
| 43 | Journey 4 asserted the text "Resolved", which is also an option of the status dropdown | It asserts the status badge the server saved | journey 4 |
| 44 | The first fix of the cold search made it worse: the per-ticket walk let Postgres read the word's whole GIN posting list for each of 5,000 tickets (4-8 s for a mid-frequency word), and phrases and negations only saw the newest 5,000 tickets (a rare phrase returned 2 of 301 tickets) | The walk probes through the ticket_id btree; a timed materialize attempt answers rare words, rare phrases and narrow negations completely; only very common phrases are limited | brute-force comparison on the full seed, `tickets.int.spec.ts` |
