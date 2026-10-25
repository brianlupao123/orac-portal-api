# V5 Material Evidence Allocation Contract

**Status:** local, feature-gated backend control. Not an invoice engine,
production release, stock-pricing change, or frontend implementation.

## Purpose

Operational staff record material consumption through the existing material-use
and stock-ledger workflows. Those records may include an internal cost, but
that cost is never client price authority. This V5 control lets Sales or Admin
make one explicit, append-only link from a recorded, catalog-backed material
usage record to an accepted V5 `material` quote line.

## Endpoint

`POST /api/dispatch_cards/:id/v5-material-allocations`

The V5 commercial workflow must be enabled. The caller must be Admin or Sales.
The request must include `material_usage_id`, `quote_line_id`, and an
idempotency key, supplied either as `idempotency_key` or `Idempotency-Key`.

The server refuses the request unless all of the following are true:

1. The dispatch exists and links to a V5 quotation.
2. That quotation is commercially accepted (`po_verified`).
3. The material usage belongs to the dispatch.
4. The quote line belongs to that quotation and has `pricing_basis: material`.
5. Both records name the same non-empty catalog item. Description matching is
   intentionally not accepted.
6. The source material usage has not already been allocated to either an
   original V5 quote line or an amendment line. The first append-only
   allocation owns the usage; the opposite path refuses it.

The response contains evidence identity, quantity, unit, allocation actor and
time. It deliberately omits material cost, quote price and idempotency
internals. A retry from the same actor with the same key and request replays
the original allocation; a changed request with the same key is refused.

## Readiness Projection

`GET /api/dispatch_cards/:id/v5-billing-readiness` remains read-only and
rate-free. For each quote line it now returns allocated material quantity and
source material-use IDs. It returns unallocated material evidence separately
and blocks pricing review until that evidence is allocated or handled through
the amendment workflow. The view never calculates an invoice.

## Boundaries

- The endpoint does not create or modify material usage, stock movements,
  catalog prices, quote prices, POs, amendments, invoices or receipts.
- Uncatalogued/ad-hoc material remains a visible exception. It needs an
  approved commercial amendment or separate review; ORAC does not infer a
  price from text or internal cost.
- Allocations are append-only and audited. A reversal/reallocation workflow
  has not been implemented; it must preserve the original allocation and use
  an independent, reasoned event.
- V5 invoice generation remains blocked pending deterministic pricing,
  amendment-coverage checks and duplicate-billing prevention.

## Verification

Focused tests cover the dark flag, PO acceptance, role boundaries, catalog
match, idempotent replay/conflict, double-allocation refusal, cost omission,
audit event and read-only readiness projection. Full local maintenance results
are recorded in the current handover after each complete gate.
