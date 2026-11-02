# V5 Invoice Writer Release Gates

## Status

The V5 invoice writer is implemented locally but is not released. It remains
dark by default and must not be enabled through a deployment, environment
change, fixture, or user-interface action until every gate below has recorded
evidence.

The existing read-only V5 preview remains separate. Its amendment-coverage
blocker is not removed by the writer.

## Required Configuration Boundary

Writing requires both of these values:

- `ORAC_V5_COMMERCIAL_WORKFLOW=enabled`
- `ORAC_V5_INVOICE_WRITER=enabled`

For the JSON store, writing also requires
`ORAC_V5_INVOICE_JSON_SINGLE_PROCESS=acknowledged`. That acknowledgement is
not a production-concurrency guarantee. Production invoice writing requires
PostgreSQL.

## Evidence Required Before Enablement

1. Capture the exact checkout root, branch, commit, dirty-file list and
   reviewed diff. Do not enable a feature from an unreviewed dirty tree.
2. Run the complete backend suite and retain its exit code and summary. Run
   the focused V5 policy, writer-foundation and HTTP-route tests as part of the
   same evidence pack.
3. Run a disposable PostgreSQL test using a fresh database URL. Prove that
   concurrent issue requests cannot consume the same evidence twice, that a
   failure rolls back the invoice, lines, source consumption, event,
   idempotency and number-ledger records together, and that the next request
   receives a valid invoice number.
4. Run role-based UAT with fictional records only. Confirm Finance or Admin
   can prepare a draft, a different Finance or Admin user can issue it,
   Management can read the issued record, and Sales, Operations, field roles
   and Client Viewer cannot create, issue, or read records outside their role.
5. Confirm refusal cases: disabled flags, missing JSON acknowledgement,
   self-issue, stale draft hash, changed PO, changed evidence, uncovered or
   unallocated material, amendment coverage conflict, superseded allocations
   without remap, and legacy invoice on the dispatch.
6. Confirm the agreed V1 correction boundary with the release owner: issued
   records are append-only, source consumption is permanent, and no void,
   credit-note, refund, release, update, or delete path is being represented as
   available.
7. Obtain explicit written release approval. That approval must name the
   environment, database store, test evidence, responsible operator and the
   rollback owner. It must not be inferred from a development test result.

## Current Local Evidence

- The Finance/Admin evidence workspace is now implemented as the read-only
  `GET /dispatch_cards/:id/v5-invoice-draft-workspace` projection. It exposes
  only current selectable evidence, available source quantities, authority
  status and blockers; it never estimates or persists an invoice. Prepared
  drafts are listed through `GET /dispatch_cards/:id/v5-invoice-drafts` so a
  different authorised user can complete the two-person issue step.
- The internal frontend has a separate display-only
  `VITE_ORAC_V5_INVOICE_WRITER` gate in addition to the commercial V5 gate.
  The writer panel is Finance/Admin-only, sends evidence references and
  quantities only, displays server-calculated USD results, and remains hidden
  unless both client flags are deliberately built enabled. These client flags
  do not authorize requests and do not change the existing preview blocker.
- On 2026-10-22 the new backend workspace and writer route tests passed (30
  focused tests), the frontend V5 commercial/UI tests passed (19 tests), and
  the frontend production build completed successfully. Browser UAT still
  requires an isolated fictional fixture with both server flags intentionally
  enabled; no flag was enabled during these checks.

