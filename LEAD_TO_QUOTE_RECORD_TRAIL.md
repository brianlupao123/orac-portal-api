# Lead-to-Quote Record Trail

**Status:** implemented locally and automated-tested; opt-in flag remains off unless explicitly configured. Not deployed or release-approved.

## Contract

- `POST /api/quotes` accepts optional `source_lead_id`.
- With no link supplied, the stored quote shape is unchanged.
- With `ORAC_RECORD_TRAIL_V1` unset or not equal to `enabled`, a supplied link is rejected with `409 TRAIL_LINK_DISABLED`; it is never silently discarded.
- When enabled, the lead must exist. A lead that already has a `client_id` must match the quote client. Public leads without a client id may be linked by authorized quote creators.
- `GET /api/trail/quotes/:id` is authenticated and read-only. It reports recorded stages or `not_recorded`; it never invents or backfills historical links.
- `POST /api/ai/record-analysis` accepts an exact `{ "record_type": "quote" | "dispatch" | "invoice" | "purchase_order" | "catalog_item" | "stock_item" | "worksheet_register" | "service_request", "record_id": "..." }` reference and returns a deterministic evidence summary. It is not a language-model answer and accepts no free-form tool instructions. The route is hidden unless `ORAC_RECORD_TRAIL_V1=enabled`.
- Quote, Dispatch, Invoice, Purchase Order, Stock Item, monthly Worksheet Register and Service Request analysis are separate typed adapters. Dispatch analysis returns role-visible field-worksheet and approved/pending kiosk review evidence; PO status is included only for roles that already hold PO read access. Technician rows are own-only; Supervisor dispatches are assignment-scoped; Management does not receive the separate rate-bearing Timesheet rows. Invoice analysis is available to Admin, Management, Finance and Client Viewer under the existing invoice collection policy. Client Viewer ownership is checked via invoice -> dispatch -> quote -> client; unresolved or cross-client invoices return 404. Finance receives invoice and PO status/references only, while Admin/Management may also receive linked dispatch and quote references. Amounts, lines, costs, reasons and inferred payment state are excluded; payment is explicitly `not_determined`. PO analysis is available to Admin, Management, Finance and Operations, matching the collection guard. It reports stored verification/amendment markers and a verified Quote link, but excludes PO reference text, amount, client identity and audit events; it does not authorize dispatch or approve an amendment. Sales may verify through the existing action but is not granted PO read access. Stock Item analysis is available only to Admin, Management and Operations, matching inventory read access. It reuses the existing read-only ledger reconciliation, returns bounded evidence IDs and arithmetic exceptions, and does not claim physical count, supplier proof or valuation. Worksheet Register analysis is available to Admin, Management, Operations and Supervisor; it reports approved worker/date coverage and allowlisted source IDs only, flags overlap with other approved registers, treats non-approved registers as unconfirmed, hashes unlinked roster keys, and caps output at 500 rows/references. It does not expose names or hours or establish billability/invoice readiness. Service Request analysis is available only to Client Viewer for own-client records and Sales/Operations for triage records. It verifies conversion using reciprocal request/Lead links and states that Accepted/requested dates do not establish a booking. Service text, triage notes and client/staff names are omitted; audit action history is not returned because this route does not grant `viewAudit`. Materials, payments and other unsupported entities are not searched generically.
- The analysis returns only visible stage/evidence references, safe status projections, gap/exception codes and limitations. It does not return audit snapshots, rates, costs, amounts, contact fields, free-text notes, or inferred links. Its audit entry stores target IDs and finding codes, not record content or a free-text question.

## Role and data boundaries

The Quote trail mirrors the existing collection policies in `src/controllers/coreController.js`. Dispatch analysis follows the dispatch/field-worksheet collection scope plus the separately enforced `viewDispatchTimesheets` permission:

- Admin and Management can see the full staff trail.
- Sales can see lead and quote stages, but not PO or dispatch records.
- Operations can see quote, PO and dispatch stages, but not lead records.
- Finance can see quote and PO stages, but not lead or dispatch records.
- Audit event metadata is returned only to Admin, Management and Finance, matching the existing `audit_logs` collection guard. Sales and Operations receive an explicit `event_history.status` of `not_available_to_role`.
- Client Viewer, Technician, Supervisor and unrecognized roles do not gain access to this new trail endpoint. Client Viewer access to PO/dispatch trail details was intentionally not added because the current collection policy does not grant it.
- For Dispatch analysis, Admin, Management and Operations can read the dispatch and linked field-worksheet projections. Supervisor and Technician must be assigned to the dispatch. Technician sees only their own linked field worksheets and Timesheet entries. Management gets no `db.timesheets` projection because it does not hold `viewDispatchTimesheets`. PO status is exposed only to Admin, Management, Operations and Finance; PO amounts are never returned.

