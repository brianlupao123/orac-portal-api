# Controlled Commercial Pricing Policy and Implementation Proposal

**Status:** owner-approved first-release commercial policy, 20 October 2026.
The implementation sequence remains a proposal until each slice is built and
verified. This document does not authorize a deployment, production invoice,
feature-flag activation, or alteration of historical records.

## Why This Is Needed

ORAC already protects the operational chain:

`Lead -> Quote -> verified PO -> Dispatch -> approved field evidence -> amendment when needed -> Invoice -> manual USD settlement`

The remaining commercial gap is that legacy invoices calculate labour from
rate-bearing timesheet rows, while newer V5 field evidence is deliberately
rate-free. A catalog price is useful master data, but it is not proof of the
price a client accepted. A verified PO ceiling prevents overbilling; it does
not itself define what should be billed.

This proposal makes an accepted quotation revision the commercial source of
truth. Field evidence proves what happened. It never supplies or edits a rate.

## Approved First Release Policy

### Currency and money

- Currency is **USD** for this release. Every commercial record must carry
  `currency: "USD"`; cross-currency work is refused, not converted.
- New commercial calculations use integer USD cents. Decimal currency values
  are accepted only at the API boundary and converted once with an explicit
  rounding rule. Existing historical decimal records remain read-only and are
  not silently rewritten.
- Tax is **not yet configured**. Until an accounting owner approves tax codes,
  jurisdiction, inclusivity, rounding and reporting, ORAC must store
  `tax_status: "unconfigured"`, calculate no tax, and label totals as
  `pre_tax_amount`. It must not imply a tax invoice or statutory compliance.

### Price authority

1. A catalog price or a staff hourly rate is a pricing suggestion only. It is
   never invoice authority.
2. Sales creates a quote revision with a complete, USD price snapshot. Each
   line stores its description, unit, quantity, unit price, line amount,
   pricing basis, and source catalog item when applicable.
3. The client accepts the revision through a matching PO or documented written
   acceptance. Sales verifies the client reference, amount, currency, and
   linked quote revision.
4. The accepted revision becomes immutable. A change creates a new revision;
   it never edits the accepted revision or its lines.
5. An invoice can use only lines from the accepted revision, or from an
   approved amendment revision linked to it.

The commercial snapshot is the price promised to the client. The catalog and
internal cost records remain useful for estimating and margin review, but they
do not overwrite the accepted snapshot.

### Pricing bases

Each accepted quote line must use exactly one basis:

| Basis | Invoice rule | Required evidence |
| --- | --- | --- |
| `fixed` | Bill the locked line amount once its stated completion condition is met. | Approved field evidence and the line's completion rule. |
| `hourly` | Bill approved eligible hours allocated to that line, multiplied by the locked USD hourly price. | Approved field worksheet/Timesheet hours and line allocation. |
| `minimum_hours` | Bill the greater of the locked minimum quantity and approved allocated hours, never more than the accepted quantity without an amendment. | Approved field worksheet/Timesheet hours and line allocation. |
| `material` | Bill approved recorded quantity allocated to that line, multiplied by the locked USD unit price. | Linked material-usage record and stock-out evidence where stock is tracked. |

No pricing basis may read a field-worker-entered rate. Any evidence that cannot
be allocated to an accepted line is an exception for review, not an inferred
invoice charge.

### Dispatch and evidence allocation

- A dispatch stores the accepted quote revision that authorizes it. The
  initial verified PO remains mandatory before dispatch.
- Each billable labour or material evidence row carries a `quote_line_id` or
  is placed in a controlled allocation record by an authorized internal role.
- Allocations are append-only/audited. They identify source record, quantity,
  unit, quote line, allocator, time, and reason when the allocation is manual.
- Evidence may be recorded before an amendment, as already approved by the
  owner. It remains non-billable until its allocation is covered by an
  accepted revision and verified PO amount.

### Amendments during monthly reconciliation

When approved evidence exceeds an accepted quantity/value, or new work or
materials are needed:

1. ORAC records the variance and blocks invoice readiness for the uncovered
   amount. It does not reverse or hide the field evidence.
2. Sales creates an amendment quote revision containing the incremental,
   clearly identified work/material lines and a reason.
3. The client provides an amended PO or documented written acceptance referring
   to that revision.
4. Sales verifies the reference, currency, and amount. The verified PO amount
   must cover all non-voided invoices plus the amendment coverage required.
5. An independent Admin or Finance approver approves it during monthly
   reconciliation. The approver must not be the PO verifier. Requiring the
   approver also to differ from the amendment preparer is recommended below.
6. Invoice readiness is restored only for the evidenced, allocated amount that
   the approved amendment covers.

