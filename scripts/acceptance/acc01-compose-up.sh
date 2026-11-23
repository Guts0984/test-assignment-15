#!/usr/bin/env bash
# ACC-1: a clean checkout comes up with `cp .env.example .env && docker compose up --build` and nothing else.
# Uses a fresh clone in a temp directory and a separate compose project so it does not touch a running stack.
. "$(dirname "$0")/lib.sh"
TMP="$(mktemp -d)"
trap 'docker compose -p acc1 -f "$TMP/repo/docker-compose.yml" --project-directory "$TMP/repo" down -v >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
git clone -q "$ROOT" "$TMP/repo"
cd "$TMP/repo"
cp .env.example .env
# Only host ports are changed (other stacks may use the defaults); the commands under test are unchanged.
sed -i 's/^HTTP_PORT=.*/HTTP_PORT=18480/; s/^MAIL_STUB_HOST_PORT=.*/MAIL_STUB_HOST_PORT=18425/; s/^POSTGRES_HOST_PORT=.*/POSTGRES_HOST_PORT=18433/; s/^REDIS_HOST_PORT=.*/REDIS_HOST_PORT=18380/' .env
# lib.sh exported the developer's .env; compose must read only the clone's .env, so start with a clean environment.
env -i PATH="$PATH" HOME="$HOME" SEED_PROFILE=small docker compose -p acc1 up --build -d --wait >/dev/null 2>&1 || { docker compose -p acc1 logs --tail 40 >&2; fail "docker compose up --build did not become healthy"; }
curl -fsS "localhost:18480/api/v1/health" >/dev/null && pass "api answers through nginx"
curl -fsS -o /dev/null "localhost:18480/login" && pass "web answers through nginx"
curl -fsS -o /dev/null "localhost:18480/docs" && pass "Swagger UI at /docs"
curl -fsS "localhost:18425/health" >/dev/null && pass "mail stub answers"
echo "$(docker compose -p acc1 ps --format '{{.Service}}' | sort | uniq -c | tr '\n' ' ')"
curl -fsS -X POST localhost:18480/api/v1/auth/login -H 'content-type: application/json' -d "{\"email\":\"agent01@helpdesk.test\",\"password\":\"${SEED_STAFF_PASSWORD}\"}" | grep -q accessToken && pass "seeded agent can sign in"
