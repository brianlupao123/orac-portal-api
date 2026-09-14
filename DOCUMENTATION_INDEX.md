# ORAC-IOS Documentation Index

**ORAC-IOS means Orac Industrial Operations System.**

Use this index to decide which documents are current engineering guidance and which are retained as dated evidence.

## Current Engineering Sources

| Need | Source |
| --- | --- |
| System overview and local commands | `README.md` |
| Guardrails for developers and coding agents | `MAINTAINER_GUARDRAILS.md` |
| Current release, verification, and deployment handover | `ORAC_IOS_SYSTEM_HANDOVER.md` |
| Role and workflow evidence for the governed assistant | `knowledge-base/README.md` and approved articles only |
| Browser-based release evidence | `ORAC_IOS_FINAL_UAT_EXECUTION_PACK.md` |

## Records, Not Replacement Sources

Timestamped audit reports, decision packets, correction addenda, and external-review material remain in this repository for traceability. They must not override current source code, the current handover, or approved knowledge-base articles.

## Change Discipline

1. Read `MAINTAINER_GUARDRAILS.md` before altering access, workflow, invoices, assistant behavior, or database configuration.
2. Make the smallest change that preserves the server as the security authority.
3. Run `npm run maintain` before committing.
4. Update the current handover when a release-affecting behavior changes; keep historical evidence intact.
