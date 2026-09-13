# AI Response Governance

**Classification:** Internal  
**Owner:** Pending company assignment  
**Approver:** Pending company assignment  
**Version:** 0.1  
**Status:** Draft  
**Last reviewed:** 2026-09-13  
**Next review:** Before provider activation  
**Source of truth:** `../ORAC_IOS_GOVERNED_AI_ASSISTANT_PLAN.md`

## Purpose

Define how a future Orac-IOS assistant explains authorized dashboard data without becoming an approver, decision-maker, or alternate data-access path.

## Permitted Launch Intents

- `dashboard_briefing`
- `attention_items`
- `metric_explanation`
- `workflow_guidance`

## Required Response Labels

Every response must show exactly one label:

- `Verified dashboard summary`: every metric matches the current scoped payload.
- `Template fallback`: generated directly from verified payload because a provider answer failed validation or was unavailable.
- `Unavailable`: no safe answer can be produced from the permitted source.

## Prohibited Actions

The assistant must not approve, verify, dispatch, invoice, void, export, change stock, recommend a negative-stock override, or create/update any business record. It must not confirm another client or role's specific records exist.

## Grounding Rule

Every live metric claim must match an exact metric key and value from the authenticated user's current scoped data payload. Every policy answer must cite a current approved knowledge-base article and version. Any mismatch triggers template fallback or unavailable status.

## Feedback and Audit

Every answer needs a request identifier and a visible flag action. Audit records must capture role, approved intent, source metric keys, cited article/version, response mode, time, token and latency totals, and feedback state. Store redacted structured summaries by default rather than unrestricted raw prompts or responses.

AI audit records follow the existing audit-log visibility rule: Admin, Management, and Finance may view them; all other roles are denied. This access rule must be enforced by the backend when AI audit retrieval is implemented.

## Unresolved Governance Decisions

- Model/provider and data-processing agreement.
- Whether any client-identifying data may leave the backend for a provider.
- Monthly budget, per-user rate limits, and cost owner.
- Log/feedback retention period.
- Named feedback reviewers and escalation ownership.
