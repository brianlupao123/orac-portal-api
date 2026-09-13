# Operations Role Manual

**Classification:** Internal
**Owner:** Pending company assignment
**Approver:** Pending company assignment
**Version:** 0.1
**Status:** Draft
**Last reviewed:** 2026-09-13
**Next review:** Before Phase 1 assistant rollout
**Source of truth:** `../src/permissions.js`, `../src/stateMachine.js`, `../src/controllers/dispatchController.js`
**Supersedes:** None

## Purpose

Describe the operational authority currently enforced for the Operations role. This manual is guidance only; the authenticated backend remains the authority for every action.

## What Operations Can Do

| Area | Current authority |
| --- | --- |
| Commercial handover | Approve a quote to `Approved_Pending_PO`; verify a valid PO. |
| Dispatch | Create a normal dispatch after PO verification, or use the controlled urgent pre-PO path. |
| Field evidence | Record timesheets and materials; create, submit, and review field worksheets. |
| Operational master data | Manage assets and inventory within the available application workflows. |

Operations cannot generate, void, or export invoices; approve PO amendments; manage users; or manage the company profile.

## Daily Operating Flow

1. Confirm that the quote is ready for operational approval.
2. Verify the PO only when it has a reference and a positive amount.
3. Create the dispatch after verification. For genuinely urgent work before a PO, record `started_before_po` and a meaningful urgent reason. Urgency creates a pending PO; it does not make a job invoice-ready.
4. Ensure field work is recorded against the dispatch through timesheets, material usage, and a field worksheet.
5. Review submitted worksheets in the permitted review scope. Approve only when the evidence is complete, or return it with a correction comment.
6. Hand the verified, reviewed work to Finance/Admin for invoice and export work.

## Review Controls

- Do not approve a worksheet you submitted.
- Do not approve a worksheet when you are the verifier of its linked PO.
- A returned worksheet must be corrected and resubmitted; do not bypass the review trail.
- When work exceeds the verified PO amount, the amendment control blocks invoicing until Admin or Finance resolves the approved amendment.

## Stock and Material Controls

- Record movements with the correct direction and quantity.
- A movement that would create negative stock requires the explicit authorized override path; it is not routine stock correction.
- Investigate a stock discrepancy before recording an override or escalating it.

## Escalate When

| Situation | Escalate to |
| --- | --- |
| PO is missing, invalid, or needs a commercial amendment | Finance or Admin |
| Invoice or export is required | Finance or Admin |
| You are the worksheet submitter or PO verifier | An independent permitted reviewer |
| A role sees data outside its assignment or review scope | Admin immediately; preserve the evidence |
| A negative-stock exception is required | Authorized Admin via the controlled inventory process |

## Evidence and References

- `src/permissions.js`
- `src/stateMachine.js`
- `src/controllers/dispatchController.js`
- `tests/stateMachine.test.js`
- `tests/segregationOfDuties.test.js`
- `tests/inventoryAdjustments.test.js`

## Changelog

| Version | Date | Change | Approved by |
| --- | --- | --- |
| 0.1 | 2026-09-13 | Initial source-referenced draft | Pending |