Event results contain action, entity id/type, timestamp and actor metadata only. Audit snapshots (`old_values`/`new_values`), contact details, amounts and PO values are not returned. Results are capped at 200 events and indicate truncation. A GET does not create an audit event or rewrite the JSON store.

The trail marks missing client-acceptance evidence and missing PO document evidence as gaps. It does not claim these artifacts exist. Historical dispatches without verified POs are shown as exceptions; the new dispatch gate separately prevents creating such dispatches.

Worksheet Register analysis follows the same Admin/Management/Operations/Supervisor visibility boundary as register reads. Only `Approved` status is treated as recorded coverage; this is an evidence summary, not authorization to invoice. Worker identity is an account ID or opaque roster-key digest, and source types are allowlisted to the system's Timesheet, Daily Time Sheet and Contractor Log types.

Catalog Item analysis follows the existing Admin/Management-only catalog read boundary. It reports the stored master-data fields and linked stock-item identifiers; supplier identity, stock levels, stock cost and unapproved free text are excluded. It does not establish accepted quote pricing or purchasing authority. Stock Item analysis follows the existing Admin/Management/Operations inventory read boundary and calls the shared `buildReconciliation` calculation for one item. The response contains arithmetic reconciliation, units, movement categories, bounded source IDs and findings, not movement rows or actor/free-text details. A reconciled ledger is not proof of physical stock, supplier delivery, valuation or accounting accuracy.

Service Request analysis follows the existing `viewOwnServiceRequests` client scope and `triageServiceRequests` Sales/Operations scope. It does not widen visibility to Admin, Management or Finance. The current record projection is not an event timeline: action history stays unreturned under these roles' existing audit permission.

## Verification evidence

The designated backend checkout was `C:\Users\BRIAN LUPAO\Desktop\ffims-asset-register\two-concept-packet-backend-20261005-235259`, branch `codex/fix-fictional-pilot-json-store`, HEAD `490822b9a4b1c37751b10ddcf85feacf8e713e29`, already dirty before this work. This change was not committed.

On 2026-10-19, Windows `npm.cmd run maintain` passed **1,063/1,063 tests, 0 failed**, including Catalog Item analysis and nine authenticated record-trail HTTP cases. The Catalog Item adapter also passed focused unit/assistant **87/87** and authenticated HTTP **9/9**. Tests use disposable/fictitious records; no real database, live service, or customer data was accessed. Git emits line-ending notices for existing mixed-ending files.

## Remaining release checks

- Reconcile the current frontend checkout and implement the corresponding user-facing lead link/trail only after its exact dirty source and role UI are reviewed.
- The AI UI does not yet expose this record-analysis endpoint; API support is not user-facing completion.
- Invoice API analysis is local-only and not exposed in the frontend. It does not verify calculations, tax/fiscal rules, payments, disputes or accounting settlement; it does not complete the invoice lifecycle.
- Worksheet Register analysis is also local API-only and not exposed in the frontend. It summarizes approval/coverage evidence, not the underlying source details, hours, billability or billing approval.
- Stock Item analysis is local API-only and not exposed in the frontend. Ledger arithmetic does not establish actual physical quantity or stock valuation.
- Catalog Item analysis is local API-only and not exposed in the frontend. It does not establish accepted quote terms or purchasing authority.
- Service Request analysis is local API-only and not exposed in the frontend. It does not return audit history or confirm appointments; a dedicated role-authorized event projection and a real booking workflow remain open.
- Add further record types only as separate adapters after their role scope, safe fields, source references, exception rules and focused adversarial tests are agreed and verified. Quote/Dispatch/Invoice support is not system-wide history or all-record analysis.
- Run a combined end-to-end fictional workflow in an isolated environment, including quote revision, PO receipt/verification, dispatch refusal cases and record-history visibility.
- Obtain release approval before enabling the trail flag in any deployed environment.
- Audit-event retention is now owner-confirmed as indefinite. This feature
  neither changes retention implementation nor broadens event visibility; see
  `AUDIT_EVENT_RETENTION_POLICY.md` for the access, pagination and production
  storage/privacy release gates.

### Latest Record-Analysis Addendum (2026-10-19)

The typed API now also accepts `field_worksheet` for standalone Timesheet analysis, with existing role/assignment scope and a safe projection of recorded hours, sign-off presence, revision links and shared daily-source eligibility. The API contract in `ORAC_AI_RECORD_ANALYSIS_API.md` is the current detailed specification. Focused adapter/assistant/HTTP suites passed 106/106 and the final Windows maintenance gate passed 1,073/1,073, 0 failed. Backend-only and default-off; no frontend, live-data or deployment verification.
