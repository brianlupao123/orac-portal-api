# V5 Invoice Writer Fictional UAT

## Purpose

This checklist is release evidence for the separate V5 invoice writer. Run it
only against an isolated fictional fixture and a disposable PostgreSQL test
database. It does not authorize deployment, feature enablement, use of an
application database, tax invoices, accounting export, or removal of the
read-only preview blocker.

## Preconditions

1. Capture the checkout root, branch, commit, dirty-file list, and full test
   output alongside this checklist.
2. Use fictional Finance, Admin, Management, Sales, Operations, Supervisor,
   Technician, and Client Viewer accounts only.
3. Use an isolated V5 quote in USD with unconfigured tax, a verified PO, one
   dispatch, and current verified Timesheet evidence. Do not reuse evidence
   from another scenario.
4. Use PostgreSQL, not the JSON store. Record the database name but never its
   connection string or password.
5. Enable both V5 flags only inside the isolated UAT runtime. Confirm neither
   flag is set in any shared or deployed environment.

## Role Matrix

| Role | Prepare draft | Issue another user's draft | Read issued invoice | Expected boundary |
| --- | --- | --- | --- | --- |
| Admin | Allowed | Allowed, except own draft | Allowed | Cannot issue own draft |
| Finance | Allowed | Allowed, except own draft | Allowed | Cannot issue own draft |
| Management | Denied | Denied | Allowed | Read-only issued record access |
| Sales | Denied | Denied | Denied | May use the separate preview only |
| Operations | Denied | Denied | Denied | No commercial writer access |
| Supervisor | Denied | Denied | Denied | May record assigned-line completion only |
| Technician | Denied | Denied | Denied | No commercial writer access |
| Client Viewer | Denied | Denied | Denied | No V5 writer access |

## Required Scenarios

1. Finance prepares a valid draft. Verify it has no invoice number and no
   source-consumption record.
2. A different Finance or Admin user issues that draft. Verify one immutable
   invoice, its lines, source consumption, event, idempotency record, and
   Harare-year invoice number exist.
3. The preparer attempts to issue the same draft. Expect
   `V5_INVOICE_TWO_PERSON_REQUIRED` and no new records.
4. Management reads the issued invoice. Sales, Operations, Supervisor,
   Technician, and Client Viewer each attempt the same read and receive a role
   denial without invoice details.
5. Change the verified PO amount or V5 evidence after draft preparation, then
   attempt issue. Expect a stale or authority refusal and no consumption.
6. Create two drafts that together request more than the same evidence source
   can supply. Issue them concurrently from different authorised users. Verify
   exactly one succeeds and source consumption never exceeds source capacity.
7. Repeat an issued command with the same permitted idempotency key. Verify
   replay returns the original invoice and creates no second invoice.
8. Attempt a disabled-flag request in the same fictional runtime before the
   UAT-only flags are enabled. Expect `FEATURE_DISABLED` and no mutation.
9. Confirm the preview still returns its amendment-coverage blocker where the
   existing preview contract requires it; writer UAT must not remove or bypass
   that boundary.

## Evidence To Retain

- Checkout capture and reviewed diff.
- Full backend-suite result and focused V5 test output.
- PostgreSQL four-case concurrency/rollback output.
- Role, route, HTTP status, result code, record IDs, and screenshot or API
  transcript for every scenario above. Never retain passwords, tokens, raw
  connection strings, or personal/client data.
- A signed release decision naming the specific environment, database store,
  rollback owner, and responsible operator.

## Pass Condition

All scenarios pass against fictional records, every denial exposes no invoice
details, and the release owner accepts the correction boundary: issued records
and their source consumption are append-only until a separately approved
void/credit-note design exists.