This retains the implemented rule that a dispatch is never authorized before
the initial PO is verified. An amendment is not an urgent-dispatch bypass.

### Invoice construction

The V5 invoice engine should produce immutable invoice lines from approved
allocations, not from mutable catalog prices or rate-bearing timesheets:

`invoice line = accepted quote-line snapshot + approved allocated evidence + calculation result`

Before creating an invoice it must confirm:

1. The dispatch links to an accepted USD quote revision and verified matching
   PO.
2. Each billed evidence record is approved, eligible, belongs to the dispatch,
   and has not already been billed for the same quantity.
3. Each allocation uses a permitted pricing basis and does not exceed the
   accepted quantity/value without an approved amendment.
4. The sum of non-voided invoices plus the proposed invoice does not exceed
   the verified PO amount.
5. Every amount is calculated in cents and the invoice stores a complete
   calculation snapshot: source IDs, accepted line ID/revision, quantity,
   unit price, discount, pre-tax total, tax status, and final total.

The existing manual USD settlement ledger remains after an invoice is issued.
It records receipts against the immutable invoice total; it does not calculate
commercial prices or prove bank clearance.

## Approved Role Separation

| Activity | Proposed authorized roles | Explicit boundary |
| --- | --- | --- |
| Create draft/revision and send quote | Sales, Admin | Operations, field roles and Client Viewer do not set commercial prices. |
| Verify client PO or amended PO | Sales, Admin, Finance, Operations | Verification checks evidence; it does not create an invoice or change a verified amount. |
| Dispatch work | Operations | Only after the initial PO is verified. |
| Record/approve field evidence | Existing field roles and independent reviewers | No rate or client price entry. |
| Prepare amendment revision | Sales, Admin | Cannot clear the invoice block by itself. |
| Approve amendment | Finance, Admin | Must differ from PO verifier; recommended also to differ from amendment preparer. |
| Generate/void invoice | Finance, Admin | Only from immutable commercial/evidence snapshots. |
| Record/reverse manual receipt | Finance, Admin | Existing idempotent USD receipt rules remain. |
| Read commercial/audit reporting | Existing scoped Admin, Management, Finance roles | Viewing does not confer a write permission. |

## Required Data Contract

This is the target contract for a new V5 pricing slice. It is not a request to
retrofit or overwrite historical records.

| Record | Required additions | Purpose |
| --- | --- | --- |
| Quote revision | `currency`, `tax_status`, immutable line snapshots, acceptance status, accepted timestamp | Preserve the exact commercial offer. |
| Quote line | `pricing_basis`, `quoted_quantity`, `unit_price_cents`, `line_total_cents`, completion rule, source catalog link | Define how a line can be billed. |
| Dispatch | `accepted_quote_revision_id` | Stop billing against an ambiguous quote version. |
| Evidence allocation | source record/type, quote line, quantity, unit, state, reason, actor/timestamp | Link what happened to what was accepted. |
| PO/amendment | linked revision, USD cents, verification evidence, independent approval evidence | Prove authorization coverage. |
| Invoice line | accepted snapshot, evidence/allocation IDs, calculation inputs/results in cents | Make invoice values reproducible. |
| Invoice | `currency`, `pre_tax_total_cents`, `tax_status`, `tax_total_cents`, `grand_total_cents` | Preserve the issued financial record. |

## Implementation Status and Sequence

**Completed local foundations:** V5 quote revisions preserve USD-cent line
snapshots, an explicit `tax_status: "unconfigured"`, a zero tax total, and a
pending commercial-acceptance state. `material` is an allowed quote-line
pricing basis. The controller and schema refuse a non-null tax rate. A V5
revision cannot be modified through the legacy quote-update route; only the
existing verified-PO action can mark it `po_verified`, record the linked PO
and reference, and write a quote audit event. This does not enable V5 invoice
generation or alter legacy invoice calculation.

**Completed local allocation foundation:** material evidence can now be linked
append-only by Sales/Admin to one matching catalog-backed `material` line on a
PO-accepted V5 quote. The read-only readiness projection shows allocation
provenance and blocks unallocated usage. It remains feature-gated and does not
calculate a price or create an invoice. The exact API contract is
`V5_MATERIAL_ALLOCATION_CONTRACT.md`.

**Completed local preview foundation:** a V5-gated, role-scoped read-only
invoice preview now calculates USD-cent hourly, minimum-hours and allocated
material candidate lines from the accepted quote snapshot and current verified
evidence. It reports, rather than hides, unmapped evidence, unallocated
material, accepted-quantity overruns, PO ceilings, prior invoice history and
missing fixed-line completion rules. It writes no invoice or financial record.
The exact contract is `V5_INVOICE_PREVIEW_CONTRACT.md`.

