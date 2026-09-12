# Orac-IOS Live UAT Log

## Purpose

Record live pilot verification as it occurs. Do not enter credentials, tokens,
connection strings, personal client data, or raw database values. Use role,
record identifier, HTTP status, screenshot name, and a concise outcome only.

## Evidence Status

- `NOT RUN`: no live evidence yet.
- `PASS`: expected result occurred and evidence is recorded.
- `FAIL`: expected result did not occur; add defect detail.
- `BLOCKED`: cannot test because a prerequisite is unavailable.

## Session Details

| Field | Value |
| --- | --- |
| Test date | |
| Tester | |
| Frontend Render commit | |
| Backend Render commit | |
| Database environment | Neon private pilot |
| Data set | Curated demo data; backup id 1 exists |
| Overall sign-off | Pending |

## Public Routes and Authentication

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-001 | Public | Open `/` directly | Public industrial service landing loads. | HTTP 200; current public bundle served. | Read-only HTTP check, 2026-09-12 | PASS | Codex |
| UAT-002 | Public | Open `/login` directly | Login route loads; no static-site 404. | HTTP 200; deployed bundle excludes old dark-panel copy and includes current sign-out marker. | Read-only HTTP and bundle-marker check, 2026-09-12 | PASS | Codex |
| UAT-003 | Authenticated user | Sign in with authorized account | Correct role dashboard loads; no console/API error. | | | NOT RUN | |
| UAT-004 | Authenticated user | Use visible header Sign out | Session clears and user returns to public/login route. | | | NOT RUN | |
| UAT-005 | Authenticated user | Use profile-menu Sign out | Session clears and user returns to public/login route. | | | NOT RUN | |

## Sales and Commercial Workflow

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-010 | Sales | View seeded quotes | Draft, Sent, Approved Pending PO, PO Verified, and Invoiced examples are visible as permitted. | | | NOT RUN | |
| UAT-011 | Sales | Create or edit a Draft quote | Required client and commercial fields validate; record persists after refresh. | | | NOT RUN | |
| UAT-012 | Sales | Send a Draft quote | Only valid Draft-to-Sent transition is allowed; audit evidence is created. | | | NOT RUN | |
| UAT-013 | Sales | Attempt to invoice a quote | API/UI denies invoice action for Sales role. | | | NOT RUN | |

## PO, Dispatch, Worksheet, and Invoice Controls

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-020 | Finance or Operations | Verify a seeded client PO | PO reference and amount are required; verified status persists. | | | NOT RUN | |
| UAT-021 | Operations | Create or update a dispatch linked to PO Verified quote | Dispatch is linked to quote, PO, asset, and assigned technician. | | | NOT RUN | |
| UAT-022 | Technician | Create/update worksheet for assigned dispatch | Worksheet persists and remains scoped to assigned work. | | | NOT RUN | |
| UAT-023 | Technician | Submit worksheet | Status changes to Submitted; Supervisor receives or can view review work. | | | NOT RUN | |
| UAT-024 | Supervisor | Approve submitted worksheet | Status changes to Supervisor Approved and approval persists. | | | NOT RUN | |
| UAT-025 | Supervisor | Return worksheet with comment | Status changes to Returned for Correction and technician can see it. | | | NOT RUN | |
| UAT-026 | Finance | Attempt invoice with unapproved worksheet | Invoice is blocked with a clear business message. | | | NOT RUN | |
| UAT-027 | Finance | Attempt invoice with unresolved PO amendment | Invoice is blocked with a clear business message. | | | NOT RUN | |
| UAT-028 | Finance | Generate invoice for fully eligible job | Invoice is created only after PO and worksheet controls pass. | | | NOT RUN | |

## Inventory and Administration

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-030 | Operations | Record normal stock-out movement | Quantity decreases and movement appears in history. | | | NOT RUN | |
| UAT-031 | Management | Attempt negative stock override | API denies override; stock remains unchanged. | | | NOT RUN | |
| UAT-032 | Admin or Operations | Override a negative stock movement deliberately | Explicit override succeeds and audit evidence exists. | | | NOT RUN | |
| UAT-033 | Admin or Management | Create/edit client, asset, catalog, or supplier | Permitted CRUD persists after refresh. | | | NOT RUN | |
| UAT-034 | Technician | Attempt administration or stock-master action | API denies unauthorized action. | | | NOT RUN | |

## Client Isolation

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-040 | Client Viewer | Open Client Portal | Only own client summary, quotes, POs, and invoices are visible. | | | NOT RUN | |
| UAT-041 | Client Viewer | Submit PO for own approved quote | Own PO submission is accepted and visible in workflow. | | | NOT RUN | |
| UAT-042 | Client Viewer | Open a guessed other-client quote or invoice URL/ID | API returns denial or no record; no other-client data is shown. | | | NOT RUN | |
| UAT-043 | Client Viewer | Attempt users, audit log, or inventory API/page access | API denies access; session remains valid. | | | NOT RUN | |

## Role Dashboard Scope

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-050 | Technician | Review dashboard | Only assigned jobs and worksheet priorities appear; no organisation-wide finance/client KPI exposure. | | | NOT RUN | |
| UAT-051 | Supervisor | Review dashboard | Only review, dispatch, and operational priorities appear. | | | NOT RUN | |
| UAT-052 | Client Viewer | Review dashboard and Client Portal | Only own organisation metrics and records appear. | | | NOT RUN | |
| UAT-053 | Management | Review dashboard | Management oversight metrics and permitted navigation appear. | | | NOT RUN | |
| UAT-054 | Admin | Review dashboard against curated demo data | KPI and activity values are populated, internally consistent, and do not show duplicate seed records. | | | NOT RUN | |

## Platform Security and Connectivity

| ID | Role | Action | Expected Result | Actual Result | Evidence | Status | Sign-off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UAT-060 | N/A | Confirm explicit SSL/TLS database configuration in private local and Render environment settings, then review API startup/deploy logs and call `/healthz` | Secure explicit SSL mode is configured; API health returns HTTP 200; no SSL compatibility warning appears in the reviewed startup/deploy log. | | | NOT RUN | |

## Defects and Follow-up

| Defect ID | UAT ID | Severity | Description | Owner | Target Commit | Retest Result |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
