# Chat A — Validation report

Every command below was actually run, in this chat, against the real
extracted backend source (`ORAC-IOS-SOURCE-OF-TRUTH-20260927-153926.zip`),
targeting a local JSON store (`STORE_DRIVER=json`, the default) — never a
real Fly.io/Neon/production database. Output is the real output, trimmed for
length where noted; nothing here is a predicted or assumed result.

## 0. Baseline (before any change)

```
$ npm ci
added 100 packages in 2s

$ npm test
...
# tests 327
# pass 327
# fail 0
```
**327/327 passing, 0 failures, before any fixture code was added.**

## 1. Guard rails refuse to run without every explicit condition

```
$ node scripts/pilot-fixture/load-pilot-fixture.mjs
Refusing to load fixture: set ORAC_FIXTURE_MODE=PILOT_FIXTURE (explicit fixture flag).
exit=1

$ NODE_ENV=production ORAC_FIXTURE_MODE=PILOT_FIXTURE ORAC_FIXTURE_TARGET=non-production \
  node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=LOAD_ORAC_PILOT_FIXTURE
Refusing to load fixture: NODE_ENV=production. This script never runs against
a production-configured process, no matter what flags are passed.
exit=1

$ ORAC_FIXTURE_MODE=PILOT_FIXTURE ORAC_FIXTURE_TARGET=non-production \
  node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=WRONG
Refusing to load fixture: pass --confirm=LOAD_ORAC_PILOT_FIXTURE
exit=1

$ ORAC_FIXTURE_MODE=PILOT_FIXTURE ORAC_FIXTURE_TARGET=non-production \
  node scripts/pilot-fixture/load-pilot-fixture.mjs --confirm=LOAD_ORAC_PILOT_FIXTURE
Refusing to load fixture: pass --apply. Without it this only prints what it
would do — try that first.
exit=1
```
All four guard conditions (fixture-mode flag, non-production-target flag,
`NODE_ENV=production` check, `--apply`, exact `--confirm` string) were each
independently verified to actually refuse.

## 2. First load — real inserted/reused counts

```
$ JSON_DB_PATH=./data/pilot-fixture-db.json \
  ORAC_FIXTURE_MODE=PILOT_FIXTURE ORAC_FIXTURE_TARGET=non-production \
  node scripts/pilot-fixture/load-pilot-fixture.mjs --apply --confirm=LOAD_ORAC_PILOT_FIXTURE

Guards passed. Loading pilot fixture.
  store driver: json
  json db path: ./data/pilot-fixture-db.json
  fixture spec: ORAC-IOS monthly fixture (reconciled) (2026-09-25-r2)

Inserted / reused per collection:
  users                    inserted=20  reused=0  (fixture has 20)
  clients                  inserted=3   reused=0  (fixture has 3)
  mine_sites               inserted=4   reused=0  (fixture has 4)
  quotes                   inserted=7   reused=0  (fixture has 7)
  quote_lines              inserted=13  reused=0  (fixture has 13)
  purchase_orders          inserted=5   reused=0  (fixture has 5)
  po_amendments            inserted=1   reused=0  (fixture has 1)
  dispatch_cards           inserted=5   reused=0  (fixture has 5)
  timesheets               inserted=8   reused=0  (fixture has 8)
  field_worksheets         inserted=8   reused=0  (fixture has 8)
  material_usage           inserted=3   reused=0  (fixture has 3)
  stock_items              inserted=3   reused=0  (fixture has 3)
  stock_movements          inserted=5   reused=0  (fixture has 5)
  invoices                 inserted=4   reused=0  (fixture has 4)
  invoice_lines            inserted=5   reused=0  (fixture has 5)
  access_requests          inserted=3   reused=0  (fixture has 3)
  internal_work_requests   inserted=10  reused=0  (fixture has 10)

11 mapping gaps recorded (not loaded as records) — see GAPS_REPORT.md.
```

## 3. Re-run proves idempotency

Same command, run again with no changes in between:

```
Inserted / reused per collection:
  users                    inserted=0  reused=20  ...
  clients                  inserted=0  reused=3   ...
  (every collection: inserted=0, reused=<same count as run 1>)
```
**No duplicate records on re-run.**

## 4. Independent verifier — clean run

