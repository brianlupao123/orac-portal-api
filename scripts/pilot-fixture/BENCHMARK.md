# Chat A — Benchmark: safe test-data/seed separation

Short, bounded benchmark from primary/authoritative sources, done before writing
the loader, per the Phase 3 plan's "Mandatory research and delivery rule."

## Sources consulted

1. **OWASP ASVS — "Production data in test environment" (issue #851)**
   https://github.com/OWASP/ASVS/issues/851
   Primary point: test environments are "usually less protected than production
   environments... less monitored, have test accounts, and debug functionality,"
   so using production data in them "unnecessarily exposes it to additional risk."
   This is the core justification for the loader never reading real operational
   data and never writing to a database it cannot be told, by explicit operator
   flag, is non-production.

2. **OWASP SAMM — Secret Management stream**
   https://owaspsamm.org/model/implementation/secure-deployment/stream-b/
   Primary point: "Do not use production secrets in configuration files for
   development or testing environments, as such environments may have a
   significantly lower security posture." Applied here as: the fixture loader
   never reads or requires production credentials — `DATABASE_URL` for a
   fixture run is expected to point at an isolated pilot/UAT database, and the
   loader treats a `postgres` target as requiring an extra, explicit
   `--allow-postgres` flag rather than assuming any `DATABASE_URL` it is given
   is safe.

3. **General TDM practitioner guidance** (Kellton, "Test Data Management Best
   Practices"; Medium, "Optimizing Test Data Management Strategies for
   Separation") — secondary sources, used only to corroborate the OWASP
   material, not as authority on their own: distinct databases/schemas/
   namespaces for test data, one-way production→test data flows (never test→
   production), and clear ownership/retention policy for test datasets.

## Practice vs. ORAC owner decisions (kept distinct, per the plan's rule)

**Researched practice applied directly in the loader:**
- Never touch a production-configured process (`config.isProduction` guard).
- Require an explicit, separate "this is a non-production target" declaration
  from the operator rather than inferring it (`ORAC_FIXTURE_TARGET=non-production`).
- Treat a Postgres target as higher-risk than a local JSON file target and gate
  it behind an additional explicit flag (`--allow-postgres`), since this script
  cannot itself verify what `DATABASE_URL` points at.
- Make every write idempotent and additive-only (fixture-prefixed ids, no
  deletion, no mutation of any non-fixture record), so a mistaken re-run is a
  no-op rather than a duplicate-data or overwrite incident.

**ORAC owner decisions this benchmark does NOT resolve (left as-is, not guessed):**
- Whether ORAC will provision a dedicated non-production database/tenant for
  UAT at all, and what its connection string will be. This loader assumes one
  exists when it is run; it does not create one.
- Retention/disposal policy for fixture data once the pilot UAT is complete.
- Whether stock "reservation" (a soft hold distinct from an issue) will ever
  become a real feature — see GAPS_REPORT.md item G-STOCK-RESERVE. This
  benchmark is about *where* test data lives, not about which business
  features the app should gain; that decision is out of scope for Chat A.
