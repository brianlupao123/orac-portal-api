# Quote to Pastel Workflow Guide

**Classification:** Internal
**Owner:** Pending company assignment
**Approver:** Pending company assignment
**Version:** 0.1
**Status:** Draft
**Last reviewed:** 2026-09-13
**Next review:** Before AI provider activation
**Source of truth:** `../src/stateMachine.js`, `../src/store.js`, `../src/controllers/quoteController.js`, `../src/controllers/dispatchController.js`
**Supersedes:** None

## Purpose

Explain the enforced commercial and operational chain from quote to accounting export. This guide does not replace the state machine or authorize a user to skip a step.

## Standard Workflow

`Draft -> Sent -> Approved_Pending_PO -> PO_Verified -> Field_Dispatch -> Invoiced`

| Stage | Required condition | Responsible roles |
| --- | --- | --- |
| Draft | Quote exists and can be edited while draft. | Admin, Sales |
| Sent | Quote has a client and at least one quote line. | Admin, Sales |
| Approved Pending PO | Commercial approval transition. | Admin, Sales, Operations |
| PO Verified | Verified PO has a reference and positive amount. | Admin, Finance, Operations |
| Field Dispatch | Verified PO exists, unless urgent dispatch is explicitly justified. | Admin, Operations, Supervisor |
| Invoiced | Dispatch exists; PO is verified; at least one worksheet is supervisor-approved; no unresolved amendment. | Admin, Finance |

## Urgent Dispatch

An urgent dispatch may proceed from `Approved_Pending_PO` only when the actor has dispatch permission and supplies both `started_before_po: true` and a non-empty `urgent_reason`.

The system records a pending PO and creates the linked dispatch. This does not make the work invoice-ready. PO verification, worksheet approval, and amendment controls still apply before invoicing.

## PO Ceiling and Amendment Rule

A PO is a ceiling, not a compulsory invoice amount. Logged work under the PO amount does not require an amendment. When logged labour and material value is greater than the PO amount, the system marks `requires_amendment` and blocks invoicing until an approved amendment resolves the exception.

## Field Evidence and Review

1. Field work is recorded against a dispatch card.
2. Timesheets and material usage contribute to cost and PO variance.
3. A field worksheet is created and submitted as evidence of work.
4. A permitted independent reviewer approves or returns it with a correction comment.
5. The worksheet submitter and the PO verifier are each prohibited from approving the linked worksheet.

## Invoice and Pastel

Invoice generation is allowed only after all invoice guards pass. The invoice is an internal billing record. Pastel export is an accounting handoff for eligible invoice data; it does not replace the underlying commercial and field-evidence controls.

## Escalation

| Condition | Do this |
| --- | --- |
| Missing PO reference or amount | Do not verify or invoice; obtain the required client authorization. |
| Urgent work required before PO | Record the reason through the urgent dispatch path; do not treat urgency as invoice approval. |
| PO amendment required | Escalate to Admin/Finance for the amendment workflow. |
| Worksheet is returned | Correct the work evidence and resubmit it. |
| Invoice guard blocks | Read the exact guard message and resolve the listed prerequisite; do not work around it. |

## Evidence and References

- `src/stateMachine.js`
- `src/store.js`
- `src/controllers/quoteController.js`
- `src/controllers/dispatchController.js`
- `tests/stateMachine.test.js`
- `tests/segregationOfDuties.test.js`

## Changelog

| Version | Date | Change | Approved by |
| --- | --- | --- |
| 0.1 | 2026-09-13 | Initial source-referenced draft | Pending |
