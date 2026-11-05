# ORAC Antigravity Reconciliation Handoff

Date: 2026-10-22
Authoritative system: this backend checkout

## Purpose

Reconcile the public-web and `orac-ios` integration work described by Antigravity with the current ORAC implementation. This is a handoff and verification document, not approval to merge, deploy, enable flags, or retire any repository.

## Current verified baseline

- Backend full regression: 1,154 passed, 0 failed, 4 skipped.
- V5 invoice-writer focused tests: 30 passed.
- PostgreSQL verification: 4 passed, including rollback, idempotency concurrency, and competing-draft source protection.
- Frontend V5 tests: 19 passed.
- Frontend production build: passed.
- V5 feature flags remain disabled.
- `V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED` and the legacy invoice guard remain unchanged.
- No deployment, commit, push, or live-data operation was performed as part of this verification.

## Authoritative checkout

`/workspace/orac-backend`

This checkout contains the current evidence, permissions, PO/amendment, timesheet, audit, reporting, PostgreSQL, and V5 invoice-writer work. Existing dirty and untracked files are intentional project work and must be preserved.

## Antigravity material requiring reconciliation

Antigravity documents claim that `/workspace/orac-backend` contains a unified public-web integration and that `orac-ios-integration` is retired after a 56-test merge. Those claims are not accepted as current project state until the actual source, repository identity, branch, commit, dirty files, routes, permissions, database configuration, and test evidence are compared.

The following files were found and read as claims/reference material:

- `/workspace/orac-backend`
- `/workspace/orac-backend`
- `/workspace/orac-backend` (must still be independently checked if available)

## Required Antigravity work

Work read-only first. Do not merge, copy, delete, commit, push, deploy, change DNS, enable flags, use live data, read `.env` contents, or retire a repository.

Compare:

1. `/workspace/orac-backend`
2. The public website checkout identified by the handoff
3. The `orac-ios-integration` checkout identified by the handoff
4. This authoritative backend checkout

Return one reconciliation report containing:

- repository roots, branches, HEAD commits, remotes, and dirty-file lists
- exact files introduced by the public-web integration
- route, permission, rate-limit, booking, and lead-record differences
- database and deployment assumptions, without reading secrets
- exact test commands and independently observed results
- conflicts with V5 invoice writing, evidence, audit trails, PO/amendment controls, and feature flags
- files that can be safely proposed for integration and files that must remain untouched
- a guarded, narrow patch only if a proven compatibility gap exists

Any patch must include exact source and payload hashes, refusal checks, apply/check/rollback instructions, and must be tested on a disposable copy. Do not claim the systems are unified until the source comparison proves it.

## Continuation rule for Codex

After the reconciliation report returns, Codex will decide whether the public-web integration belongs in this backend. The V5 and evidence controls remain the governing boundary. Public enquiry, booking, and rate-limit changes may be integrated only if they do not weaken existing authentication, tenant scoping, audit, idempotency, or feature-flag behavior.

## Release boundary

The next ORAC task remains fictional-data browser UAT for the V5 workflow. Antigravity reconciliation is a parallel integration check and does not replace that UAT or authorize production release.
