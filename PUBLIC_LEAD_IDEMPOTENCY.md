# Public Lead Retry Safety

**Owner:** ORAC-IOS backend maintainers  
**Feature:** F01 public enquiry retry safety  
**Status date:** 19 October 2026  
**Release state:** implemented in the local integration checkout and automated-test verified; not committed, deployed, or production-approved. The public website has not yet been integrated with this contract.

## Purpose

An HTTP response can be lost after ORAC-IOS has saved a public enquiry. If the visitor submits again with the same request key, the API must return the original lead reference instead of creating a duplicate. This is request retry protection; it does not decide whether two separately keyed enquiries describe the same business need.

The feature changes only `POST /api/leads`. Requests without an `Idempotency-Key` keep the previous behavior and receive no duplicate protection.

## Source of Truth and Change Identity

The implementation belongs to the backend integration checkout:

| Field | Value |
|---|---|
| Repository root | `/workspace/orac-backend` |
| Git remote | `https://github.com/orac-systems/orac-portal-api.git` |
| Branch | `codex/fix-fictional-pilot-json-store` |
| Base commit | `490822b9a4b1c37751b10ddcf85feacf8e713e29` |
| Change state | Local working-tree changes; no commit or push |

The tracked implementation is in:

- `src/idempotency.js`: header validation, canonical fields, request hash, expiry and pruning.
- `src/router.js`: endpoint middleware order for `POST /leads`.
- `src/controllers/coreController.js`: lookup, replay, conflict, lead creation and key record.
- `src/store.js`: default and existing-store support for the private `idempotency_keys` array.
- `server.js` and `src/middleware/cors.js`: unchanged allowed-origin policy plus request/exposed response headers.
- `tests/leadIdempotency.test.js`: focused unit and HTTP behavior tests.
- `src/persistenceMiddleware.js` and `src/postgresStore.js`: existing durable-write and transaction behavior used by this feature; these files were not changed.

The detailed request/response contract for the public-web frontend is in [FRONTEND_CONTRACT.md](./docs/FRONTEND_CONTRACT.md). The controlling source is the API and tests in this repository.

## API Contract

### Request

`POST /api/leads` accepts one optional header:

```http
Idempotency-Key: <UUID version 4>
```

The expected format is the 36-character UUID v4 produced by `crypto.randomUUID()`. Uppercase hex is accepted and normalized to lowercase. Empty, malformed, non-v4, or repeated headers receive HTTP 400 with `code: IDEMPOTENCY_KEY_INVALID`. The middleware runs before body validation; therefore a malformed key takes precedence if both key and body are invalid. A missing key preserves legacy behavior.

The key is scoped to `POST /api/leads` in the configured store. It is not scoped to an IP address or user, and it is not a credential. The server compares schema-validated, canonical lead fields in a fixed order. Optional `phone` and `mine_site` blank values canonicalize to an empty string; blank or omitted `urgency` canonicalizes to `standard`. Required text fields are compared as supplied after schema validation; email is case-sensitive. Unknown fields do not affect the comparison. The server does not merge requests by email, company, or description.

### Outcomes

| Case | Result |
|---|---|
| First valid request with a key | Existing HTTP 200 success response; key metadata, lead and `LEAD_CREATED` audit are persisted together. |
| Same active key and same canonical payload | HTTP 200 with the original response/reference, `idempotent_replay: true` in the body, and `Idempotency-Replayed: true` response header. No second lead or creation audit is made. |
| Same active key with a different canonical payload | HTTP 409, `code: IDEMPOTENCY_KEY_CONFLICT`; response contains no lead content or reference. |
| Invalid key | HTTP 400, `code: IDEMPOTENCY_KEY_INVALID`; no mutation or key reservation. |
| Schema validation failure | Existing HTTP 400 behavior; no key reservation. Corrected valid data may use the same key. |
| Rate limit | Existing HTTP 429 behavior and `Retry-After`; replays count toward the limit and do not bypass it. |
| Persistence failure | The existing persistence middleware returns an error instead of acknowledging a write that did not commit. The key and lead must not be partially committed. |

