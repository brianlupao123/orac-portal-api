# Finance Role Manual

**Classification:** Internal
**Owner:** Pending company assignment
**Approver:** Pending company assignment
**Version:** 0.1
**Status:** Draft
**Last reviewed:** 2026-09-13
**Next review:** Before Phase 1 assistant rollout
**Source of truth:** `../src/permissions.js`, `../src/stateMachine.js`, `../src/controllers/coreController.js`, `../src/controllers/quoteController.js`
**Supersedes:** None

## Purpose

Describe the finance controls enforced by Orac-IOS for purchase orders, amendments, invoicing, voids, audit review, and Pastel export.

## What Finance Can Do

| Area | Current authority |
| --- | --- |
| Purchase orders | Verify a PO when the reference and positive amount are present. |
| Amendments | Approve a PO amendment. |
| Invoicing | Generate an invoice after all workflow guards pass. |
| Invoice correction | Void an eligible unpaid invoice with a non-empty reason; the system writes an audit record. |
| Accounting handoff | Export Pastel data through the protected export route. |
| Oversight | View audit information. |

Finance cannot create or authorize dispatches, review worksheets, administer inventory, manage users, clients, assets, catalog, or company profile.

## PO Verification

1. Confirm the PO relates to the correct quote.
2. Confirm its reference is present and its amount is greater than zero.
3. Record the verification through the application workflow.
4. Do not approve the linked field worksheet yourself after verifying its PO. Another permitted independent reviewer is required.

## Amendment Handling

The system marks a PO as requiring amendment only when logged labour and materials exceed the verified PO amount. Work below the PO amount does not require an amendment merely because it is below the ceiling.

When an amendment is required, invoicing remains blocked until the approved amendment clears the exception. Keep the amendment trail inside the system; do not use email, an export, or a comment as a substitute for the control.

## Invoice Readiness

Before generating an invoice, confirm all of the following:

1. A dispatch card exists.
2. The PO is verified and has a reference.
3. At least one linked field worksheet is `Supervisor_Approved`.
4. The PO does not require an unresolved amendment.

If the system blocks invoicing, resolve the specific failed prerequisite. Do not create a substitute invoice outside the workflow.

## Invoice Void

Use the dedicated invoice-void action only when a correction is necessary. It requires a non-empty reason and Finance or Admin authority. A paid invoice cannot be voided by this process. A successful void creates an audit event.

## Pastel Export

Pastel export is an accounting handoff after the operational and invoice controls are satisfied. Retain the source invoice and audit trail; the export does not replace them.

## Escalate When

| Situation | Escalate to |
| --- | --- |
| PO reference or amount is missing | Sales, Operations, or Admin to correct the commercial record |
| Field worksheet is not approved | Operations, Supervisor, or the responsible field role |
| PO verifier is also the planned worksheet approver | An independent permitted reviewer |
| Invoice is paid or void requires a business-policy exception | Admin and finance leadership |
| Accounting export does not reconcile with the source invoice | Admin and finance leadership; preserve the audit evidence |

## Evidence and References

- `src/permissions.js`
- `src/stateMachine.js`
- `src/controllers/coreController.js`
- `src/controllers/quoteController.js`
- `tests/financialRecordControls.test.js`
- `tests/segregationOfDuties.test.js`
- `tests/stateMachine.test.js`

## Changelog

| Version | Date | Change | Approved by |
| --- | --- | --- |
| 0.1 | 2026-09-13 | Initial source-referenced draft | Pending |
