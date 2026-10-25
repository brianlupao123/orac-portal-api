# V5 Invoice Preview Contract

**Status:** local, feature-gated, read-only backend foundation. Not an invoice
writer, deployment, tax invoice, accounting integration, or release approval.

## Endpoint

`GET /api/dispatch_cards/:id/v5-invoice-preview`

The route requires `ORAC_V5_COMMERCIAL_WORKFLOW=enabled`. When the flag is
unset it returns `409 FEATURE_DISABLED` and changes no record. Admin, Sales,
Finance and Management may read the preview; it grants no ability to issue an
invoice. Field roles and Client Viewer are denied.

## What It Calculates

The preview uses only the immutable V5 quote-line USD-cent snapshot and current
V5-verified field evidence. It never reads a field-entered hourly rate, stock
cost, catalog price, or legacy invoice calculation.

- `hourly`: verified mapped hours multiplied by the accepted unit price; hours
  above the accepted quantity are blocked for amendment.
- `minimum_hours`: once verified mapped hours exist, the quantity is the greater
  of the quoted minimum and verified hours. `planned_hours` is required as the
  accepted ceiling and an overrun is blocked for amendment.
- `material`: controlled material allocation quantity multiplied by the accepted
  material-line snapshot. Unallocated or over-quantity material is blocked.
- `fixed`: bill the locked quantity and snapshot price only when the immutable
  line records `completion_rule: "supervisor_confirmed_timesheet"` and at least
  one mapped V5-verified Timesheet exists. Any older fixed line without this
  explicit rule remains blocked rather than being inferred.

The response returns integer cents, `currency: "USD"`, `tax_status:
"unconfigured"`, zero tax, accepted-line IDs and source evidence IDs. It
returns `preview_only: true`; it never writes an invoice, invoice line, audit
event, evidence record, allocation, stock movement, or settlement record.

## Required Controls

`ready_to_create_in_future` is false when any blocker exists. Important blocker
classes include absent or mismatched verified PO, non-USD/invalid quote snapshot,
unmapped verified hours, unallocated material, an accepted-quantity overrun,
missing fixed completion rule, prior non-voided invoice history, and a verified
PO ceiling breach.

An approved V5 amendment linked to the dispatch is returned with its revision
and PO identifiers. Until controlled source-evidence coverage across that
revision chain is implemented, it adds
`V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED` and the preview remains non-ready.

Partial invoicing is represented by omitting untouched accepted lines. It does
not make a line billable without qualifying evidence. Existing historical
invoices are not re-priced. A dispatch with any non-voided existing invoice is
blocked for controlled migration review before a future V5 invoice writer can
be introduced.

## Deliberate Next Boundary

This preview remains separate from the gated V5 writer foundation. The writer
has its own two-flag gate and immutable V5 records; it does not remove or reuse
this preview's `V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED` blocker. The preview is
therefore still read-only and may remain non-ready even when the writer's
guarded draft route exists. Removing that blocker requires the outstanding
amendment supersession/remapping, PostgreSQL and release-UAT gates.
