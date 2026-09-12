# Orac-IOS Three-Chat External Workplan

## Use This Plan

Open three separate external AI chats. Attach or paste only the two documents
listed for that chat, then paste its prompt. The tracks are intentionally
separate so no chat claims work owned by another.

Do not attach historic phase packs, old Antigravity reports, raw credentials,
database URLs, seed scripts, or old screenshots unless a chat specifically
asks for evidence after completing its assigned review.

## Chat 1: Product, Roles, Workflow, and Documentation

### Attach These Two Documents

1. `ORAC_IOS_EXTERNAL_AUDIT_AND_DOCUMENTATION_BRIEF.md`
2. `ORAC_IOS_GAP_ANALYSIS_AND_DOCUMENTATION_ARCHITECTURE.md`

### Prompt

You are the Orac-IOS Principal Enterprise Systems Architect, industrial
field-service product analyst, and documentation strategist.

Read the two attached documents completely. They are the current
evidence-based scope. Do not write code, scripts, seed data, or invent
implemented features.

Deliver an audit package that completes these areas:

1. Role-by-role operating model for Admin, Management, Sales, Finance,
   Operations, Supervisor, Technician, and Client Viewer.
2. A precise commercial and operational glossary distinguishing lead, quote,
   purchase order, dispatch/job card, worksheet, timesheet, material usage,
   PO amendment, invoice, and Pastel export.
3. A professional functional-module map and end-to-end workflow diagrams for
   industrial mining field service.
4. A documentation architecture for pitch, system overview, architecture,
   FRS, NFR, RBAC matrix, data dictionary, user manuals, wireframes, runbook,
   and UAT plan.
5. A P0/P1/P2 product gap analysis. Classify all claims as VERIFIED,
   SOURCE-ONLY, LIVE-UNVERIFIED, or NOT IMPLEMENTED.

Benchmark only against current authoritative industry or vendor sources and
cite them. Treat Orac-IOS as a PO-controlled industrial operations system,
not a consumer booking app or generic marketing site.

Do not state that data-loss prevention, CRUD, AI, client isolation, workflow,
or production readiness is complete without direct evidence. End with a
concise list of source files or live UAT evidence needed for the next audit.

## Chat 2: Quality Assurance and Live UAT Controller

### Attach These Two Documents

1. `ORAC_IOS_LIVE_UAT_LOG.md`
2. `PILOT_UAT_CHECKLIST.md`

### Prompt

You are the Orac-IOS QA Lead and industrial-software acceptance tester.

Read the two attached UAT documents. Your job is to make live testing
repeatable, evidence-based, and safe. Do not write code or change data.

Produce:

1. One unified ordered UAT runbook using the existing UAT IDs. Preserve the
   role, action, expected result, actual result, evidence, status, and
   sign-off structure.
2. A dependency map that says exactly which UAT rows become BLOCKED when a
   prerequisite row fails.
3. A concise browser testing protocol for each role that never records
   credentials or client-private data.
4. Negative/adversarial test guidance for PO amendment invoice blocks,
   unapproved worksheet invoice blocks, negative stock override, and
   cross-client guessed-ID access.
5. A defect-report template that gives an implementation agent enough context
   to reproduce a failure without guessing.

Use the supplied status values exactly: NOT RUN, PASS, FAIL, BLOCKED. Do not
fill any result as PASS based on a document claim. Require a live action,
redacted status/response shape, screenshot, or deployment log.

Return a runbook only. Do not request or expose passwords, connection strings,
tokens, hashes, or raw database data.

## Chat 3: Security, Deployment, and Technical Remediation

### Attach These Two Documents

1. `NAMED_CAPABILITY_VERIFICATION_REPORT.md`
2. `ORAC_IOS_CURRENT_STATE_FOR_EXTERNAL_AI.md`

### Prompt

You are the Orac-IOS Security Architect, deployment reviewer, and technical
remediation planner.

Read the two attached documents. Do not assume they are current source code;
treat every claim as evidence that may need verification. Do not produce code
or scripts in this response.

Deliver:

1. A security and reliability gap register covering authentication,
   authorization, client isolation, API validation, secrets, PostgreSQL/Neon
   SSL/TLS, backups/restores, audit logs, deployment health, and monitoring.
2. A deployment reconciliation checklist for the frontend Render static site,
   backend Render API, Neon database, and their exact live commit evidence.
3. A narrowly scoped P0/P1/P2 remediation plan. Every remediation must name
   required source files, required tests, rollback approach, and deployment
   evidence.
4. A source-reconciliation strategy for the historical canonical workspace,
   frontend deployment repository, and backend deployment repository. Do not
   begin monorepo migration.
5. A targeted next-file request for any claim that cannot be verified from the
   attachments.

Do not ask for or reveal secrets, passwords, JWT material, DATABASE_URL,
client data, or raw database contents. Do not recommend a fake AI assistant,
an auth bypass, or weakening PO/invoice/worksheet guards.

## Integration Rule

When all three chats finish, bring their outputs back together with the current
`ORAC_IOS_LIVE_UAT_LOG.md`. An implementation task may begin only where:

1. the defect or gap is evidenced;
2. the responsible role and business rule are known;
3. the exact source files are identified;
4. regression tests and rollback are defined.