```
$ JSON_DB_PATH=./data/pilot-fixture-db.json node scripts/pilot-fixture/verify-pilot-fixture.mjs

... 57 individual checks, each printed ok/FAIL ...

57 checks run, 0 failures.
exit=0
```
Checks cover: fixture record counts, referential integrity (every foreign
key resolves), invoice arithmetic independently recomputed from raw
timesheet/material rows (not copied from the loader), stock-movement replay
from each item's opening balance with a "never negative" check, PO-amendment
arithmetic, every loaded IWR's pairing re-validated against the real
`isPairingAllowed` policy function, and 8 checks that call the REAL
`src/reports.js` functions (`computePipelineReport`,
`computeDispatchReport`, `computeWorksheetReport`,
`computeInvoiceReadyReport`, `computeVarianceReport`) against the loaded
data and assert on their actual output — including the two genuine gap
findings (G-DELIVERY-ONLY, G-EVIDENCE-GATE) documented in GAPS_REPORT.md.

## 5. Verifier is not vacuous — proven by deliberate corruption

```
$ node -e "... set invoices[INV-001].total_amount = 99999 ..."
corrupted INV-001 total_amount to 99999

$ JSON_DB_PATH=./data/pilot-fixture-db.json node scripts/pilot-fixture/verify-pilot-fixture.mjs
...
FAIL  invoice INV-001 total_amount (99999) === recomputed labour+material (2110)
FAIL  invoice INV-001 lines sum (2110) === total_amount (99999)
...
57 checks run, 2 failures.
exit=1
```
The verifier correctly caught the injected error. The database was then
restored from a pre-corruption backup and re-verified clean (57/0) before
continuing.

## 6. Negative/edge-case scenario tests (NT-01..NT-04)

```
$ node --test tests/pilotFixtureNegativeScenarios.test.js

ok 1 - NT-01: a Client Viewer never sees another client's quote through scopeByClient
ok 2 - NT-02: the real IWR pairing policy has no Technician -> Finance route at all
ok 3 - NT-02: createInternalWorkRequest rejects Technician -> Finance at the controller (403, no record written)
ok 4 - NT-03: a Supervisor not assigned to the dispatch cannot approve its worksheet
ok 5 - NT-03 (control): the assigned Supervisor CAN approve the same worksheet
ok 6 - NT-04: issuing more stock than is on hand is refused and on-hand is unchanged

# tests 6
# pass 6
# fail 0
```

## 7. Full regression suite after all changes

```
$ npm test
...
# tests 336
# pass 336
# fail 0
```
**336/336 passing (327 baseline + 9 new), 0 failures, 0 regressions.**

## What was NOT run

- Nothing was run against `STORE_DRIVER=postgres` or any real `DATABASE_URL`
  — this chat has no credentials for and no access to ORAC's actual Fly.io/
  Neon infrastructure, and the plan explicitly forbids touching live
  operational data regardless. The `--allow-postgres` gate and the postgres
  code path in `load-pilot-fixture.mjs` are written to the same interface
  `scripts/seed-neon.js` already uses successfully in this codebase, but are
  **unexercised** in this chat. Exercising them against a real isolated
  pilot/UAT database is explicitly for the owner to run, not this chat.

## Second pass (dry-run default, extension scenarios, rejected reporting)

Observed in this chat, local JSON store only:

- `node scripts/pilot-fixture/load-pilot-fixture.mjs` with no env/flags → DRY RUN, exit 0, printed would-insert counts (service_requests 3, leads 3, stock_movements 6, all others as before), 15 skipped items across 9 areas.
- Dry run against an already-loaded db: file **byte-identical** afterwards (`cmp`).
- Refusals (each exit 1): `NODE_ENV=production` (dry run too); `--apply` without `ORAC_FIXTURE_MODE`; wrong `--confirm`; `STORE_DRIVER=postgres --apply` without `--allow-postgres`.
- `--apply` twice: first run inserted everything, second run `inserted=0` in every collection.
- Verifier: **67 checks, 0 failures** (10 new: request→lead pipeline against Client Viewer/Sales roles, adjustment presence, counts).
- New tests `pilotFixtureLoaderValidation.test.js` (3): all accepted on empty target; cascading rejection when a referenced client is removed; acceptance of references to pre-existing non-fixture records.
- Full suite: 336/336.
- Honest limit: deleting a fixture parent from a loaded db and re-running does **not** produce rejections, because the loader regenerates that parent as a candidate (self-healing). Rejection is therefore verified at function level, not through a natural CLI scenario.
