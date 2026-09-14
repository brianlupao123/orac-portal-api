# ORAC-IOS Backend Maintainer Guardrails

## Product Definition

**ORAC-IOS: Orac Industrial Operations System** is Orac Systems' controlled industrial-service workflow. It is not a generic CRUD application.

## Non-Negotiable Controls

- Enforce authorization on the server. Frontend visibility is never authorization.
- Preserve client server-side scope. Client Viewer access must never depend on hidden UI alone.
- Preserve invoice guards: valid commercial authorization, approved independent worksheet review, and amendment conditions remain required.
- Transactional and financial records are not managed through generic deactivation. Invoice void is a dedicated, audited action.
- Do not log raw assistant messages. Assistant claims and evidence references must be derived only from the caller's scoped summary.
- Require verified PostgreSQL TLS configuration; do not weaken certificate validation for convenience.
- Never run destructive seed, migration, reset, or data scripts against a live store without backup and recorded approval.

## Authoritative Files

| Concern | Source of truth |
| --- | --- |
| Role permissions | `src/permissions.js` |
| Quote and invoice transitions | `src/stateMachine.js` |
| Summary and collection scope | `src/controllers/coreController.js` |
| Authentication and active-user check | `src/auth.js` and middleware |
| Assistant scope | `src/controllers/aiController.js`, `src/services/aiTemplates.js` |
| Database TLS | `src/config.js` or pool configuration |
| Live acceptance | `ORAC_IOS_LIVE_UAT_LOG.md` |

## Required Gate

Run `npm run maintain` before every commit. It runs the full suite, whitespace check, and terminology guard. Do not mark a change live until Render confirmation and browser UAT exist.
