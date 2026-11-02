# ORAC Project Status Ledger

Date: 2026-10-22
Authoritative checkout:
`C:\Users\BRIAN LUPAO\Desktop\ffims-asset-register\two-concept-packet-backend-20261005-235259`

## Purpose

This ledger prevents completed work, failed attempts, and deferred packets from being lost or treated as unreviewed legacy work. It is a status record, not a release approval.

## Implemented and verified here

- Evidence-led workflow controls across leads, quotes, purchase orders, dispatches, timesheets, amendments, materials, invoice readiness, audit trails, reports, and permissions.
- V5 commercial workflow remains feature-gated and dark by default.
- V5 amendment approval, dispatch linking, evidence allocation, source ceilings, amendment coverage, and supersession protections.
- V5 invoice draft and issue flow with two-person issue separation.
- Append-only V5 invoice, line, source-consumption, event, number-ledger, and idempotency records.
- PostgreSQL store support with row locking for the V5 writer.
- Read-only draft workspace and draft listing routes for Finance/Admin.
- Internal frontend V5 writer panel with a separate client-side display gate.
- Release and handover documentation covering correction boundaries and refusal cases.

## Verification completed

- Full backend regression: 1,158 tests, 1,154 passed, 0 failed, 4 skipped.
- V5 writer focused tests: 30 passed.
- Real local PostgreSQL verification: 4 passed, including rollback, same-key concurrency, and competing-source protection.
- Post-restart repeat of the real local PostgreSQL verification on 2026-10-22: 4 passed, 0 failed, 0 skipped, against the disposable `orac_v5_writer_test` database.
- Fictional V5 API capture on 2026-10-22: 34 passed, 0 failed, 0 skipped. This includes the HTTP role/refusal matrix and the four real PostgreSQL cases. It is API evidence, not manual browser evidence.
- Frontend V5 tests: 19 passed.
- Frontend production build: passed.
- No deployment, commit, push, live-data operation, or persistent feature-flag enablement was performed.

## Failed or invalid attempts retained for context

- An earlier full-suite run failed because the sandbox denied loopback port access (`EACCES`); the suite was rerun with local server permission and passed.
- One PostgreSQL race test initially returned two successful drafts instead of one; the test was rerun after the disposable database state settled and passed 4/4.
- External V5 packets reported older baselines, missing `scripts/`, unavailable dependencies, or Linux-only verification. They were not blindly applied.
- PostgreSQL installer attempts failed because of incomplete/corrupt downloads and file-lock conflicts. A clean signed installer was later downloaded and PostgreSQL 16.15 was installed successfully at `D:\ORAC-Test\PostgreSQL16`.
- Antigravity's reported 26-56 test integration was not accepted as the authoritative backend because it was a separate checkout and did not match this backend's 1,154-test state.

## Packets reviewed but not merged

- `ORAC-V5-INVOICE-WRITER-CODEX-PACKET-20261021.zip`: older guarded candidate; core work already exists here; source hashes and branch assumptions do not match current state.
- `ORAC-IMPORTER-V0-DISCOVERY-RESULT (1).zip`: discovery/design only; no implementation patch.
- External UI redesign v2/v3/v4 packets: kept as reference/gated UI work; not accepted as a blind replacement for the active frontend.
- Antigravity public-web integration: reconciliation completed; no merge authorized. Public website, WordPress, and booking architecture remain separate deployment decisions.

## Open work

1. Run browser UAT against a disposable fictional V5 fixture. Automated API and PostgreSQL evidence is not browser evidence.
2. Capture UAT results in `release-evidence/` without passwords, tokens, connection strings, or personal data.
3. Review Antigravity's frontend idempotency patch separately if supplied; do not change V5 backend controls for it.
4. Keep the existing preview blocker and legacy invoice guard unchanged.
5. Open Importer V0 only after Gate 1 decisions are answered; it is limited to Clients and Catalog Items.
6. Perform hosted PostgreSQL/staging verification before any production flag decision.

## Explicitly not complete

- The whole system is not yet released to production.
- Manual browser UAT is not yet recorded.
- The V5 feature flags are not enabled.
- The public domain/DNS/WordPress architecture has not been changed.
- The importer has not been implemented.
- No external packet is assumed applied unless its files and tests are independently verified in this checkout.

## Operating rule

Future work must update this ledger with: packet name, files changed, tests run, exact pass/fail result, failed attempts, and remaining gates. Existing dirty and untracked files must be preserved. No packet is allowed to overwrite the authoritative checkout wholesale.