**Completed local amendment-approval foundation:** a V5 revision can retain
one append-only client amendment-evidence record and, after its own PO is
verified, be independently approved by Admin or Finance. The approver must
differ from the revision preparer, evidence recorder, and PO verifier. This
creates reconciliation evidence only; Sales/Admin may then append an
idempotent same-lineage link from that approved revision to the dispatch. It
does not make variance billable or change a PO. The exact boundary is
`V5_AMENDMENT_APPROVAL_CONTRACT.md`.

**Completed local V5 writer foundation, still dark:** the backend now has a
separate two-flag V5 invoice writer. It creates a non-financial draft from
exact source portions, re-computes that candidate under the existing request
lock before a different Finance/Admin user can issue it, assigns a Harare-year
number from an append-only ledger, and records immutable V5 invoice, line,
source-consumption, event and idempotency records separately from legacy
invoices. Draft records remain immutable; their issued state is derived from
the linked immutable invoice record. The request cannot carry a price, rate,
amount, tax or number.
Original evidence is reduced by amendment coverage and prior V5 consumption.
Minimum-hours and fixed lines require an assigned Supervisor's append-only
completion record bound to current V5-verified Timesheet evidence. A Finance or
Admin user who was not the amendment approver may append a same-lineage
supersession only before the earlier amendment has issued a line; its
unconsumed allocations then block issue until a separately reasoned remap moves
them to a compatible line on the replacement amendment. The writer does not
enable the existing preview, remove its amendment blocker, alter a legacy
invoice, enable either feature flag, or create a portal screen. Finance/Admin
may read a V5 draft; Management may read issued V5 invoices only.

**Still blocked:** the full amendment billing path (including broader
multi-line and real-data fixtures), portal screens, disposable PostgreSQL
concurrency and rollback proof, and release UAT. No V5 writer flag may be
enabled before those release gates are completed and explicitly approved.

**Verification:** after the quote, allocation, preview and amendment-approval
foundations, Windows `npm.cmd run maintain` passed **1,109/1,109** local tests
on the dirty backend checkout. This is automated fictional/disposable-data
evidence only; it is not production, accounting, browser-UAT, or deployment
certification.

1. **Policy sign-off:** record the decisions below. No V5 invoice write path
   is enabled before this step.
2. **Schema and migration design:** add new fields/tables for only new V5
   records. Build a read-only historical-record compatibility adapter; do not
   silently convert legacy decimal money.
3. **Quote snapshot/revision controls:** enforce immutable accepted revisions,
   USD cents, pricing bases, and client acceptance/PO linkage.
4. **Allocation and amendment workflow:** add audited evidence-to-line
   allocation, uncovered-variance reporting, amendment revision linkage, and
   separation-of-duties checks.
5. **V5 invoice calculation:** create deterministic line calculations with
   idempotent generation, duplicate-coverage prevention, PO ceiling and full
   invoice calculation snapshots.
6. **Portal implementation:** expose role-appropriate draft, evidence,
   amendment, invoice-preview, and receipt screens. The server remains the
   authority; the browser calculates nothing authoritative.
7. **Verification:** unit, real-router, JSON-store and PostgreSQL tests;
   fictional role-journey UAT; invoice calculation fixtures; negative access,
   rounding, retries, revision, allocation, amendment and double-billing
   cases; then explicit release approval.

## Owner-Approved Decisions

1. **Tax:** V5 retains `unconfigured` tax status and calculates zero tax until
   an accounting owner supplies approved tax rules.
2. **Acceptance:** a verified client PO is the required commercial acceptance.
3. **Fixed price:** the fixed line becomes billable after Supervisor approval.
4. **Minimum hours:** bill the greater of quoted minimum and approved allocated
   hours. Travel and waiting time are not eligible unless quoted as a distinct
   line.
5. **Discounts:** no post-acceptance discount; a commercial change requires a
   new quote revision.
6. **Amendment separation:** the approver must differ from both the PO verifier
   and amendment preparer.
7. **Partial invoicing:** allowed; the ordinary immutable invoice number is the
   client-facing reference.
8. **Credit notes/refunds:** unsupported in the first release.
9. **Historical invoices:** read-only evidence; V5 does not re-price them.

## Explicit Non-Claims

This proposal does not certify a tax invoice, accounting compliance, bank
reconciliation, payment finality, margin correctness, legal enforceability of
a client document, FX conversion, or deployment readiness. It provides the
precise business and engineering contract needed to implement a controlled V5
commercial workflow without weakening the existing PO, evidence, amendment,
invoice, or receipt protections.
