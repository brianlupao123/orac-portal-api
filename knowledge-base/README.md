# Orac-IOS Knowledge Base

**Classification:** Internal
**Owner:** Orac-IOS system owner
**Approver:** Pending company assignment
**Version:** 0.1
**Last reviewed:** 2026-09-13

## Purpose

This directory is the future assistant's approved static knowledge source. It is separate from live operational data. The assistant may use only an approved, current document from this index for policy or workflow guidance; it must obtain live counts and statuses from the authenticated user's existing scoped dashboard service.

## Rules

1. Static documents explain policy, terminology, workflow, and approved procedures. They do not contain live client, financial, asset, credential, or token data.
2. Live metrics are never copied into these Markdown files. They are retrieved fresh through the existing role-scoped backend service.
3. Every knowledge article uses [ARTICLE_TEMPLATE.md](ARTICLE_TEMPLATE.md) metadata: owner, approver, version, classification, review date, source, and retirement status.
4. A policy change needs owner approval and a changelog entry. Editing wording must not silently change a workflow, financial rule, role permission, or data-retention policy.
5. Superseded articles are marked `Retired` and retained for audit. Do not delete them without the documented retention decision.
6. Any assistant response must cite the knowledge article and version it used. If no current article supports the answer, it must say that the policy guidance is unavailable.
7. A grounding validator must read the article metadata before citation. It may cite an article only when both the index entry and the article itself identify it as `Approved` and current. `Draft`, `Retired`, missing, malformed, or inconsistent metadata is not a citable source and must result in `Unavailable` for policy guidance.

## Approved Source Index

| Topic | Current authoritative source | Status |
| --- | --- | --- |
| System purpose, roles, glossary, runbook | `../ORAC_IOS_SYSTEM_HANDOVER.md` | Approved source draft; owner/approver metadata pending. |
| Automated and live acceptance evidence | `../ORAC_IOS_QA_ACCEPTANCE_PACKET.md`, `../ORAC_IOS_LIVE_UAT_LOG.md` | Evidence record, not policy guidance. |
| AI scope, grounding, rollout gates | `../ORAC_IOS_GOVERNED_AI_ASSISTANT_PLAN.md` | Design source; no provider enabled. |
| Quote to Pastel workflow | [QUOTE_TO_PASTEL_WORKFLOW_GUIDE.md](QUOTE_TO_PASTEL_WORKFLOW_GUIDE.md) | Draft; enforcement remains `../src/stateMachine.js` and `../src/store.js`. |
| Role permission and escalation policy | [RBAC_AND_ESCALATION_GUIDE.md](RBAC_AND_ESCALATION_GUIDE.md) | Draft; enforcement remains `../src/permissions.js` and route/controller checks. |
| Operations operating guide | [ROLE_MANUAL_OPERATIONS.md](ROLE_MANUAL_OPERATIONS.md) | Draft for Phase 1 rollout; owner approval pending. |
| Finance operating guide | [ROLE_MANUAL_FINANCE.md](ROLE_MANUAL_FINANCE.md) | Draft for Phase 1 rollout; owner approval pending. |

## Required Articles Before AI Activation

1. Approve the draft RBAC, workflow, Operations, and Finance articles against their enforcing source before Phase 1 AI activation.
2. Role manuals for the remaining six roles.
3. Incident, backup/restore, and credential-rotation runbook.
4. AI response governance, feedback, privacy, and retention policy.

## Change Process

1. Draft the article using the template.
2. Identify the responsible owner and approver.
3. Link to the enforcing code, UAT case, or approved business policy.
4. Review for secret, client-data, and stale-information exposure.
5. Check the article against its named enforcing source, not only against another document.
6. Approve, version, and mark both the article metadata and index entry `Approved`.
7. Update any assistant citation map only after the status checks pass.
