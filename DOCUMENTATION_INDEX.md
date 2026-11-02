# ORAC-IOS Documentation Index

**ORAC-IOS means Orac Industrial Operations System.**

Use this index to decide which documents are current engineering guidance and which are retained as dated evidence.

## Current Engineering Sources

| Need | Source |
| --- | --- |
| System overview and local commands | `README.md` |
| Guardrails for developers and coding agents | `MAINTAINER_GUARDRAILS.md` |
| Current release, verification, and deployment handover | `ORAC_IOS_SYSTEM_HANDOVER.md` |
| Public `POST /api/leads` retry/idempotency contract, privacy, operations, and verification state | `PUBLIC_LEAD_IDEMPOTENCY.md` |
| Opt-in lead-to-quote trace and role-scoped record history | `LEAD_TO_QUOTE_RECORD_TRAIL.md` |
| ORAC AI record-analysis API contract (Quote, Dispatch, Field Worksheet, Daily Time Sheet, Contractor Log Sheet, limited Invoice, Purchase Order, Supplier, Maintenance Schedule, Equipment Tag, Material Usage, Catalog Item, Stock Item, monthly Worksheet Register and Service Request slices) | `ORAC_AI_RECORD_ANALYSIS_API.md` |
| Manual invoice settlement ledger and its explicit accounting boundaries | `INVOICE_SETTLEMENT_POLICY.md` |
| Internal-portal API and UI boundary for invoice settlement evidence | `INVOICE_SETTLEMENT_FRONTEND_CONTRACT.md` |
| Owner-approved controlled USD pricing policy and staged V5 invoice implementation contract | `CONTROLLED_COMMERCIAL_PRICING_PROPOSAL.md` |
| V5 append-only material-evidence allocation API and its billing-readiness boundary | `V5_MATERIAL_ALLOCATION_CONTRACT.md` |
| V5 read-only invoice calculation preview, blockers, and deliberately excluded invoice writer | `V5_INVOICE_PREVIEW_CONTRACT.md` |
| V5 gated, append-only draft/issue writer and its remaining release gates | `CONTROLLED_COMMERCIAL_PRICING_PROPOSAL.md` |
| Evidence required before V5 invoice-writer enablement | `V5_INVOICE_WRITER_RELEASE_GATES.md` |
| Fictional role-based V5 invoice-writer UAT scenarios and evidence to retain | `V5_INVOICE_WRITER_FICTIONAL_UAT.md` |
| V5 amendment evidence, independent approval, and excluded billing coverage | `V5_AMENDMENT_APPROVAL_CONTRACT.md` |
| V5 amendment evidence-coverage model and future invoice-writer controls | `V5_AMENDMENT_COVERAGE_DESIGN.md` |
| Owner-confirmed PO verification and dispatch gate policy | `PO_VERIFICATION_AND_DISPATCH_POLICY.md` |
| Owner-confirmed audit-event retention and access policy | `AUDIT_EVENT_RETENTION_POLICY.md` |
| Read-only Dispatch Job Card and Invoice Readiness evidence-card implementation status | `../DISPATCH_JOB_CARD_EVIDENCE_CONTRACT_20261021.md` |
| Evidence-card hierarchy and delivery backlog across Dispatch, Timesheets, PO, Quote and Invoice Readiness | `../ORAC_OPERATIONAL_CARD_STANDARD_20261021.md` and `../ORAC_CARD_COMPARISON_AND_IMPROVEMENT_BACKLOG_20261021.md` |
| Role and workflow evidence for the governed assistant | `knowledge-base/README.md` and approved articles only |
| Browser-based release evidence | `ORAC_IOS_FINAL_UAT_EXECUTION_PACK.md` |
| Phase 2 controlled quotation journey status ledger & verification evidence | `ORAC_PROJECT_STATUS_LEDGER_20261024.md` |

## Records, Not Replacement Sources

Timestamped audit reports, decision packets, correction addenda, and external-review material remain in this repository for traceability. They must not override current source code, the current handover, or approved knowledge-base articles.

## Change Discipline

1. Read `MAINTAINER_GUARDRAILS.md` before altering access, workflow, invoices, assistant behavior, or database configuration.
2. Make the smallest change that preserves the server as the security authority.
3. Run `npm run maintain` before committing.
4. Update the current handover when a release-affecting behavior changes; keep historical evidence intact.
5. Treat V5 preview, amendment-coverage, and invoice-writer packets as separately gated commercial work. A read-only readiness screen does not authorize V5 invoicing.
