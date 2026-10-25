# PO Verification and Dispatch Policy

**Status:** owner-confirmed policy; local implementation and automated tests only. Not deployed or release-approved.

## Owner-confirmed workflow

1. Sales prepares and sends the quotation to the client.
2. The client submits its purchase order to Sales.
3. Sales verifies the PO before a dispatch may be created.
4. A pending or absent PO does not authorize dispatch. There is no urgent pre-PO bypass.
5. Existing Admin, Finance, and Operations PO-verification permissions are retained; Sales is added. This implementation does not make Sales the exclusive verifier.

Work or materials exceeding the verified PO may be recorded first as field evidence. They require an amendment during monthly reconciliation after the work is evidenced. An independent Admin or Finance approver must approve an amount that covers the recorded work and materials; until then, invoice readiness remains blocked. This does not authorize dispatch before the initial PO is verified and does not erase the variance trail.

## Implementation in this checkout

- `permissions.verifyPo` includes Sales while retaining its previous roles.
- New dispatch transitions require a PO whose status is `verified`, whose reference is non-empty, and whose amount is positive.
- A request marked `started_before_po` is rejected, even when it includes an urgent reason.
- The old automatic placeholder-PO creation path for urgent dispatch was removed. Historical records are not migrated or changed.
- PO verification and dispatch remain separate authenticated workflow actions. This policy change does not enable any feature flag or alter deployment configuration.

## Verification evidence

At the time of this update, the backend checkout was:

- Root: `C:\Users\BRIAN LUPAO\Desktop\ffims-asset-register\two-concept-packet-backend-20261005-235259`
- Branch: `codex/fix-fictional-pilot-json-store`
- HEAD: `490822b9a4b1c37751b10ddcf85feacf8e713e29`
- Working tree: already dirty from pre-existing idempotency and other handover work; this change was not committed.

Focused tests: `node.exe --test tests/poAmendmentSeparation.test.js tests/financePilotControls.test.js tests/invoiceReadinessConsistency.test.js` passed **25/25**. They include the rule that reconciliation approval is refused before an evidenced overrun and is refused when the proposed amount does not cover recorded work and materials.

The historical checkpoints above remain retained evidence. The latest full local backend test run on 21 October 2026 passed **1,123/1,123** after the read-only Dispatch Job Card and Invoice Readiness additions. These are automated tests using fictional/in-memory fixtures. No live PostgreSQL instance, production service, or real customer data was accessed. The results apply to the current dirty working tree, not to clean HEAD.

### Supplemental real-router HTTP verification (19 October 2026)

`tests/dispatchPoPolicyHttp.test.js` exercises the authenticated API with a temporary JSON store and fictional accounts/records. It confirms Operations cannot dispatch against a pending PO or use the urgent pre-PO path; neither refusal creates a dispatch. Sales can verify the PO and is recorded as verifier; Technician remains unauthorized to dispatch; Operations can proceed after the PO is verified and explicitly transitioned to `PO_Verified`.

- Focused policy tests (`dispatchPoPolicyHttp`, `stateMachine`, `financePilotControls`): **26/26 passed**.
- Latest full `npm.cmd run maintain`: **1,039/1,039 passed**; maintenance gate passed.
- This does not verify live database state, deployed policy/configuration, or browser role journeys.

### Focused evidence checkpoint (20 October 2026)

The current dirty checkout was rechecked with the real router and temporary fictional JSON stores:

- `node.exe --test tests/dispatchPoPolicyHttp.test.js`: **1/1 passed**. This confirms that an unverified PO and an urgent pre-PO request are both refused, neither refusal persists a dispatch, Sales may verify the PO, a Technician cannot dispatch, and Operations may dispatch only after verification.
- `node.exe --test tests/invoiceReadinessConsistency.test.js`: **9/9 passed**. This confirms that invoice readiness excludes work with pending review, an enabled variance gate, an already-invoiced dispatch, or a non-dispatch-ready Quote; it also validates source-hour limits and caps values at the remaining verified PO amount.

These are local automated checks, not a payment implementation, a live database test, browser UAT, or release approval.

## Release gates still required

- Reconcile and review every existing dirty file before staging or committing; especially review the persistent lead-idempotency implementation and its documented 24-hour PII retention.
- Run integration/UAT against a disposable fictional store and confirm the actual frontend/API checkout pair.
- Confirm the deployment configuration enforces the same PO rule before any release. No production flag was enabled here.
- Complete deployed-environment review of the owner-confirmed indefinite audit-event retention policy, including storage, privacy and restore controls.
- Review the diff and obtain explicit release/deployment approval. This document is not evidence of production readiness.

### Monthly reconciliation checkpoint (20 October 2026)

The owner confirmed that amendment approval follows recorded field evidence during monthly reconciliation. The local backend implementation now derives the overrun from the linked dispatch evidence before it permits approval, requires the approved amount to cover that evidence, preserves the independent-approver rule, and retains the existing invoice block until the amendment succeeds. The full local `npm.cmd run maintain` gate then passed **1,079/1,079**. This is fictional/local automated evidence only and is not a release or deployment approval.
