# ORAC Open Requests And Release Gates

Last reconciled: 2026-10-26

This is the active ledger for requests raised in the Codex/Antigravity workstream that are not yet implemented, not yet independently verified, or intentionally deferred. It is a planning and release-control document; it does not authorize a deployment.

## Rules For Reading This Ledger

- **Open** means no implementation is confirmed in this checkout.
- **Deferred** means the owner deliberately postponed the work.
- **Awaiting verification** means code may exist, but the required evidence is incomplete.
- **External decision** means it needs a business, accountant, deployment, or infrastructure decision rather than a code guess.
- No item below should be silently closed merely because a local test passes.

## Open Product Work

| ID | Request | Status | Closure Evidence Required |
| --- | --- | --- | --- |
| O-01 | Complete the independent browser UAT of the local Phase 5 Finance settlement journey. | Awaiting verification | Antigravity report with screenshots, exact routes, pass/fail assertions, console/server errors, and protected-area attestation. |
| O-02 | Demonstrate the complete fictional browser journey: approved quote -> verified PO -> dispatch -> field evidence -> controlled draft -> independent issue -> controlled PDF -> settlement screen. | Awaiting verification | Role-by-role browser evidence. Payment recording and reversal remain separate confirmation-required test steps. |
| O-03 | Record a fictional payment and reverse it through the browser UI. | Not run intentionally | Fresh user confirmation immediately before each action, then evidence that payment/reversal are audited and that a paid invoice cannot be voided. |
| O-04 | Implement Phase 3B partial PO and work-package allocation. | Deferred | Owner approval of allocation rules, then a dedicated design, implementation, tests, and UAT. |
| O-05 | Add a formal credit-note/correction workflow for issued or settled invoices. | Open | Business rules for credit notes, authority, linked correction records, PDF/export treatment, audit rules, tests, and UAT. The current system refuses voiding a paid invoice. |
| O-06 | Finalize payment terms for controlled quotations. | External decision | Owner-approved default wording after commercial benchmarking, then inclusion in quote/PDF templates and tests. |
| O-07 | Confirm final VAT treatment with the company accountant. | External decision | Approved VAT rate/exemptions and evidence process. The current 15% value is development-only provisional configuration, not a production tax decision. |

## Public Website Work

| ID | Request | Status | Closure Evidence Required |
| --- | --- | --- | --- |
| W-01 | Replace the public "Formal Tender & RFQ" acknowledgement PDF with **Enquiry & Technical Intake Receipt (Non-Binding)**. | Open | Reviewed public-site implementation, focused tests, build, browser UAT, and wording review. It must not show commercial totals, VAT, approval stamps, tender language, or final-quotation claims. |
| W-02 | Update public quotation-confirmation actions and WhatsApp wording from RFQ dossier language to technical-enquiry wording. | Open | Narrow public-site patch and browser evidence. |
| W-03 | Complete the public website visual/UI quality pass requested by the owner: typography, font weight/size, spacing, alignment, information hierarchy, content distribution, responsive layouts, control consistency, accessibility, and document presentation. | Open | Page-by-page UX audit, approved implementation scope, desktop/tablet/mobile screenshots, accessibility checks, build and browser evidence. |
| W-04 | Decide and implement site-survey booking, if it is still wanted. | Design-only / not implemented | Owner-approved architecture decision and a separate guarded implementation plan. |
| W-05 | Configure the deployed public-site CORS origin and verify the public API integration. | Deployment gate | Staging/production runtime configuration, not a source-code-only change. |
| W-06 | Deploy the reviewed public idempotency integration. | Not deployed | Staging verification, deployment approval, and post-deploy evidence. |

## Portal And Backend Release Work

| ID | Request | Status | Closure Evidence Required |
| --- | --- | --- |
| R-01 | Reconcile Antigravity browser-UAT results with Codex automated-test and code-review evidence. | Open | One signed release-review packet identifying exact commit IDs, results, unresolved risks, and release recommendation. |
| R-02 | Produce a deployment runbook for the portal and backend. | Open | Environment map, secret-handling procedure, PostgreSQL/Neon setup, backup/rollback, CORS origins, health checks, migration policy, and smoke tests. No credentials in Git. |
| R-03 | Run a staging deployment and end-to-end UAT against staging. | Not started | Explicit deployment approval, staging database, limited test identities, post-deploy browser and API evidence. |
| R-04 | Production deployment. | Not started | Explicit owner approval after R-01 through R-03 pass. |
| R-05 | Configure hosted PostgreSQL/Neon and migrate only through an approved deployment plan. | Not started | Chosen provider, secret storage, TLS verification, backup/restore test, migration and rollback evidence. |
| R-06 | Enable or release the V5 invoice writer. | Intentionally dark | Separate V5 release-gate approval, real PostgreSQL verification, staging UAT, and finance policy sign-off. It must not be enabled merely because the legacy billing pilot is ready. |
| R-07 | Integrate Pastel beyond review CSV export. | Not implemented | Accounting-owner approval, field mapping, import/reconciliation process, non-posting export audit, and controlled pilot. Current exports are review-only and do not post to Pastel. |

## Other Repositories Raised In This Chat

| ID | Request | Status | Closure Evidence Required |
| --- | --- | --- | --- |
| X-01 | First ProjectStore implementation slice in `journey_hub\\ACANEXUS_AI\\acanexus-ai-service`. | Not independently verified in this chat | Repository-specific implementation report, focused contract tests, and existing-unit-test result. |
| X-02 | Equivalent independent ProjectStore storage-boundary slice in `PersonalSystem\\dissertation_ai`. | Not independently verified in this chat | Repository-specific implementation report, focused contract tests, and existing-unit-test result. |
| X-03 | Reconcile the earlier multiple-chat/work-packet status into a single verified inventory. | Open | Read-only inventory of each repository, branch, HEAD, dirty state, test baseline, and owner. |

## Explicitly Not Done

- No remote Git pushes, pull requests, public deployment, DNS change, WordPress change, or production database migration has been performed from this workstream.
- No real credentials, PostgreSQL passwords, Neon URLs, or other secrets were committed. The checked-in `.env.example` uses placeholders only.
- No financial payment, bank transfer, or real accounting posting was performed. Local fictional payment recording is still a deliberately gated UAT action.
- No claim is made that the system is production-ready until the deployment gates above are closed.

## Already Closed In This Checkout

The ledger does not reopen accepted work: controlled quotation rules, full-coverage PO verification, operational-delivery controls, local legacy invoice draft/independent issue controls, settlement/reversal/paid-void controls, controlled PDF route, Pastel review export audit, production configuration template, and their recorded automated tests are implemented locally. Their deployment and final browser-evidence gates remain open.
