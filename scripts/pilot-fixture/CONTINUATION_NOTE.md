# Chat A — Continuation note

## What this chat did

- Built a pure mapper (`build-fixture-records.mjs`) from the reconciled
  fixture spec (`ORAC-MONTHLY-FIXTURE-RECONCILED.zip`, version
  `2026-09-25-r2`) to real ORAC-IOS schema records, mapping all 8 pilot
  roles, 3 clients, 7 quotes, 5 POs (+1 amendment), 5 dispatches, 8
  timesheets/worksheets, 3 material-usage entries, 3 stock items + 5 stock
  movements, 4 invoices, 3 access requests, and 10 of 12 Internal Work
  Requests (2 have no real pairing at all — see below).
- Built a guarded, idempotent CLI loader (`load-pilot-fixture.mjs`) that
  refuses production, requires an explicit fixture-mode flag, an explicit
  non-production-target flag, `--apply`, and an exact `--confirm` string; an
  additional `--allow-postgres` gate for any Postgres target.
- Built an independent verifier (`verify-pilot-fixture.mjs`) that does not
  import the mapper and does not trust the loader's own report — it
  recomputes every figure from the raw loaded records and calls the real
  `src/reports.js` functions.
- Added 9 real automated tests covering 4 of the fixture's 12
  `negativeAndEdgeCaseScenarios` (NT-01..NT-04), run against the actual
  controllers, not mocked.
- Ran everything against a local JSON store inside this chat (never a real
  database): 327→336 tests passing, 0 failures, 0 regressions; loader
  verified idempotent; verifier verified non-vacuous (caught a deliberately
  injected corruption); all four load-guard rejections individually
  confirmed. Full transcript of every command and its real output is in
  `VALIDATION_REPORT.md`.
- Wrote an honest, evidence-cited gaps report (`GAPS_REPORT.md`) — 11 mapping
  gaps, 2 unmappable IWRs, and a list of which of the 12 negative scenarios
  are executed vs. still open.

## Second pass (this update)

- Loader is now **dry-run by default**; `--apply` alone is not enough (needs fixture-mode + non-production-target env, exact `--confirm`, and `--allow-postgres` for Postgres). Production is refused even for dry runs.
- Report categories: inserted / reused / skipped (mapper decided not to map; 15 items) / rejected (failed FK validation against the actual target; `validateRecordsAgainstTarget`, unit-tested, cascading).
- Extended scenarios only where source supports: 3 service requests + leads, 1 stock adjustment. Client acknowledgement/evidence, sales orders, costing, tax, reservation, warehouse and approval rules NOT invented — see Owner decisions OD-1..OD-8 in GAPS_REPORT.md.
- Observed: 336/336 tests, 67 verifier checks, dry run leaves the db byte-identical, all guard refusals confirmed.
- Not proven: `rejected` was not triggered end-to-end through the CLI (the fixture is self-contained and self-heals on re-run); it is proven at function level by tests. Postgres path still never run.

## What this chat explicitly did NOT do

- No workflow changes, no digital-signature/evidence work, no UI redesign,
  no deployment — all out of Chat A's scope by the plan.
- Never connected to or touched Fly.io/Neon or any real operational data.
  The Postgres code path exists (same interface as `scripts/seed-neon.js`)
  but is unexercised — see `RUN_COMMANDS.md` section 7 for the owner-run
  command against an isolated pilot/UAT database, which this chat cannot run.
- Did not resolve the stock-reservation question, the IWR-type-catalogue
  narrowness finding, the client-evidence invoice gate, or the delivery-only
  invoice-readiness gate — all flagged as gaps for their owning chats (D, B,
  E) rather than guessed at here.

## For the next chat/session

- **Do not repeat the mapping or gap analysis above** — read
  `GAPS_REPORT.md` first; it already has file/line citations for every
  mismatch found.
- **Chat B** (Timesheet/evidence): G-EVIDENCE-GATE is a real, confirmed gap —
  the invoice-readiness gate currently has no client-evidence check at all.
  Worth deciding whether to add one as part of the evidence-storage work.
- **Chat D** (delivery/inventory): G-DELIVERY-ONLY — the delivery-only
  dispatch path (no technician, stock-sale only) is asserted by the fixture
  but not actually supported by the current invoice-readiness gate.
- **Chat E** (governance): G-STOCK-RESERVE (no reservation concept exists),
  G-ACCESS-REQUEST-SHAPE (access requests can't model "link existing user to
  additional client"), and the IWR-type-catalogue narrowness finding (3 of
  10 mappable fixture IWRs only fit their real type because it was the sole
  available option for that sender/recipient direction, not because it
  actually matches the fixture's intent).
- **NT-05 through NT-12** (8 of the 12 negative scenarios) are still
  unexecuted — see the table in `GAPS_REPORT.md` for exactly which ones and
  why each was skipped in this chat (mostly: needs the HTTP layer or an
  endpoint that doesn't exist yet).
- If/when an owner provisions a real non-production pilot database, the
  Postgres path in `load-pilot-fixture.mjs` is ready but has never been run
  against a live database by any chat — that first real run and its output
  should be captured and added to a new validation report, not assumed to
  behave identically to the JSON-store run documented here.

## Files in this packet

```
scripts/pilot-fixture/
  build-fixture-records.mjs        pure mapper (fixture spec -> real records)
  load-pilot-fixture.mjs           guarded, idempotent CLI loader
  verify-pilot-fixture.mjs         independent, read-only verifier
  fixture-scenarios.source.json    copy of the input fixture spec (provenance)
  EXPECTED_RESULTS.source.json     copy of the input expected-results file (provenance)
  BENCHMARK.md                     required short online benchmark, with citations
  GAPS_REPORT.md                   honest gaps report
  VALIDATION_REPORT.md             every command run in this chat + real output
  RUN_COMMANDS.md                  exact commands to reproduce
  CONTINUATION_NOTE.md             this file
tests/
  pilotFixtureNegativeScenarios.test.js   6 real tests for NT-01..NT-04
```
