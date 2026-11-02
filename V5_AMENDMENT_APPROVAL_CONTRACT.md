# V5 Amendment Approval Contract

**Status:** local, feature-gated, reconciliation-control foundation. This is
not invoice generation, amendment coverage calculation, a tax treatment, or a
release approval.

## Endpoint

`POST /api/quotes/:id/approve-amendment`

The endpoint requires `ORAC_V5_COMMERCIAL_WORKFLOW=enabled` and the
`approveV5Amendment` permission (Admin or Finance). With the flag unset it
returns `409 V5_WORKFLOW_DISABLED` and writes nothing.

## Required Record Chain

The target must be an immutable V5 quote revision, not a base quote. Before
approval, it must have:

1. one recorded amended-PO or written-acceptance evidence record;
2. a linked V5 PO whose status is `verified`; and
3. no prior V5 amendment approval.

Client evidence is append-only. A second submission for the same revision is
refused with `V5_AMENDMENT_EVIDENCE_IMMUTABLE`; a correction requires a new
revision. The normal PO verification action remains responsible for recording
the PO reference and amount and for associating it with the revision.

## Separation of Duties

The approver must differ from all of the following people on the same V5
revision: the revision preparer, the client-evidence recorder, and the PO
verifier. The controller returns `403 V5_AMENDMENT_SEPARATION_OF_DUTIES` if
that boundary is not met. Sales has no approval permission.

On success ORAC appends `v5_amendment_approval` to the revision and emits the
`V5_AMENDMENT_APPROVED` audit event. The record keeps the approver, time,
linked verified PO, evidence reference, and optional approval note.

## Dispatch Link

`POST /api/dispatch_cards/:id/v5-amendment-links` lets Sales or Admin append
the approved amendment to the exact dispatch it covers. It requires an
idempotency key and refuses a cross-lineage revision, an unapproved amendment,
an unverified linked PO, a duplicate link, or a changed retry. The public
response omits its idempotency internals; the append-only link and its audit
event retain the dispatch, base quote, amendment quote, PO, actor and time.

## Deliberate Boundary

Approval proves that the amendment was independently reconciled; it does not
re-price an old quote, increase a PO, move existing evidence to another quote
line, clear a V5 invoice-preview blocker, or create an invoice. The dispatch
link establishes the needed traceability but V5 amendment coverage across
accepted revision chains and deterministic invoice generation remain separate
work.

The read-only V5 invoice preview reports every linked approved amendment and
returns `V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED` while its source evidence has
not been allocated across the revision chain. This is fail-closed: an
amendment link can never disappear from the preview or be treated as automatic
billing authority.

`V5_AMENDMENT_COVERAGE_DESIGN.md` defines the next append-only allocation and
duplicate-billing controls required before that blocker can be removed.
