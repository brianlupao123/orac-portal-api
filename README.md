# ORAC-IOS Backend

**ORAC-IOS means Orac Industrial Operations System.** This Node.js/Express API controls the industrial-service record from lead to invoice and accounting export.

## System Contract

`Lead -> Quote -> Purchase Order -> Dispatch -> Field Worksheet -> Invoice -> Pastel Export`

The backend is authoritative for authentication, role permissions, client isolation, workflow transitions, financial controls, audit records, database TLS policy, and providerless assistant scope.

## Start Here

1. Read [MAINTAINER_GUARDRAILS.md](MAINTAINER_GUARDRAILS.md).
2. Read [ORAC_IOS_SYSTEM_HANDOVER.md](ORAC_IOS_SYSTEM_HANDOVER.md) for roles, workflow, risks, and UAT evidence.
3. Run `npm run maintain` before every commit, deployment, or external-code integration.

## Commands

```powershell
npm ci
npm test
npm run maintain
npm run demo:preview
```

`demo:seed` changes persistent data. Never run it against a live environment without an approved backup and documented authorization.

## Evidence Rule

Automated tests and code inspection are source evidence. They do not prove a Render deployment or real user workflow. Record live results in [ORAC_IOS_LIVE_UAT_LOG.md](ORAC_IOS_LIVE_UAT_LOG.md).
