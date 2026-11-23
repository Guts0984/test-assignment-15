# Security and abuse tests

Every row is an automated test that starts a real server (in-process on an ephemeral port against real Postgres and Redis, or the full docker compose stack through nginx), attacks it with a real client (`apps/api/test/attacker/*`: per-client source IP, real sockets, raw bytes, bursts) and asserts on status, body shape, headers and side effects. Status **pass** means the latest run passed; the mutation check at the end proves the key tests fail when the protection is removed.

| Attack | Expected behaviour | Actual result | Test file | Status |
| --- | --- | --- | --- | --- |
| Call every documented operation without a token | 401 in the shared error format; no operation lacks an access declaration | 401 everywhere, `x-access` present on all operations | `apps/api/test/adversarial/route-table.adv.spec.ts`, `test/stack/adversarial.stack.spec.ts` (through nginx) | pass |
| Agent calls admin routes | 403 `FORBIDDEN` | 403 on every admin operation | same | pass |
| Staff token on customer-link routes, bad link on staff routes | 401 | 401 | same | pass |
| `/api/v1/test/clock` in the default profile | route does not exist (404), absent from OpenAPI | 404, no `/test` paths in the document | `route-table.adv.spec.ts` | pass |
| JWT: tampered payload, `alg: none`/HS512/RS256, wrong secret, expired, not-yet-valid, missing `sub`/`ver`/`role`, wrong issuer/audience, stale token version, unknown user | 401 `UNAUTHORIZED`/`TOKEN_EXPIRED` | all rejected; the database role decides admin access, not the token claim | `apps/api/test/adversarial/tokens.adv.spec.ts`, `test/clock.serial.spec.ts` (expiry by the shared server clock) | pass |
| Malformed `Authorization` headers (empty, wrong scheme, 10 KB token) | 401 | 401 | `tokens.adv.spec.ts` | pass |
| Refresh token reuse after rotation; parallel refresh; replay after logout; deactivated user | whole family revoked; at most one parallel refresh wins; access tokens die at logout and on deactivation | as expected | `apps/api/test/auth.int.spec.ts` | pass |
| Login enumeration: unknown email vs wrong password | identical status and body, comparable timing (argon2 on both paths) | identical | `auth.int.spec.ts`, `adversarial.stack.spec.ts` | pass |
| IDOR: agent or lead of another team reads or changes a ticket (every ticket route, search, queue, dashboard, report, attachment) | 404, indistinguishable from a missing id; nothing changes (version, team, status unchanged) | 404, no state change | `apps/api/test/adversarial/access.adv.spec.ts`, `adversarial.stack.spec.ts` | pass |
| Mass assignment (`role`, `teamId`, `assigneeId`, `isInternal`, `kind` in bodies) | 400 (strict schemas) | 400, nothing applied | `access.adv.spec.ts`, `input.adv.spec.ts` | pass |
| Internal notes to a customer: portal REST, portal attachments, search, customer socket (both api copies), outbound email | never visible | never visible | `access.adv.spec.ts`, `realtime.int.spec.ts`, `adversarial.stack.spec.ts`, `packages/shared` realtime-routing property test | pass |
| Magic link: link of A on B, truncated/guessed/upper-cased token, token in the query string or as a bearer | 401 `LINK_INVALID` | 401 | `access.adv.spec.ts` | pass |
| Magic link after merge / after expiry | 410 `LINK_REVOKED` / `LINK_EXPIRED` | as expected (expiry via the shared test clock through nginx) | `access.adv.spec.ts`, `adversarial.stack.spec.ts` | pass |
| Survey link: other ticket, truncated token, expired (7 days), rating out of range, change within 7 days | 401 / 410 `SURVEY_EXPIRED` / 400; one survey per ticket | as expected | `apps/api/test/portal.int.spec.ts` | pass |
| Web form used to take over someone else's ticket | response never contains a link or token | no token in body or headers | `access.adv.spec.ts` | pass |
| Socket: no / garbage / forged credentials on both copies | connection refused (`UNAUTHORIZED`, `LINK_INVALID`) | refused | `realtime.int.spec.ts`, `adversarial.stack.spec.ts` | pass |
| Socket: subscribe to another team's ticket; malformed ids; extra fields; customer subscribing to staff rooms | `NOT_FOUND`/`FORBIDDEN`, nothing joined, no events received | as expected | `realtime.int.spec.ts` | pass |
| Socket: team change or merge while subscribed | staff room dropped (`ticket:access-changed`); duplicate's customer sockets disconnected | as expected | `realtime.int.spec.ts` | pass |
| Socket flood from one connection | excess dropped with `EVENT_BUDGET_EXCEEDED`; another socket from the same address is not slowed | as expected | `realtime.int.spec.ts` | pass |
| Presence after an abrupt drop | gone within the TTL (reaper) | gone | `realtime.int.spec.ts` | pass |
| Forged inbound mail: unsigned, wrong secret, stale/replayed signature | 401 `INBOUND_SIGNATURE_INVALID`, nothing stored | as expected | `apps/api/test/inbound-form.int.spec.ts`, `adversarial.stack.spec.ts`, `modules/inbound/domain/signature.spec.ts` | pass |
| Forged `In-Reply-To` / `References` / `[#number]` from another customer | treated as a new ticket, never attached | new ticket | `packages/core/test/inbound.int.spec.ts` | pass |
| Autoreplies, bounces, null return path, `Precedence: bulk`, mailer-daemon | never create or reopen a ticket, no acknowledgement (no mail loop) | as expected, also under mail chaos | `inbound.int.spec.ts`, `test/stack/inv2-4.stack.spec.ts` | pass |
| Garbage / unparseable MIME, attachments over 10 MB | `rejected` with a reason, never a crash or a stuck job | as expected | `inbound.int.spec.ts` | pass |
| SQL injection strings (including inside full-text search), XSS payloads in subject/body/name, `<script>` in mail | stored as inert text, searchable, never executed (UI renders text only; the stub page escapes) | as expected | `apps/api/test/adversarial/input.adv.spec.ts`, `tickets.int.spec.ts`, `apps/mail-stub/test/stub.spec.ts`, `inbound-form.int.spec.ts` | pass |
| Path traversal in attachment names (`../../etc/passwd`) | basename only | `passwd` | `inbound-form.int.spec.ts`, `inbound.int.spec.ts` | pass |
| Null bytes, huge strings, deep JSON, huge arrays, `__proto__`/`constructor`, wrong types, duplicate keys on every body route | 400 in the shared format, never 5xx, no prototype pollution | as expected | `input.adv.spec.ts` | pass |
| Malformed JSON, wrong or missing content type, oversized body | 400 `MALFORMED_JSON`, 415, 413 | as expected | `input.adv.spec.ts`, `adversarial.stack.spec.ts` (413 from nginx for 16 MB) | pass |
| Header injection (CRLF in request headers, subjects, names, mail stub fields) | no extra headers; outbound subjects stripped | as expected | `input.adv.spec.ts`, `packages/shared` mail tests, `apps/mail-stub/src/inbound/compose.spec.ts` | pass |
| Unexpected methods, unknown routes, invalid or negative pagination | 4xx in the shared format | as expected | `route-table.adv.spec.ts`, `input.adv.spec.ts` | pass |
| Disallowed CORS origin; security headers; framework banner | no `Access-Control-Allow-Origin`; helmet headers; no `X-Powered-By`; nginx without version | as expected | `input.adv.spec.ts`, `adversarial.stack.spec.ts` | pass |
| Slow-header connections (slowloris-style) | other clients keep p95 under 500 ms | p95 well under budget | `adversarial.stack.spec.ts` | pass |
| Races: 80 concurrent assignments to one agent; 500 simultaneous inbound mails; take vs transfer vs auto-assign; A→B vs B→A merge; undo vs send; two simultaneous replies; double form submit | limits never exceeded, one owner, one merge, one outcome | as expected (database level, core level, and through the real stack) | `packages/core/test/*.int.spec.ts`, `apps/api/test/stack/*.stack.spec.ts` | pass |
| Worker `kill -9` during a stream of mail; `FLUSHALL`; two hours of worker downtime | nothing lost, nothing done twice (see the documented SMTP edge in `docs/BUGS_FOUND.md` #8) | as expected | `apps/api/test/stack/resilience.stack.spec.ts` | pass |

## Scenarios marked not applicable

| Scenario (from the adversarial-testing skill) | Why it does not apply |
| --- | --- |
| Rate limiter (brute force, per-IP buckets, `X-Forwarded-For` spoofing, window boundaries, limits across copies, Redis down) | The assignment requires no rate limiter and forbids throttling inbound mail, the web form, the stub, replies or sockets by IP (acceptance check 6 sends 500 requests from one address). No login throttle was added. The only limit is the per-socket event budget (not keyed by IP), tested above. |
| `X-Forwarded-For` / client-IP trust | No behaviour depends on the client IP (no limiter, no IP allow-list). nginx overwrites the header and the api trusts it only from the proxy network; nothing observable can be tested. |
| Ledger, holds, virtual queue, payment stub | There is no money, no reservation or payment flow in this assignment. |
| Refresh-token cookie theft over HTTP | Cookies are `HttpOnly; SameSite=Strict` and `Secure` when `PUBLIC_BASE_URL` is https; the compose stack is plain HTTP by design. |

## Mutation check

`scripts/mutation-check.sh` temporarily disables a protection, requires the matching tests to **fail**, and restores the code with `git checkout`.

| Mutation | Result |
| --- | --- |
| (a1) ticket access guard allows every ticket (`TicketService.requireTicket`) | `access.adv.spec.ts` and `realtime.int.spec.ts` fail |
| (a2) admin role check removed from the global auth guard | `route-table.adv.spec.ts` fails (agents reach admin routes) |
| (b) `.strict()` removed from the note input (mass assignment) | `access.adv.spec.ts` fails |
| (c) `AND open_count < ticket_limit` removed from the agent-load trigger (invariant 1) | `schema-constraints.int.spec.ts` and `assignment.int.spec.ts` fail |

Result of the last run: **every mutation was caught** (log: see `docs/mutation-check.log`).
