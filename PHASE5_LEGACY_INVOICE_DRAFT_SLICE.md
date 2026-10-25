# Phase 5 Legacy Invoice Draft Slice

## Implemented

The legacy commercial invoice path now has a controlled draft-and-issue boundary.

- Finance or Admin can prepare a legacy invoice draft for an invoice-ready legacy dispatch.
- Preparation is non-financial: it creates no invoice, invoice line, invoice number, or quote transition.
- The stored draft includes a server-derived evidence and commercial candidate hash.
- A different Finance or Admin user must issue the prepared draft.
- Issue rechecks invoice readiness and the candidate hash before it creates the existing legacy invoice record.
- Direct `Field_Dispatch -> Invoiced` transition requests are refused with `LEGACY_INVOICE_DRAFT_REQUIRED` before they can mutate the quotation.
- V5 commercial quotations are refused from this path with `V5_INVOICE_PATH_REQUIRED`.
- The existing invoice PDF, Pastel review export, settlement/payment, payment reversal, and invoice-void controls remain the downstream legacy controls.

## Changed Files

Backend:

- `src/permissions.js`
- `src/store.js`
- `src/schemas.js`
- `src/stateMachine.js`
- `src/router.js`
- `src/controllers/legacyInvoiceDraftController.js`
- `tests/legacyInvoiceDraftHttp.test.js`

Existing legacy invoice test fixtures were updated to call the internal controlled issuer helper rather than the now-refused direct transition:

- `tests/stateMachine.test.js`
- `tests/financePilotControls.test.js`
- `tests/directSaleSeamGuard.test.js`
- `tests/task03KioskDuplicatesAndInvoice.test.js`
- `tests/timesheetWorkflowSteps3To9.test.js`

Portal:

- `D:\Projects\ORAC-WORKSPACE\2-portal-frontend\orac-ios-frontend\src/api/client.js`
- `D:\Projects\ORAC-WORKSPACE\2-portal-frontend\orac-ios-frontend\src/components/LegacyInvoiceDraftPanel.jsx`
- `D:\Projects\ORAC-WORKSPACE\2-portal-frontend\orac-ios-frontend\src/pages/FinanceCommercialPage.jsx`

## Verification

Focused backend suites passed:

- `tests/legacyInvoiceDraftHttp.test.js`
- `tests/invoiceSettlementHttp.test.js`
- `tests/invoiceReadinessConsistency.test.js`
- affected legacy invoice, stock seam, kiosk, and state-machine suites: 57 passed, 0 failed.

The focused draft test proves:

- direct invoice transition is refused without a state mutation;
- draft preparation is idempotent and creates no financial record;
- the preparer cannot issue their own draft;
- a second Finance user can issue it;
- stale evidence and V5 requests are refused.

Portal production build passed with `npm run build`.

## Deliberately Remaining

- No PostgreSQL migration, credential, service, deployment, public-site, or V5 change was made.
- Payment settlement, reversal, void, PDF, and Pastel-review export use their existing guarded legacy routes; their UI consolidation is a later Phase 5 slice.
- Production tax configuration remains an accounting gate. The provisional 15% VAT fixture is not a production tax approval.
- Phase 3B partial-PO allocation remains deferred.

