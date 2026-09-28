# Chat A — Evidence checklist (for the owner to tick when running against an approved non-production target)

Nothing below has been run against anything except a local JSON store in the authoring session.

- [ ] Owner confirms a dedicated non-production database/tenant exists and records its identity here: ________
- [ ] `npm ci && npm test` → 0 failures (authoring session: 336/336)
- [ ] Dry run (no flags) prints would-insert counts and exits 0; target file/db unchanged afterwards
- [ ] Guard refusals observed: production dry run, `--apply` without env, wrong `--confirm`, postgres without `--allow-postgres`
- [ ] `--apply` run: capture full inserted/reused/rejected/skipped output
- [ ] Second `--apply` run: every collection `inserted=0`
- [ ] `verify-pilot-fixture.mjs` → 67 checks, 0 failures (capture output)
- [ ] Log in as each of the 8 fixture roles (password in `build-fixture-records.mjs`, fictional) and screenshot: Sales pipeline, Operations dispatch/stock, Supervisor worksheets, Finance invoice-ready, Client Viewer own quotes only, Admin/Management reports
- [ ] Confirm reports show D-003 (0 approved worksheets) and D-004 (invoice-ready, not invoiced) exactly as GAPS_REPORT states
- [ ] Record the real Postgres-path output separately; it has never been exercised
