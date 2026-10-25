# V5 Amendment Coverage Design

**Status:** the append-only allocation endpoint is implemented behind the V5
flag. Invoice calculation for linked amendments remains deliberately blocked;
no invoice writer is enabled by this document.

## Purpose

An approved amendment and its dispatch link prove commercial authorization,
but do not say which verified work or material quantity the amendment covers.
V5 coverage must be explicit so the same field evidence cannot be billed under
both the original quote and an amendment.

## Implemented Append-Only Record

`v5_amendment_evidence_allocations` will contain one record per allocated
source portion:

- `dispatch_card_id`, `amendment_quote_id`, `amendment_quote_line_id`
- source kind: `field_worksheet` or `material_usage`, and source ID
- allocated quantity and unit
- allocator, time, reason, idempotency key and request fingerprint

The record must reference an existing approved dispatch-amendment link and the
same currently verified amendment PO recorded at approval time. It never edits
the source Timesheet, material-use record, original quote, amendment quote, PO,
stock ledger, or invoice.

## Controls Before a Record Is Written

1. Sales/Admin only; feature-gated and idempotent. Direct controller calls also
   reject invalid source kinds, non-numeric/non-positive quantities and short
   reasons, rather than relying only on route validation.
2. The amendment line belongs to the linked revision and uses the matching
   pricing basis: labour evidence to `hourly`/`minimum_hours`, material evidence
   to `material` only.
3. Labour source is currently V5-verified and belongs to that dispatch.
4. Material source belongs to that dispatch, has the matching catalog item,
   and is not already allocated to an original quote line.
5. Total allocations for a source cannot exceed its verified hours or material
   quantity. Total allocations to a line cannot exceed its accepted amendment
   ceiling. Invalid source, line or previously stored allocation quantities fail
   closed. Decimal comparisons use a small numeric tolerance so exact sums such
   as `0.1 + 0.2 = 0.3` are accepted. Fixed-price lines use their existing
   completion rule, not a quantity allocation.
6. Every allocation is audited. Corrections require a separate reversal design;
   no update/delete endpoint is introduced.

## Preview and Future Writer

The current preview keeps returning an amendment-coverage blocker for a linked
approved amendment. It does not calculate those lines, consume allocations, or
write invoices. A future preview will subtract allocated source portions from
the original quote line evidence, calculate amendment lines from the amendment
snapshot, and enforce each linked PO ceiling independently. It must keep
returning a blocker when a source, line, PO, signature, allocation, ceiling or
prior billed coverage is ambiguous.

The future writer must atomically snapshot every calculated line and mark exact
source portions consumed. A retry with the same invoice key replays the same
invoice; a conflicting retry fails. Partial invoices remain allowed only for
unconsumed source portions. No legacy invoice writer may be reused.

## Deliberate Non-Claims

This design does not implement tax, FX, credit notes, refunds, accounting
export, stock valuation, bank settlement, or legal interpretation of a PO.
