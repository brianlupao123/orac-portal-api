# Packet Reconciliation - 2026-10-22

## Decision

Do not apply either downloaded packet directly to the authoritative checkout.

The V5 packet is an older guarded candidate. Its core writer changes are already present in the current checkout and have since been extended and verified locally. The importer packet is discovery/design only and contains no implementation patch.

## V5 invoice-writer packet

Packet reviewed: `ORAC-V5-INVOICE-WRITER-CODEX-PACKET-20261021.zip`.

### Already covered by the current checkout

- V5 writer calculation and policy logic
- draft and issue controllers
- explicit V5 routes and permissions
- PostgreSQL store driver and guarded concurrency tests
- amendment allocation protections
- append-only invoice/source-consumption model
- second invoice-writer feature gate
- guarded patch scripts and release documentation

### Why it is not applied

- The packet targets branch `codex/fix-fictional-pilot-json-store` at a historical HEAD and must not be applied to the current dirty checkout.
- Its reported 1,156-pass result is not the current authoritative result. The current checkout has a later full-suite result of 1,154 passed, 0 failed, 4 skipped.
- The packet itself says its baseline was measured on a packet copy with omitted `scripts/` files and that Windows verification was not run.
- Its open judgement calls must not override the owner-approved decisions already recorded in this project.
- Its payload overlaps files that have since changed. A blind apply could overwrite current evidence, permission, PostgreSQL, and amendment work.

### Accepted evidence from the packet

The packet's design notes are useful as historical supporting material, especially its explicit refusals for amendment fixed lines, JSON single-process limits, source consumption, and PostgreSQL locking. They are not replacement verification for the current checkout.

## Importer V0 packet

Packet reviewed: `ORAC-IMPORTER-V0-DISCOVERY-RESULT (1).zip`.

### Status

Discovery/design only. It contains a discovery report, design draft, gate questions, source-read manifest, hashes, and raw read logs. It contains no source patch, implementation script, or verified importer tests.

### Safe continuation

Importer V0 remains a separate future workstream for Clients and Catalog Items only. It must not touch quotes, POs, dispatches, timesheets, invoices, signatures, AI behavior, or UI redesign.

Before implementation, the owner must answer the Gate 1 questions covering:

1. scope and backend ownership
2. importer roles
3. duplicate policy
4. CSV-only versus Excel and quoted line breaks
5. size and concurrency limits
6. price format
7. client-type validation
8. whitespace handling
9. audit and import-job retention
10. confirmation text

The recommended safe starting point is CSV-only, server-side preview plus re-validation at commit, existing form rules reused through a shared service, all-or-nothing writes, and no new dependency until the design is approved.

## Current work order

1. Finish fictional-data browser UAT for the V5 writer.
2. Keep Antigravity's public-web/idempotency work separate until its guarded patch is independently reviewed.
3. After V5 UAT, decide whether to open Importer V0 Gate 1.
4. If approved, implement the shared Client/Catalog service seam first, then importer preview/commit, with focused tests and a guarded patch.

## Protection rules

- Do not apply the V5 packet wholesale.
- Do not treat importer discovery claims as implementation evidence.
- Preserve all current dirty and untracked work.
- Keep feature flags off outside an isolated UAT process.
- Do not use live data, production databases, `.env` contents, deployment changes, commits, pushes, or DNS changes for either packet.
