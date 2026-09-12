# Orac-IOS Gap Analysis & Documentation Architecture

**Scope of this document:** analysis and structure only, per instruction. No code, scripts, or seed data are proposed here. Every gap item is marked with its actual current evidence status — a claim without evidence is marked as such, not assumed resolved.

---

## Part 1: Gap Analysis (P0 / P1 / P2)

### P0 — Blocking, must resolve before pitch or handover

| # | Gap | Current evidence | What's still missing |
|---|---|---|---|
| 1 | **Live deployment not confirmed against source.** Multiple commits pushed (frontend `86e9ceb`; backend `ae5c75f`, `4548578`, `a43c8d2`) with no single captured Render dashboard confirmation of which commit hash is actually serving traffic right now. | Commits exist in GitHub history. | A Render dashboard screenshot or log excerpt showing the deployed commit hash for both services, taken *after* this message, not inferred from push history. |
| 2 | **Role-scoped dashboard overexposure.** Technician, Supervisor, and Client Viewer dashboards were confirmed via screenshot to show organization-wide financial/client KPIs they should not see. | Screenshot evidence of the defect exists. Source-level fix status unconfirmed. | Either a source fix + passing test, or an explicit statement that this is still open. |
| 3 | **SSL/TLS connection mode unresolved.** Neon connection issued an SSL compatibility warning during seeding. | Warning observed and logged internally; official Neon guidance (`sslmode=require` with `channel_binding=require`, or `verify-full`) identified but not yet applied. | Confirmation that the explicit SSL mode has been set in both local `.env` and Render environment variables, and a clean health check with no warning. |
| 4 | **CRUD lifecycle unproven end-to-end.** Curated demo data exists in Neon, but no browser UAT has confirmed create, edit, submit, approve, and scoped-read actually work against it. | Data is present (backup id 1 created before seeding). | A role-by-role UAT log: which user, which action, which record, what happened — not a general "the system works" statement. |
| 5 | **Client Portal invoice scoping unverified live.** Backend source (`a43c8d2`) restricts Client Viewer invoice access to their own client's records. | Source-level change exists. | A live login as a Client Viewer account confirming only that client's invoices render, and a second client's invoices do not. |

### P1 — Must resolve before company handover; not blocking internal pilot use

| # | Gap | Current evidence | What's still missing |
|---|---|---|---|
| 6 | **Worksheet vs. Timesheet terminology is not yet standardized** across UI labels, documentation, and likely the company's own internal vocabulary. This has caused confusion at least once already in this project's history. | Real backend distinction exists (`field_worksheets` is the parent record; timesheet entries are logged against a worksheet). | A single authoritative glossary entry (see Part 2, Data Dictionary) referenced consistently everywhere — UI, docs, training. |
| 7 | **No documented backup/restore *test*.** A backup was created before the demo seed (backup id 1), but creating a backup and proving a restore works are different claims. | One backup exists. | An actual restore drill: restore backup id 1 into a scratch environment and confirm data integrity, documented step by step. |
| 8 | **Three divergent working copies** (canonical local, `deploy-backend`, `orac-ios-web`) still not reconciled into one source of truth. | A reconciliation inventory tool exists and has been run once. | A completed file-by-file reconciliation decision table before any monorepo migration is attempted — explicitly deferred per the brief's own instruction, correctly so. |
| 9 | **AI assistant has no governed design**, even though it's correctly excluded from production. | Confirmed absent from deployed frontend — a correct decision, not a gap in itself. | If a real assistant is wanted later: a defined use case, approved provider, privacy model, audit trail, and cost bound — currently nonexistent, which is fine as long as no assistant ships without one. |
| 10 | **UI consistency audit incomplete** beyond the sign-in page fix. Dark split-panel and implicit-only sign-out were fixed (`86e9ceb`), but no equivalent pass has been done across Dashboard, Reports, Inventory, Admin for shared visual language. | One page confirmed fixed. | A page-by-page consistency check using shared primitives (PageHeader, StatCard, EmptyState, StatusBadge, etc.), per the UI roadmap's own Phase U1. |

