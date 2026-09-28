# Direct-Sale Stock Issue — PROPOSED Contract for Chat C (Commercial Flow)

> **STATUS: PROVISIONAL, NOT RECONCILED.** Nothing in the attached source or role
> packets (Finance, Management, Operations) defines a "direct sale" transaction,
> and Chat C's merged output was not available to this chat. This is a proposal for
> Chat C to accept, change or reject. The endpoint ships **dormant**: it returns 404
> (changing neither balance nor ledger) unless `ENABLE_DIRECT_SALE_STOCK_ISSUE=true`
> is set. Do not enable it until Chat C has reconciled the request fields, the
> permission model and the sale-approval step below.


## Boundary

**Chat G (inventory) owns:** whether enough stock exists, moving the balance
atomically, and recording an immutable, traceable ledger entry.

**Chat C (Client Viewer / Sales / Finance) owns:** everything about the sale
itself — whether a direct/walk-in sale is allowed to happen at all, who may
authorise one, pricing, tax, invoicing, and payment. **Call this endpoint only
after your side has already decided the sale is approved.** This endpoint has
no concept of price, invoice, or approval status — it issues stock and nothing
else.

This split is deliberate. The Phase 3 assignment for this chat explicitly
says not to assume sale approval, valuation/costing, or tax — those stay
entirely on Chat C's side. If Chat C's design later needs this endpoint to
also carry a price/currency for a stock-valuation feature, that is a new,
separate conversation with whoever owns costing — not something to bolt onto
this endpoint by guessing.

## Endpoint

```
POST /inventory/movements/direct-sale
```

**Permission required:** `manageInventory` (currently Admin, Management,
Operations — see "Open question" below).

### Request body

```json
{
  "stock_item_id": "si_abc123",
  "quantity": 4,
  "reason": "Counter sale to walk-in client — receipt #4821",
  "client_id": "c_walkin",
  "sale_reference_id": "your-sale-or-order-id",
  "override_negative": false
}
```

| Field | Required | Notes |
|---|---|---|
| `stock_item_id` | yes | Must already exist (`GET /inventory/stock_items`). |
| `quantity` | yes | Positive number. This endpoint always issues (decreases stock) — there is no "receipt via direct sale" case. |
| `reason` | yes | Free text. Put whatever your side needs to trace it back (e.g. a receipt/order number) in here as well as in `sale_reference_id`. |
| `client_id` | yes | Must reference a real client record. If it doesn't resolve, the ledger still records the movement (it does not block on this) but the reference label says the client wasn't found, and it is your side's responsibility to fix the id — this endpoint will not guess or default to any client. |
| `sale_reference_id` | yes | Whatever id your system uses for the underlying sale/order/receipt. This ledger does not validate it exists in your data — it is stored and displayed as-is. |
| `override_negative` | no | Only takes effect if the caller's role is Admin or Operations. If your Sales/Finance flow needs to allow a negative-stock override, that decision (and who approves it) is yours — this field alone doesn't unlock it. |

### Success response — `200`

```json
{
  "success": true,
  "data": {
    "movement": {
      "id": "smv_...",
      "stock_item_id": "si_abc123",
      "movement_type": "out",
      "direction": "decrease",
      "quantity": -4,
      "quantity_before": 10,
      "quantity_after": 6,
      "unit_of_measure": "each",
      "reason": "Counter sale to walk-in client — receipt #4821",
      "reference_id": "your-sale-or-order-id",
      "reference_type": "direct_sale",
      "client_id": "c_walkin",
      "reference_label": "Direct sale issue — sale your-sale-or-order-id — Walk-in Client",
      "override_negative": false,
      "actor_id": "u_...",
      "created_at": "2026-09-27T19:30:00.000Z"
    },
    "stock_item": { "...": "the updated stock item, including new quantity_on_hand" }
  }
}
```

### Failure responses

| Status | When | Body |
|---|---|---|
| `404` | `stock_item_id` doesn't exist | `{ "success": false, "message": "Stock item not found." }` |
| `409` | Issuing this quantity would take stock below zero and `override_negative` wasn't set | `{ "success": false, "message": "Insufficient stock. On hand: <n> <unit>. Pass override_negative:true with Admin or Operations role to force." }` |
| `403` | `override_negative` was set but the caller's role isn't Admin/Operations, **or** the caller lacks `manageInventory` at all | `{ "success": false, "message": "..." }` |

On every failure, **neither the on-hand balance nor the ledger changes** —
same atomicity guarantee as every other movement endpoint (see
`inventoryLedger.js` → `applyStockChange`).

## What this endpoint deliberately does NOT do

- Does not check whether a sale was approved, priced, or invoiced.
- Does not create or touch anything in a quotes/invoices/orders table.
- Does not know what "direct sale" means to your workflow beyond "stock left
  the building for this client, for this sale reference, for this reason."
- Does not validate `client_id` or `sale_reference_id` against your records —
  if you pass a bad id, the ledger just says so in the label; it's on your
  side to pass the right one.

## Open question — owner decision, not guessed here

This endpoint currently requires `manageInventory` (Admin/Management/
Operations), the same permission every other inventory-write endpoint
requires. It does **not** grant Sales or Finance direct write access to
stock, because that is a permission-model expansion this chat has no mandate
to decide.

If your design needs Sales or Finance to trigger a stock issue themselves
(rather than routing it through an Operations-held credential, or a
service-account call your backend makes after its own approval step), that
needs an explicit decision from whoever owns the permission model (Chat E /
the project owner) about whether to extend `manageInventory` or add a new,
narrower permission scoped to this one endpoint. Logged here rather than
assumed.

## Read-side: seeing direct-sale issues in the ledger

Direct-sale movements show up in the normal ledger reads, decorated the same
way as everything else:

- `GET /inventory/movements?stock_item_id=<id>&reference_type=direct_sale&client_id=<id>` — ledger, each filter optional and combinable (e.g. all direct-sale issues for one client)
- `GET /inventory/stock_items/:id/movements` — one item's full history

Each decorated movement includes `client_name` (resolved from `client_id`
when it exists) alongside the existing `item_code`, `item_name`, and
`actor_name` fields, so a direct-sale entry is fully readable without a
second lookup.