The original response is retained so a replay returns the original reference and response fields, even if staff later edit the lead. A retry reuses the same key and exact original payload. A changed enquiry is a deliberate new logical submission and needs a new key; the API does not infer whether it is a duplicate business enquiry.

## Persistence, Retention, and Privacy

Key records are stored in the existing aggregate as `idempotency_keys`. Existing stores are normalized with an empty array; no relational migration or separate database is introduced. The collection is not registered as a generic API collection. It must remain unavailable through generic collection reads, exports, and audit projections.

Each keyed creation records the operation scope, UUID, SHA-256 request fingerprint, lead id, original status/response, creation time, and expiry time. The API stores one temporary copy of the original lead response, including the submitted contact details, to support exact replay. It resides in the same store and is not returned through an idempotency-record route. Expired records are removed opportunistically during later keyed requests; leads are never removed by pruning. A conflict response is non-success and is not persisted, so pruning performed during a conflict may wait until a later successful keyed request.

Retention is 24 hours from the initial successful creation. The key is valid when `now < expires_at`; at the exact expiry instant it is expired. Replays do not extend the period. After expiry, reuse of the key is treated as a new request and may create another lead. The frontend must not automatically retry an uncertain request after this window; it should direct the visitor to contact Orac to check the earlier enquiry.

The fingerprint is an unsalted SHA-256 digest used for payload equality, not anonymization or a privacy control. The raw UUID key and response snapshot are also in the store. Backups created during the 24-hour window may contain that snapshot. Treat database files and backups under the existing access and retention controls for lead personal data. Do not log request keys, fingerprints, or retained response snapshots.

## Concurrency and Store Behavior

- **JSON store:** the existing in-process mutex serializes lookup and creation within one Node process. Multiple Node processes sharing one JSON file are not made safe by this change; that is a pre-existing store limitation.
- **PostgreSQL store:** the existing JSONB aggregate row lock (`SELECT ... FOR UPDATE`) serializes requests across store instances, and the lead, audit and key are written in one transaction. This behavior has contract-mock tests; a live PostgreSQL integration run has not been performed for this change.
- **Durability:** `persistenceMiddleware` sends a successful mutation response after `store.write` resolves. A response lost after that point can be safely retried with the same key while retained.
- **Rate limiting:** public endpoint limits remain before the persistence lock. Retries and replays consume the same limit as other requests.

## CORS and Frontend Requirements

The existing origin policy is unchanged. `Idempotency-Key` is allowed in CORS request headers, and `Idempotency-Replayed` is exposed to browser code. In production, the public website origin must already be in `CORS_ORIGINS`; this change does not add or enable an origin.

The public website repository is maintained separately at `D:\Projects\orac-systems-operational\orac-systems-demo`. Its frontend has separately reported wiring to this backend contract, but this checkout has not been independently tested together with that site. The public integration flag remains a separate frontend control and is not enabled by this backend change.

Frontend requirements:

1. Create one UUID v4 per deliberate logical submission and send it in `Idempotency-Key`.
2. On timeout, lost response, network uncertainty, or retryable 5xx, offer retry with the same key and the exact same payload. Never silently generate a replacement key for an uncertain submission.
3. Treat either success response as success and show `data.id`; `idempotent_replay` is informational.
4. On 409, do not display lead data. Explain that the key was paired with changed data and allow retry of the original payload or an intentional new submission with a new key.
5. On 429, observe `Retry-After` and avoid tight automatic loops.
6. Do not persist contact details in browser storage without an explicit privacy decision. If the page is closed and the original payload is unavailable, do not automatically create a new request; explain that the outcome may be unknown and provide a safe contact path.
7. Keep the public integration disabled by default until separate release approval.

## Verification Evidence

