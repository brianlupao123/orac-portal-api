# Chat A — Exact run commands

## 0. Install (once)

```bash
cd backend
npm ci
```

## 1. Baseline regression check (before loading anything)

```bash
npm test
```
Expect 327 passing before the packet, 336 after (this chat's own baseline; may differ slightly if other
chats have merged since — that's fine, just confirm 0 failures before you
start).

## 2. Dry run (the default — nothing is written)

```bash
JSON_DB_PATH=./data/pilot-fixture-db.json node scripts/pilot-fixture/load-pilot-fixture.mjs
# prints would-insert / would-reuse / would-reject per collection + skipped areas; exit 0
```
Refuses only when NODE_ENV=production (dry run included).

## 3. Load the fixture — local JSON store (safe default, recommended first)

```bash
JSON_DB_PATH=./data/pilot-fixture-db.json \
ORAC_FIXTURE_MODE=PILOT_FIXTURE \
ORAC_FIXTURE_TARGET=non-production \
node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=LOAD_ORAC_PILOT_FIXTURE
```
Re-run the exact same command any time — it is idempotent (reports
`reused=N`, never duplicates).

## 4. Verify independently

```bash
JSON_DB_PATH=./data/pilot-fixture-db.json \
node scripts/pilot-fixture/verify-pilot-fixture.mjs
```
67 checks. Exit code 0 only if all checks pass.

## 5. Run the fixture's negative-scenario tests

```bash
node --test tests/pilotFixtureNegativeScenarios.test.js tests/pilotFixtureLoaderValidation.test.js
```

## 6. Full regression suite

```bash
npm test
```

## 7. (Owner-run only) Loading against a real non-production Postgres target

Do **not** run this against the live Fly.io/Neon database. Point
`DATABASE_URL` at an isolated pilot/UAT database first — this script cannot
verify which database a `DATABASE_URL` points at, so that verification is on
you.

```bash
STORE_DRIVER=postgres \
DATABASE_URL="postgres://...pilot-uat-only.../orac_pilot" \
ORAC_FIXTURE_MODE=PILOT_FIXTURE \
ORAC_FIXTURE_TARGET=non-production \
node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=LOAD_ORAC_PILOT_FIXTURE --allow-postgres

# then:
STORE_DRIVER=postgres \
DATABASE_URL="postgres://...pilot-uat-only.../orac_pilot" \
node scripts/pilot-fixture/verify-pilot-fixture.mjs
```

## Cleaning up a local JSON fixture run

```bash
rm -f data/pilot-fixture-db.json
```
(The default app database, `data/db.json` or whatever `JSON_DB_PATH` you
normally use, is never touched — the loader was run above against a
dedicated `pilot-fixture-db.json` path specifically to avoid that.)