### P2 — Polish and longer-term, not required for initial pitch

| # | Gap | Notes |
|---|---|---|
| 11 | Full 10-document documentation suite not yet written | Structure proposed in Part 2 below; content requires live evidence gathering first |
| 12 | No observability/monitoring (uptime, error tracking, structured logs) | Explicitly listed as a known gap; no target date set yet |
| 13 | Public landing page content not finalized | Needs live visual review before final copy/design pass |
| 14 | No credential rotation policy or documented incident-response process | Needed before real client data volume increases |

---

## Part 2: Documentation Architecture

Each document below gets a stable heading structure and a clickable table of contents (standard Markdown heading anchors — `[Section Name](#section-name)` — render as clickable links in GitHub, GitLab, and most Markdown viewers without any extra tooling). Every claimed capability inside any of these documents must carry one of the acceptance-evidence types already defined in the audit brief (source+line, passing test name, redacted HTTP response, build output, UAT screenshot, commit+deploy log, or backup/restore result). A claim without one of these is written as "proposed" or "pending," never as "done."

### 1. System Overview & Pitch
- Table of Contents
- The Problem (fragmented manual quote/PO/dispatch/invoice tracking)
- Who Uses It (8 roles, one line each)
- How It Solves the Problem (the pipeline, in plain language, no jargon)
- Live Screenshots (redacted of any real client data / credentials)
- Architecture At a Glance (one diagram, not the full technical document)
- Business Benefits (traceability, no-invoice-without-PO guarantee, audit trail)
- Known Limits (pulled directly from Part 1's P0/P1 list — a pitch that hides limits is less credible than one that names them and shows a plan)
- What's Next

### 2. Software Architecture Document
- Table of Contents
- System Context (who talks to what — browser, API, Neon, Render)
- Deployment Topology (two Render services, one Neon database, current commit references)
- Frontend Architecture (React/Vite/Tailwind, page inventory, shared components)
- Backend Architecture (Express, controllers, middleware, state machine)
- Data Storage (JSONB-in-Postgres current design, explicitly marked as intentional pilot-stage debt, not a mistake — with the deferred normalization plan referenced, not re-litigated)
- Integration Points (Pastel CSV export — no live API integration exists yet)
- Environments (local, Render staging/production — variable *names* only, never values)
- Backup & Migration Plan (cross-references the Operations Runbook, doc 8)

### 3. Functional Requirements Specification
- Table of Contents, organized by module (Lead Intake, Quoting, PO Verification, Dispatch, Worksheets, Timesheets, Inventory, Invoicing, Pastel Export, Admin, Client Portal)
- Per module: role(s) involved, CRUD actions, state guards enforced, error states, acceptance criteria
- Each acceptance criterion must reference Part 1's evidence types when marked complete

### 4. Non-Functional Requirements
- Availability (current: single-instance Render pilot, no SLA yet)
- Security (references the Security & Data Protection table already established)
- Performance (no formal targets set yet — worth defining before claiming any)
- Accessibility (not yet audited)
- Audit retention (audit log exists; retention policy not yet defined)
- Data integrity (PO/invoice/worksheet guards; backup status per Part 1 item 7)
- Maintainability (source reconciliation status per Part 1 item 8)

### 5. Role and Permissions Matrix
- One row per permission, one column per role (Admin, Management, Sales, Finance, Operations, Supervisor, Technician, Client Viewer) — reuses the confirmed real matrix from `permissions.js`, not a redrawn guess
- Explicit "Denied" cells, not just blank ones — a blank cell reads as "unknown," a denial should read as a decision
- Test case reference per role: which automated test (from the 31/31 backend suite) or UAT log entry proves this row

### 6. Workflow and Data Dictionary
- **The corrected glossary — this is the highest-value single item in the whole documentation set, given the recurring internal confusion:**

| Term | Definition | Distinguished from |
|---|---|---|
| Lead | An unqualified inbound inquiry, before any quote exists | Quote (a lead becomes a quote once qualified and priced) |
| Quote | A priced, itemized proposal in one of the defined lifecycle states (Draft → Sent → Approved_Pending_PO → PO_Verified → Field_Dispatch → Invoiced) | PO (a quote is what's proposed; a PO is the client's authorization to proceed) |
| Purchase Order (PO) | The client's formal authorization referencing an amount and reference number; gates dispatch and invoicing | Amendment (a PO can be amended; the PO itself is the base authorization) |
| Dispatch / Job Card | The operational record of field work being carried out against a verified (or urgently-flagged) PO | Worksheet (the dispatch is the assignment; the worksheet documents what was actually done) |
| Field Worksheet | The technician's record of work performed on a specific dispatch, subject to supervisor approval/return | Timesheet (a worksheet is the reviewed work record; timesheet entries are the raw hours logged within it) |
| Timesheet (entry) | A logged block of hours against a worksheet, used for cost calculation | Worksheet (see above — a timesheet entry is a component of a worksheet, not a separate approval object) |
| Material Usage | Stock consumed against a specific job, decremented via a stock movement | Stock Movement (material usage is the job-facing record; stock movement is the inventory-ledger-facing record of the same event) |
| PO Amendment | A recorded, reasoned change to a PO's authorized amount, required when logged value exceeds the original PO | Invoice (an amendment must be resolved before an invoice can be generated against that PO) |
| Invoice | The billing record generated only once PO verification and worksheet approval conditions are met | Pastel Export (the invoice is the internal record; Pastel export is the accounting-system-facing output of finalized invoices) |
| Pastel Export | A structured, immutable batch of finalized invoice data for import into Pastel accounting software | — |

- State transition diagrams for the quote lifecycle and the worksheet lifecycle
- Entity relationship summary (client → mine site → plant → plant section → equipment tag; quote → PO → dispatch → worksheet → invoice)

### 7. User Manuals
- One per role (8 total), task-oriented, not feature-list-oriented — "How do I verify a PO" rather than "The PO Verification screen has these fields"
- Each manual cross-references only the actions that role's row in the Permissions Matrix (doc 5) actually allows

### 8. Deployment and Operations Runbook
- Render service names, build/start commands, health check paths (values already documented in this project's history — reuse, don't re-derive)
- Environment variable *names* by service (never values)
- Release checklist (build → test → diff review → commit → push → confirm live deploy commit hash — the exact discipline already established, written down formally)
- Rollback procedure
- Backup/restore procedure (once Part 1 item 7 is actually closed — do not document a restore procedure that's never been tested)
- Credential rotation policy

### 9. Test and UAT Plan
- Automated test inventory (currently 31/31 backend tests — list what each one actually covers)
- Role-by-role manual UAT case list, structured as: role, action, expected result, actual result, evidence, sign-off
- Defect log with severity, matching the P0/P1/P2 structure from Part 1

### 10. UX Wireframes and Screen Inventory
- Public landing, login, forgot/reset password, request access
- Dashboard per role (showing only what that role's fixed scoping actually renders, once P0 item 2 is closed)
- Quote, PO, Dispatch, Worksheet, Inventory, Reports, Client Portal, Admin
- Wireframes must be drawn from actual current screens (screenshots or accurate reproductions), never an idealized redesign presented as current state

---

## Note on Sequencing

Per the brief's own rule: documentation content should be written *after* the P0 items in Part 1 are closed with real evidence, not before. Writing the architecture now (this document) is appropriate — writing the *filled-in* Functional Requirements Spec or User Manuals before UAT is actually run risks documenting intended behavior as if it were confirmed behavior, which is the exact failure mode this whole audit process exists to prevent.