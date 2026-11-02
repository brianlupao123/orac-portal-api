# Invoice Settlement Frontend Contract

## Scope

This contract describes the backend API available to a future internal portal
settlement view. It does not authorize a payment provider, bank reconciliation,
tax calculation, foreign exchange, credit notes, refunds, or accounting export.

All amounts are USD decimal amounts supplied and returned by the existing API.

## Read Settlement Evidence

`GET /api/invoices/:id/settlement`

Allowed roles: Admin, Finance, Management.

The response is read-only and contains the invoice id, invoice number, current
invoice status, a settlement summary, and receipt evidence. The settlement
summary contains `currency`, `total_amount`, `paid_amount`,
`outstanding_amount`, and `payment_count`.

Receipt evidence includes its id, amount, currency, payment method, reference,
received date, notes, recorder and reversal metadata. It deliberately omits the
idempotency key and request hash. A `403` means the signed-in role has no
settlement-evidence access.

Client Viewer must continue to use its existing scoped invoice-status view. Do
not show internal receipt references or payment methods to a client.

## Record a Receipt

`POST /api/invoices/:id/payments`

Allowed roles: Admin and Finance only.

Send an `Idempotency-Key` request header and this JSON body:

```json
{
  "amount": 125.5,
  "payment_method": "bank_transfer",
  "reference": "BANK-RECEIPT-123",
  "received_on": "2026-10-20",
  "notes": "Optional internal note"
}
```

Allowed methods are `bank_transfer`, `cash`, `card`, and `other`. The server
returns the stored receipt and recalculated settlement summary. A retry of the
same request by the same actor replays the original result and sends
`Idempotency-Replayed: true`. Reusing that key with changed content returns
`409`. A duplicate active receipt reference, an amount above the outstanding
balance, an invalid body, or a voided invoice is refused. The portal must show
the server response rather than treating any local form submission as proof of
payment.

## Reverse a Receipt

`POST /api/invoices/:id/payments/:paymentId/void`

Allowed roles: Admin and Finance only. Send a validation-compliant reason in
the request body. The original receipt remains visible with reversal metadata;
it is never deleted. The response contains the recalculated settlement summary.

## UI Rules

- Management can inspect evidence but must not receive record or reverse
  controls.
- Finance and Admin controls should require a deliberate confirmation before a
  write and must surface server errors verbatim enough for an operator to act.
- Display `sent`, `partially_paid`, and `paid` as settlement state, not bank
  clearance or accounting finality.
- Never invent a receipt reference, payment success, bank confirmation, or
  exchange rate.
- Keep the screen behind the existing authenticated internal-portal route and
  use the signed-in user's server authorization as the source of truth.
