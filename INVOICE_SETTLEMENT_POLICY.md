# Invoice Settlement Policy

## Scope

This is a manual, append-only USD receipt ledger for an issued ORAC invoice.
It is not a tax engine, bank integration, payment gateway, foreign-exchange
ledger, credit-note system, or accounting-system export.

## Controls

- Only Admin and Finance may record or reverse a receipt.
- A receipt needs a unique reference, positive amount, received date, payment
  method, and an `Idempotency-Key` UUID header. The same key from the same
  actor replays only the original request; a changed request is refused.
- The recorded receipt cannot exceed the invoice's remaining USD balance.
- Active receipts move an invoice from `sent` to `partially_paid` or `paid`.
- Reversal never deletes the receipt. It records who reversed it, when, and
  why, then recalculates the outstanding balance.
- A voided invoice cannot receive another receipt. Reverse any receipt before
  voiding an otherwise eligible invoice.
- Admin, Finance and Management may read settlement evidence. Recording and
  reversal remain Admin/Finance-only. Client Viewer receives its existing
  scoped invoice status, not internal receipt references or payment methods.

## Outstanding Decisions

Before accounting or production use, approve tax/fiscal fields, FX policy,
bank statement reconciliation, credit-note/refund treatment, retention and
access rules for payment evidence, and the accounting/export authority.
