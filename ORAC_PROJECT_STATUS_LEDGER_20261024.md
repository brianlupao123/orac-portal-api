# ORAC Project Status Ledger

Date: 2026-10-24
Authoritative checkout:
`C:\Users\BRIAN LUPAO\Desktop\ffims-asset-register\two-concept-packet-backend-20261005-235259`

## Purpose

This ledger documents the implementation, repair, TLS policy hardening, deterministic test repair, and full verification of the Phase 2 Controlled Quotation Journey, strictly adhering to the operating rule established on 2026-10-22.

## Packet Name

`ORAC-CONTROLLED-QUOTATION-PHASE-2-VERIFICATION-20261024`

## Files Changed

### Backend (`two-concept-packet-backend-20261005-235259`)
- `src/stateMachine.js`:
  - Added production tax issuance gate: when `(process.env.NODE_ENV || "development") === "production"` or `process.env.ORAC_REQUIRE_APPROVED_TAX === "true"`, issuing a quotation with `tax_status === "provisional"` or `!quote.tax_approved` is blocked with HTTP 400.
- `src/controllers/documentController.js`:
  - Updated `wpMap` fallback logic at line 351: `wp.title || wp.name || wp.id` to support both property names in work package headers.
- `src/schemas.js`:
  - Application Zod validation schema updated: `WorkPackageSchema` accepts `title` and/or `name` and normalizes both via `.transform()`. (PostgreSQL database DDL schemas/migrations remained untouched).
- `src/pool.js`:
  - Hardened loopback host check (`localhost`, `127.0.0.1`, `::1`) requiring explicit `sslmode=disable`, strictly enforcing `{ rejectUnauthorized: true }` for any hosted or remote endpoint (e.g. Neon). Exported `sslConfig(databaseUrl)` for behavioural testing.
- `tests/databaseTls.test.js`:
  - Replaced brittle source-text regex test with 8 behavioural tests exercising `sslConfig` across local loopback and hosted configurations, as well as parameter stripping via `secureConnectionString`.
- `tests/quotationHttpEnforcement.test.js` (NEW):
  - 28 automated integration tests covering the USD 5,000 boundary (500000 vs 500001 cents), commercial discount gate, maker-checker separation of duties, role unauthorized blocks, production tax gating, client tenancy isolation, and historical totals preservation.

### Frontend (`orac-ios-frontend`)
- `src/pages/QuotationsPage.jsx`:
  - Updated import to include `CANONICAL_UNITS_OF_MEASURE` from `../quoteModel.js`.
  - Replaced `APPROVED_UNITS_OF_MEASURE` with `CANONICAL_UNITS_OF_MEASURE` in line-item modal dropdown, ensuring exactly the 10 approved units appear without ASCII duplicates (`m2`, `m3`).
- `src/quoteModel.js`:
  - Work package payload builder passes both `title` and `name` properties.
- `tests/task03FieldStatusAndDrafts.test.js`:
  - Repaired nondeterministic assertion: parses stored JSON with `JSON.parse` and asserts that the sanitised draft payload `stored.data` does not contain `hourly_rate`, eliminating random false failures caused by millisecond timestamps containing `"45"`.

## Tests Run & Exact Pass/Fail Results

1. **Deterministic Test Stability Run** (`tests/task03FieldStatusAndDrafts.test.js`):
   - 50 consecutive test executions: **50/50 passed (100% deterministic)**.
2. **Backend Full Regression Suite**:
   - Total test files: 122
   - Total tests passed: **1,230**
   - Total tests failed: **0**
   - Total tests skipped: **4** (`tests/v5InvoiceWriterPostgres.test.js` without live Neon URL)
3. **Isolated Database TLS Suite** (`tests/databaseTls.test.js`):
   - Total tests: 8
   - Passed: **8**
   - Failed: **0**
   - Skipped: **0**
4. **Focused Quotation Test Suites**:
   - `tests/quoteCalculation.test.js`: 11 passed, 0 failed.
   - `tests/quoteLineSchema.test.js`: 9 passed, 0 failed.
   - `tests/quotationApprovalGates.test.js`: 19 passed, 0 failed.
   - `tests/controlledQuotePdf.test.js`: 3 passed, 0 failed.
   - `tests/quotationHttpEnforcement.test.js`: 28 passed, 0 failed.
   - Total focused quotation tests: **70 passed**, 0 failed.
5. **Frontend Test Suite**:
   - `npm test -- --run`: **478 passed**, 0 failed, 0 skipped (Duration: 24.50s).
6. **Frontend Production Build**:
   - `npm run build`: **PASSED** in 14.45s.
   - Chunks: `dist/index.html` (1.56 kB), `dist/assets/index-CL9f21Xj.css` (66.45 kB), `dist/assets/index-Dc7aPu8I.js` (703.99 kB).
7. **Playwright Browser UAT** (`scripts/phase2_browser_uat.mjs`):
   - Assertions: **10 passed, 0 failed (100%)**.
   - Verified: Sales quotation creation (HTTP 200), Work packages & 10 UoMs, Provisional VAT notice, Threshold approval notice, Management approval view, Finance document access, Client draft invisibility (0 draft badges), Client USD currency, Controlled PDF binary generation, Responsive viewports (Desktop, Tablet, Mobile).

## Failed or Invalid Attempts Retained for Context

- **PowerShell inline script quoting**: Early node evaluation commands in PowerShell stripped quotes; resolved by saving test scripts to disk.
- **Work package title mismatch during UAT**: `POST /api/quotes` initially returned 400 Bad Request because the frontend form initialized `name` while the backend schema strictly required `title`. Harmonized in application validation `WorkPackageSchema` and `quoteModel.js`.
- **Database TLS test expectation reconciliation**: Source-text regex was replaced with behavioural tests of `sslConfig()`, and `src/pool.js` was hardened to permit SSL disabling only on local loopback hosts (`localhost`, `127.0.0.1`, `::1`) when `sslmode=disable` is explicit, bringing the backend test suite to 1,230 passing, 0 failing.
- **Nondeterministic timestamp string matching in frontend test**: `tests/task03FieldStatusAndDrafts.test.js` checked `!s.getItem(...).includes("45")` across the entire unparsed envelope string including `saved_at: Date.now()`. Repaired to parse JSON and inspect `stored.data`, verified 50 times consecutively.

## Preserved Systems & Protected Scope

- `orac-systems-demo` (public site & Phase 1 intake receipt): **100% UNTOUCHED** (HEAD `56965c9`).
- V5 invoice writer foundation and policies: **100% UNTOUCHED**.
- PostgreSQL database DDL migrations / live database tables: **100% UNTOUCHED** (no database migrations were executed; changes were strictly in Node.js application code and validation schemas).
- No commits, pushes, migrations, or deployments were performed.

## Remaining Open Gates

1. V5 commercial flags remain disabled and dark by default.
2. Accounting confirmation required before production tax configuration can be marked approved.