The results packet is `ORAC-LEAD-RETRY-IMPLEMENTATION-RESULTS.zip`, supplied by the external implementation chat and reviewed before applying. Its patch was applied with the guarded Windows script to the checkout identified above. The apply script created a timestamped backup and apply-state inventory under `.lead-retry-backups\20261016-134647`.

Independent verification in an isolated scratch copy on 16 October 2026:

- Node.js `v24.14.0` syntax check: all 7 changed JavaScript files passed.
- Focused `tests/leadIdempotency.test.js`: 29 passed, 0 failed.
- Full `npm test`: 1004 passed, 0 failed.
- Static packet validation: manifest and payload hashes passed; all 7 target files matched the packet's patched hashes.
- Tests used temporary stores and loopback HTTP servers; no production service or database was accessed.

The first sandboxed test attempt could not open loopback connections. The passing results above are from the subsequent isolated run with loopback access. They are automated test evidence, not live deployment/browser acceptance.

Not verified: live PostgreSQL; real-browser CORS from the public site's deployed origin; deployment configuration or backup restoration behavior; public-web joint acceptance; Windows PowerShell 5.1 compatibility. The apply and static validation scripts were run in the current Windows PowerShell environment, but the validator's junction-based scratch setup was blocked by sandbox permissions, so tests were independently run from a real scratch copy.

### Supplemental integrated backend verification (19 October 2026)

On the dirty backend checkout identified above, a new isolated HTTP regression test exercises one synthetic journey: keyed public lead creation, same-key replay after the original response, Sales quote creation linked by `source_lead_id`, and Admin access to the opt-in lead/quote record trail. It verifies one persisted lead, one idempotency key and one lead-created audit event, and confirms that reading the trail does not rewrite the JSON store. The feature flag is scoped to the test process; no persistent environment flag was enabled.

- Focused `tests/recordTrailHttp.test.js` and `tests/leadIdempotency.test.js`: **32/32 passed**.
- Full `npm.cmd run maintain` at this verification checkpoint: **1,038/1,038 passed**, followed by `ORAC-IOS backend maintenance gate passed`. The subsequent 19 October PO/dispatch HTTP verification reran the whole gate successfully at **1,039/1,039**; see `PO_VERIFICATION_AND_DISPATCH_POLICY.md`.
- The test uses a temporary JSON store and loopback HTTP server with fictional `.invalid` contact data. It does not exercise the public website, a real browser preflight, live PostgreSQL, multiple JSON-store processes, deployment or production data.

This is backend-to-backend automated evidence only. It narrows the integration gap but does not close public-site joint acceptance or release gates.

## Release and Maintenance Checklist

Before enabling public-web integration:

- [ ] Review this local diff and keep the backend change isolated from unrelated work.
- [ ] Merge/release the backend through the repository's normal review process; this document does not approve that release.
- [ ] Confirm production `CORS_ORIGINS` includes only the approved public website origin.
- [ ] Confirm production uses the persistent PostgreSQL store and understand JSON single-process limits in any non-production environment.
- [ ] Confirm deployment storage and backup retention are compatible with the 24-hour personal-data snapshot.
- [ ] Integrate the public forms using the frontend rules above; test Contact and Quote form behavior with fictional data.
- [ ] Run a lost-acknowledgement test: commit a synthetic lead, drop the response, retry with the same key, and verify exactly one lead and the same reference.
- [ ] Verify same key/different payload returns 409, replay survives process restart, expiry behaves at the boundary, and `Retry-After` remains respected.
- [ ] Verify browser preflight and replay header from the approved public origin.
- [ ] Obtain explicit release/activation approval; the feature flag must remain off until then.

After changes to the contract, update this document and `tests/leadIdempotency.test.js` together. Run focused and full tests. Before a commit, follow `MAINTAINER_GUARDRAILS.md`, including `npm run maintain`. Never use production leads for idempotency tests.
