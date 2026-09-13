# Orac-IOS QA Acceptance Packet

## Purpose

This packet is the current evidence-backed acceptance record for the Orac-IOS pilot. It separates source and automated verification from live verification. It contains no credentials, secrets, database URLs, or token material.

## Evidence Labels

| Label | Meaning |
| --- | --- |
| SOURCE + AUTOMATED VERIFIED | Current source was inspected and the stated backend test suite passed. |
| LIVE-UNVERIFIED | Code may be released, but deployed Render behavior has not been observed and recorded. |
| NOT IMPLEMENTED | The code does not yet enforce the expected behavior. |

## Change Log

| Commit | Status | Evidence |
| --- | --- | --- |
| `7a4abec` | Field-role dashboard and operational-data scoping | SOURCE + AUTOMATED VERIFIED |
| `be0a120` | Guarded generic operational collection reads | SOURCE + AUTOMATED VERIFIED |
| `8a4fb09` | Transactional immutability and dedicated invoice void | SOURCE + AUTOMATED VERIFIED |
| `9fc09b0` | Current-account revalidation on every authenticated request | SOURCE + AUTOMATED VERIFIED |
| `0c2573b` | PO verifier cannot approve the linked worksheet | SOURCE + AUTOMATED VERIFIED |
| `f4243ad` | PostgreSQL certificate validation required by the application pool | SOURCE + AUTOMATED VERIFIED |
| `1fd558d` | Worksheet submitter cannot approve their own submission | SOURCE + AUTOMATED VERIFIED |
| `7a50b95` | Guarded generic quote lines, leads, and stock movements | SOURCE + AUTOMATED VERIFIED |
| `e91187d` (frontend) | Technician/Supervisor role-scoped dashboard UI | SOURCE + AUTOMATED VERIFIED |

Backend regression evidence: **56 tests passed, 0 failed** after `7a50b95`.

## Verified Collection Access Matrix

This matrix covers current explicit guards for the listed generic collection endpoints. `Scoped` means filtering occurs server-side after the role check.

| Collection | Admin | Management | Sales | Finance | Operations | Supervisor | Technician | Client Viewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clients | Allowed | Allowed | Allowed | Allowed | Allowed | Denied | Denied | Scoped: own client |
| quotes | Allowed | Allowed | Allowed | Allowed | Allowed | Denied | Denied | Scoped: own client |
| quote_lines | Allowed | Allowed | Allowed | Allowed | Allowed | Denied | Denied | Scoped: own client |
| leads | Allowed | Allowed | Allowed | Denied | Denied | Denied | Denied | Denied |
| dispatch_cards | Allowed | Allowed | Denied | Denied | Allowed | Scoped: review work | Scoped: assigned work | Denied |
| field_worksheets | Allowed | Allowed | Denied | Denied | Allowed | Scoped: review work | Scoped: assigned work | Denied |
| purchase_orders | Allowed | Allowed | Denied | Allowed | Allowed | Denied | Denied | Denied |
| invoices | Allowed | Allowed | Denied | Allowed | Denied | Denied | Denied | Scoped: own client |
| users | Allowed | Denied | Denied | Denied | Denied | Denied | Denied | Denied |
| audit_logs | Allowed | Allowed | Denied | Allowed | Denied | Denied | Denied | Denied |
| stock_movements | Allowed | Allowed | Denied | Denied | Allowed | Denied | Denied | Denied |

## Workflow and Financial Controls

| Control | Current evidence | Live acceptance test |
| --- | --- | --- |
| Illegal quote transition to invoiced is rejected | SOURCE + AUTOMATED VERIFIED | Attempt an invalid transition and record the response. |
| Invoice requires verified PO, approved worksheet, and no unresolved amendment | SOURCE + AUTOMATED VERIFIED | Run normal and urgent dispatch workflows on a single quote. |
| Generic archive/reactivate rejects transactional records | SOURCE + AUTOMATED VERIFIED | Attempt generic archive on an invoice or PO; expect rejection. |
| Invoice void requires Admin/Finance, a reason, and rejects paid invoices | SOURCE + AUTOMATED VERIFIED | Void an eligible invoice; separately test missing reason and paid invoice rejection. |
| PO verifier cannot approve linked worksheet | SOURCE + AUTOMATED VERIFIED | Use the same permitted user for PO verification and worksheet approval; expect rejection. |
| Worksheet submitter cannot approve own worksheet | SOURCE + AUTOMATED VERIFIED | Submit as one user and attempt approval as that same user; expect rejection. |
| Legacy worksheet with no reliable submission owner fails closed | SOURCE + AUTOMATED VERIFIED | Attempt approval only where an audit-backed legacy fixture is available. |

## Required Live UAT

Record each result with role, action, expected result, actual result, timestamp, evidence reference, and PASS/FAIL/BLOCKED status.

1. Confirm Render reports backend commit `7a50b95` and frontend commit `e91187d`.
2. Technician: dashboard has no organisation-wide KPI values; `/summary`, dispatches, and worksheets include only assigned work.
3. Supervisor: dashboard has no organisation-wide KPI values; `/summary`, dispatches, and worksheets include only review-scoped work.
4. Technician and Supervisor: generic `clients`, `quotes`, `quote_lines`, and quote document access outside their work are denied.
5. Client Viewer: invoices and quotes contain only their organisation's records; guessed other-client document IDs are denied.
6. Deactivate a non-critical pilot account and verify its existing session receives 401 on the next protected request.
7. Complete one normal and one urgent quote-to-invoice trace using continuous linked records.
8. Test invoice void, generic transactional archive rejection, PO-verifier separation, and worksheet-submitter separation.
9. Confirm the approved frontend origin works and an unapproved browser origin is rejected after the CORS policy is finalized.
10. Verify quote-line Client Viewer scoping, Sales lead access, and Operations stock-movement access; verify each non-permitted role is denied.

## Completed Narrow Collection-Guard Release

Commit `7a50b95` adds explicit guards for `quote_lines`, `leads`, and `stock_movements`. Quote lines inherit quote access and Client Viewer server-side scoping; lead access is limited to Admin, Management, and Sales; stock movements are limited to Admin, Management, and Operations.

The larger default-deny registry is still a separate P1 change requiring a complete endpoint/caller inventory. It has not been implemented or implied by this narrow release.

## Remaining Release Gates

1. Confirm deployed commits and perform the live UAT above.
2. Run an isolated Neon backup/restore drill.
3. Change the Render database secret query parameter to `sslmode=verify-full` without disclosing the connection string; verify health and logs afterward.
4. Rotate the production JWT secret after a stable deployment, then verify old sessions fail and fresh role logins succeed.
5. Establish structured logging, monitoring, and an alert test.
