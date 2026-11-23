# Adversarial testing

Goal: find bugs and security holes, not confirm the happy path. Think like an attacker. Every test must be able to fail.

## Stack note

Postgres, Redis and nginx below are the default stack. Use whatever the assignment's stack actually is. If a component is absent, run every scenario against the real replacement. Skip a scenario only if it has no equivalent in this assignment, and say so in `docs/SECURITY-TESTS.md` with a reason. If there is no reverse proxy, test the app's own trusted-proxy and client-IP logic directly.

## Setup

- Bring up real dependencies: postgres and redis (docker compose or testcontainers). Never mock the db or redis here.
- Start the real API as an actual listening server on an ephemeral port, with the same config as production (`.env.example` values). For multi-instance and IP tests, put real nginx in front, exactly as deployed.
- Build a small attacker harness in `apps/api/test/attacker/` as functional helpers:
  - `client({ sourceIp, auth })` sends real HTTP requests with a distinct source IP. On Linux all of 127.0.0.0/8 is loopback, so bind per client with `localAddress: '127.0.0.N'`, or use docker network containers.
  - `socket({ auth, apiCopy })` opens a real Socket.IO connection to a chosen api copy.
  - `burst({ n, fn })` fires N requests truly in parallel; `flood(...)`, `slowRequest(...)`, `raw(...)` for malformed bytes.
  - `mail({ ... })` sends inbound mail through the mail stub's HTTP endpoint with arbitrary headers.
  - `timed(fn)` to measure latency.
  - `clock` helpers to advance the shared test clock (never real sleeps).

## Concurrency, jobs and Redis loss (the key scenarios for this kind of system)

Run two api copies behind nginx plus the worker (at least three worker copies where the assignment requires it).

- **Scarce resources:** hundreds of parallel requests competing for a limited resource (agent ticket slots, a single ticket owner) must never exceed the limit or produce two owners. Compare counts in Postgres afterwards, and check that history is consistent with the final state.
- **Racing actions:** fire conflicting actions at the same moment (auto-assign vs manual transfer vs "take it"; merge A→B vs B→A; cancel send vs the send job; two replies to the same ticket). Exactly one consistent outcome, no cycles, no lost rows.
- **Idempotency:** deliver the same inbound message twice, to both api copies at once; process the same job twice or on several workers at once. The effect happens exactly once (one ticket, one message, one email, one warning).
- **External side effects:** with transient SMTP errors injected, every outbound email is delivered exactly once. Count it at the receiving stub, not in the db.
- **Crash:** `kill -9` a worker mid-processing, restart it. Everything is processed, with no duplicates.
- **Redis wipe:** with live timers, scheduled sends and queued assignments, run `FLUSHALL` (and also restart Redis). Nothing is lost, nothing fires twice, and the system rebuilds its jobs from Postgres on its own.
- **Downtime catch-up:** stop the worker, advance the clock past due times, start it. Missed actions fire once each, in order.
- **Timing edges:** an action exactly at its deadline, one tick before and one tick after (for example cancel at 9.9 s vs 10.0 s). Behavior is deterministic.

## Socket.IO

- Unauthenticated connections are rejected.
- A client cannot join or receive events for rooms it has no access to (another customer's ticket, another team's queue), whichever api copy it connects to. Internal notes never reach a customer socket.
- Events reach clients connected to either api copy within the budget.
- Presence expires when a client disappears without a clean disconnect.
- After reconnect, the client catches up on missed events and does not show stale state.
- Message floods from one socket are throttled or dropped without affecting others.

## Auth and permissions

- Brute force on login hits lockout or throttling if one exists. Failed-login responses are identical for a wrong password and an unknown user (body, status and timing within tolerance).
- Token attacks: tampered payload, `alg: none`, wrong secret, expired, not-yet-valid, missing claims, a token for another user, refresh-token reuse after rotation (must revoke the whole family), replay after logout.
- Magic links: a link for ticket A cannot open ticket B; a link stops working after merge and after expiry; a guessed or truncated token fails.
- Privilege: IDOR (user A reads or edits user B's resources), role escalation, mass assignment (extra fields like `role`, `id`, `teamId`, `isInternal`), and missing auth on every route (iterate over the route table and assert each protected route returns 401 without a token and 403 with the wrong role).
- Race conditions: parallel registration or creation with the same unique key, double-submit, parallel refresh.

## Rate limiter (only if one exists)

- Attacker A (IP X) floods a limited endpoint far above the limit while innocent users B and C (IPs Y, Z) call it at normal speed. A gets 429 with a correct `Retry-After`; B and C keep getting 2xx with p95 latency under a stated budget.
- Spoofed `X-Forwarded-For`, `X-Real-IP` and `Forwarded` headers from an untrusted client must not evade A's limit and must not put victim IP Y into A's bucket. Rotating spoofed values cannot reset the counter.
- Window boundaries, off-by-one at exactly the limit, recovery after the window. N parallel requests cannot exceed the limit.
- Limits hold across api copies (total, not per copy). Redis down or slow matches the documented fail-open/fail-closed choice. Keys have a TTL. IPv6 and IPv4-mapped addresses share one bucket.
- The limiter never blocks flows the assignment's acceptance scenarios need.

## Inbound mail

- Forged or spoofed headers (`In-Reply-To`, `References`, a ticket number in the subject) cannot attach a message to another customer's ticket.
- Autoreplies and bounces (`Auto-Submitted`, `Precedence`, DSN, null return path) never create or reopen tickets, and cannot cause a mail loop.
- Malformed MIME, huge attachments, wrong encodings and missing headers produce a clean rejection, never a crash or a stuck job.

## Input and transport

- SQL injection strings (including inside full-text search queries), NoSQL operators, XSS payloads (stored in ticket bodies, subjects, names and email HTML, and reflected), path traversal in attachment names, null bytes, unicode normalization tricks, very long strings, deeply nested JSON, prototype pollution (`__proto__`, `constructor`), wrong content types, malformed JSON, duplicate keys, huge arrays.
- An oversized body returns 413. Header injection (CRLF), including into outbound email headers. Unexpected HTTP methods. Invalid or negative pagination values.
- Every error uses the shared error format with a stable code. Never a bare 500, stack trace, SQL error or internal path.
- Resource exhaustion: slowloris-style slow headers or body, many open connections, huge numbers of keep-alive requests. The server stays responsive for other clients.
- CORS: a disallowed origin gets no `Access-Control-Allow-Origin`. Security headers are present.

## Rules for every test

- Assert on status, body shape, headers, side effects in db/redis/mail stub, AND that unrelated users are unaffected.
- Deterministic: poll with a timeout, never fixed sleeps. Control time with the injected clock. Each test uses its own users, tickets and keys, so tests run in parallel without interfering.
- **Mutation check (mandatory):** after the suite is green, temporarily disable the auth/permission guard, one validator, and one concurrency guard (a row lock or a unique constraint), plus the limiter if one exists. The matching tests MUST fail. Restore the code. Note the check in docs.
- When a test finds a bug: keep the failing test, fix the code, and add a row to `docs/BUGS_FOUND.md` (attack, impact, root cause, fix, test file).

## Report

Maintain `docs/SECURITY-TESTS.md`, a table of: attack, expected behavior, actual result, test file, status. List the scenarios marked not applicable, each with a reason.