- The V5 writer policy, foundation and HTTP tests pass locally. The HTTP
  evidence covers disabled and unauthorized refusal, JSON-store refusal, a
  non-consuming draft, a separate authorised issuer, append-only source
  consumption, Management read access, stale-draft refusal, idempotent replay,
  changed draft evidence, legacy-invoice refusal, issue-time PO-ceiling
  rechecking, self-issue refusal, and two simultaneous issue attempts
  serialized by the single local JSON process on a fictional verified
  dispatch. Foundation evidence also independently refuses cross-lineage
  amendments both during calculation and during amendment supersession, and
  prevents cumulative hourly or material billing from exceeding a quote-line
  quantity ceiling when later evidence differs. Linked amendments also need a
  revision marker as well as dispatch-root lineage, approval and a verified
  PO. Invoice numbering advances from the highest append-only ledger sequence
  for the Africa/Harare year, so prior assignments cannot be repeated by a
  later issue. A draft remains immutable after preparation; its issued state
  is derived from the separate invoice record, and a second non-replay issue
  is refused. Draft reads are limited to Finance and Admin. A stateful fake
  PostgreSQL-adapter test also forces persistence failure and proves the
  invoice, lines, consumption, event, number ledger and issue idempotency
  record roll back together before a retry succeeds. That adapter test now
  also verifies that a PostgreSQL store identifies itself to the writer and
  requires no JSON single-process acknowledgement. A separate real-PostgreSQL
  release suite is present in `tests/v5InvoiceWriterPostgres.test.js`. It has
  four guarded cases: PostgreSQL issue without JSON acknowledgement, failed
  write rollback, same-key replay across two server instances, and competing
  source consumption across two server instances. On 2026-10-22 all four
  cases passed against the isolated local PostgreSQL 16.15 database
  `orac_v5_writer_test`. The run used two independent Express instances and
  PostgreSQL row locking; no feature flag was enabled and no application
  database was used. This closes the local-development evidence portion of
  Gate 3. It does not authorize release, replace deployment-environment
  verification, or prove behavior against a future hosted database setup.
- The complete backend suite completed successfully locally after the latest
  V5 writer changes. The release operator must still retain its own exact exit
  code and summary against the reviewed release checkout before enablement.
- The automated fictional API role-UAT scenario passes locally. It proves that
  Finance/Admin retain the writer path, Management is read-only after issue,
  and Sales, Operations, Supervisor, Technician, and Client Viewer are denied
  draft, issue, and issued-invoice reads. This is not browser/manual UAT and
  does not validate a deployed environment.
- The local PostgreSQL 16.15 service `orac-v5-postgres-test` is running on
  port 5432. The disposable test database is reserved for these guarded V5
  writer tests and must not receive application or user data.

## Explicit Non-Release Boundaries

- No feature flag is enabled by this document.
- No deployment, database migration, commit, push, production data access, or
  portal user-interface change is authorized by this document.
- Legacy invoice behavior remains separate from V5 invoice writing.

## Disposable PostgreSQL Test Runbook

Run this only after a fresh database whose name contains `test` has been
prepared. Do not use an application, UAT, shared, or production database. The
test suite clears the disposable `store` row before each scenario.

The preferred option for this laptop is a separate Neon project and database,
for example `orac_v5_writer_test`. The test rejects all remote URLs unless the
operator sets the explicit confirmation shown below; it also accepts only a
Neon host and a database name containing `test`. The existing ORAC Neon
connection string must never be used.

In Windows PowerShell, from the backend checkout:

```powershell
$env:ORAC_TEST_DATABASE_URL = "postgres://<local-user>:<local-password>@127.0.0.1:5432/orac_v5_writer_test"
node.exe --test tests/v5InvoiceWriterPostgres.test.js
Remove-Item Env:ORAC_TEST_DATABASE_URL
```

For a dedicated Neon test database only:

```powershell
$env:ORAC_TEST_DATABASE_URL = "postgres://<test-user>:<test-password>@<dedicated-test-host>.neon.tech/orac_v5_writer_test?sslmode=require"
$env:ORAC_TEST_DATABASE_ALLOW_REMOTE = "ORAC_V5_DISPOSABLE_ONLY"
node.exe --test tests/v5InvoiceWriterPostgres.test.js
Remove-Item Env:ORAC_TEST_DATABASE_URL, Env:ORAC_TEST_DATABASE_ALLOW_REMOTE
```

This command does not start the application, enable either V5 feature flag, or
read a `.env` file. A passing run is evidence for the four scenarios named in
the Current Local Evidence section only. Retain its complete output with the
reviewed checkout identity before requesting release approval.
