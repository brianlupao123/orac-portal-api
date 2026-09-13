# RBAC and Escalation Guide

**Classification:** Internal
**Owner:** Pending company assignment
**Approver:** Pending company assignment
**Version:** 0.1
**Status:** Draft
**Last reviewed:** 2026-09-13
**Next review:** Before AI provider activation
**Source of truth:** `../src/permissions.js`; generic read controls in `../src/controllers/coreController.js`
**Supersedes:** None

## Purpose

Define the authority boundary for every Orac-IOS role. This guide explains access; it does not grant access. The backend permission map and route/controller checks remain the enforcing source.

## Role Authority

| Role | May perform | Must escalate |
| --- | --- | --- |
| Admin | All currently configured permission categories, including users, master data, inventory, PO verification, invoice work, and audit viewing | Business-policy conflicts and provider/governance decisions |
| Management | Clients, assets, catalog, company profile, inventory, and audit oversight | PO verification, amendments, invoice generation, Pastel export, and invoice void |
| Sales | Create/send quotes and approve a quote to `Approved_Pending_PO`; view commercial lead/quote information | POs, dispatch, field evidence, invoice, stock, and audit decisions |
| Finance | Verify POs, approve amendments, invoice, export Pastel data, void eligible invoices, view audit information | Dispatch execution, worksheet review, inventory operations, client/asset administration |
| Operations | Approve quotes, verify POs, dispatch work, add field cost evidence, review worksheets, manage assets and inventory | Invoice generation, Pastel export, invoice void, user/company-profile administration |
| Supervisor | Dispatch, add field cost evidence, create/submit/review worksheets in permitted review scope | PO verification, amendment approval, invoice, inventory master data, audit data |
| Technician | Add field cost evidence and create/submit worksheets for assigned work | Quote, PO, dispatch authorization, review, invoice, inventory administration, audit data |
| Client Viewer | Submit a PO for an eligible own-client quote; read only server-scoped own-client commercial data | All internal administration, operations, inventory, audit, and financial actions |

## Mandatory Separation Rules

1. A worksheet submitter cannot approve that worksheet.
2. A user who verified the linked PO cannot approve that worksheet.
3. A paid invoice cannot be voided through the invoice-void workflow.
4. A negative-stock override is a deliberate authorized exception, not a normal inventory action.
5. The assistant, when implemented, has no approval or mutation authority regardless of the user's role.

## Escalation Rules

| Situation | Required action |
| --- | --- |
| PO requires amendment | Finance/Admin must process the approved amendment before invoicing can continue. |
| Worksheet returned for correction | Technician or responsible field role corrects and resubmits it; reviewer does not complete the work on their behalf. |
| Assistant answer conflicts with dashboard or policy | Flag the answer; use the dashboard and controlling workflow as the operational source until reviewed. |
| Unexpected cross-client or cross-role data | Stop work, preserve evidence, and escalate to Admin immediately. |
| Invoice or stock exception | Use the existing controlled workflow; do not bypass through comments, exports, or the assistant. |

## Evidence and References

- `src/permissions.js`
- `src/controllers/coreController.js`
- `src/controllers/dispatchController.js`
- `tests/financialRecordControls.test.js`
- `tests/segregationOfDuties.test.js`

## Changelog

| Version | Date | Change | Approved by |
| --- | --- | --- | --- |
| 0.1 | 2026-09-13 | Initial source-referenced draft | Pending |
