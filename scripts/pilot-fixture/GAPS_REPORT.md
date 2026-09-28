# Chat A — Gaps report

Every item below is evidence-based: either a direct mismatch between the
reconciled fixture spec (`ORAC-MONTHLY-FIXTURE-RECONCILED.zip`) and the real
ORAC-IOS source code (file/line cited), or a real behaviour observed by
actually running the loader + verifier + `npm test` against the real backend
in a local, non-production JSON store. Nothing below is asserted without a
citation to source or to an observed run in this chat.

This report is also the honest gaps output the Phase 3 plan asks Chat A to
return alongside the PR/packet. It intentionally does **not** propose fixes —
Chat A's scope is "do not implement workflow changes... change authorization,"
so several items here are directly relevant to Chats B, D, and E and are
flagged as such.

## Mapping gaps (fixture concept has no exact real-schema equivalent)

**G-REQUEST-TO-QUOTE-LINK** (new in the extension pass) — The real app supports
Client Viewer service request → triage → lead (`serviceRequestsController.js`,
`serviceRequestRules.js`; the lead carries `service_request_id` back to its
request). Nothing links a request or lead **forward** to a quote: `quotes` have
no `lead_id`/`service_request_id` (checked `quoteController.js`,
`schemas.js`). The fixture now loads one request + lead per client (3 each,
terminal state `Converted_To_Lead`, dated before that client's first quote),
but they are freestanding; the "request → quote" step is **not** proven by
current source. Owner decision needed: should quote creation reference its
originating lead/request?

**G-QUOTE-LIFECYCLE** — The real quote state machine
(`backend/src/stateMachine.js`) only has `Draft → Sent → Approved_Pending_PO →
PO_Verified → Field_Dispatch → Invoiced`. There is no `Declined` or `Expired`
status. Fixture quotes Q-006 (`decision: "declined"`) and Q-007 (`decision:
"expired"`) are loaded at `Sent` — the last real status such a quote could
hold — with the fixture's decision preserved only as a `fixture_note` string,
never as a fabricated status value.

**G-DELIVERY-ONLY** — Dispatch D-003 is delivery-only (no technician, no
field worksheet, a stock-sale path per the fixture's own note on INV-003).
The real invoice-readiness gate (`stateMachine.js` `validateTransition`, and
`computeInvoiceReadyReport` in `src/reports.js`) requires an approved
`field_worksheet` before invoicing, with **no delivery-only exception in
code**. The loaded fixture still records INV-003 as an invoice (because the
spec asserts the path exists), by direct data insertion rather than by
driving the real quote-transition API — specifically so this gap is visible
rather than hidden. **Confirmed by the verifier**: `computeDispatchReport`
genuinely reports 0 approved worksheets for D-003 even though it is invoiced.
Relevant to **Chat D** (delivery/inventory flow), which owns dispatch gaps.

**G-EVIDENCE-GATE** — The fixture's business rule ("hold invoicing until
client-signed evidence is accepted," modelled on dispatch D-004 / invoice
INV-005 "Draft-Held," held only because evidence EV-03 is `Awaiting`) has
**no enforcement anywhere in the current code**. Grep for any reference to
client evidence/signature gating invoice creation in
`src/stateMachine.js` and `src/controllers/*.js` returns nothing. **Confirmed
by the verifier**: with D-004's field worksheets loaded as
`Supervisor_Approved` (matching the fixture's own timesheet data) and no
invoice created for it, `computeInvoiceReadyReport` still lists D-004 as
invoice-ready right now — the real code has nothing that would stop Finance
from invoicing it today. This is a genuine, observed finding, not a guess.
Directly relevant to **Chat B** (digital Timesheet / client acknowledgement),
whose evidence-storage work is the natural place to wire this gate in.

**G-STOCK-RESERVE** — 3 of the fixture's 8 stock movements use action
`"Reserve"` (a soft hold with no physical quantity change). The real
`stock_items`/`stock_movements` model
(`src/controllers/inventoryController.js`, `src/schemas.js`
`StockMovementSchema`) has only `movement_type: "in" | "out" | "adjustment"`
and no reservation field at all. These 3 movements were not loaded. Matches
language already used elsewhere in the Phase 3 plan ("unresolved... stock
reservation... owner decision" — Chat E's scope, item to log rather than
guess at).

**G-INVOICE-STATUS** — The only invoice status literally assigned anywhere in
the codebase is `"sent"` (`stateMachine.js` `createInvoice`) and `"voided"`
(`src/controllers/coreController.js` `voidInvoice`). `"paid"` is checked
(`coreController.js` line ~345) but **never set anywhere** — there is no
mark-paid endpoint in the current code. The fixture's `"Authorised"` status
maps to real `"sent"` (an invoice only exists once every real gate has
passed); `"Draft-Held"` (INV-005) has no real equivalent at all — the app
does not create a placeholder/held invoice row for unbillable work, so
INV-005 was not loaded as an invoice record (its dispatch, timesheets and
worksheets still are, so a report can show the work as done-but-unbilled).

**G-DISPUTE** — Fixture invoice INV-004 records a client dispute
(`disputeRaised`, `disputedAmount`, `disputeReason`, `disputeResolution`).
The real app has no dispute field or workflow — only the single `voidInvoice`
action, which is not a dispute mechanism. Not loaded as a structured field.

**G-EXPORT-BATCH** — Fixture invoices reference `exportBatch: "EXP-01"`. The
real schema has vestigial `pastel_export_batches` / `pastel_export_lines`
arrays (`src/store.js`, `src/curatedDemoData.js`) but **no controller
anywhere reads or writes them** — `grep -rl "pastel_export_batches"
src/` returns only those two files, never a controller. Not loaded, since
fabricating export-batch records would assert a feature that does not exist.

**G-ACCESS-REQUEST-SHAPE** — The real `access_requests` model
(`src/controllers/accessRequestsController.js`) is a pre-account request by
name/email/`requested_role` — it is not a mechanism for an *existing* user to
request linkage to an *additional* client, which is what the fixture's
`accessRequests` actually describe (`targetClientLink`). Loaded using the
closest real shape; the "link an existing viewer to another client" intent
survives only in the `reason` text field, not as a structured link. Relevant
to **Chat E** (governance/administration).

**G-SITE-DEPTH** — The real entity hierarchy is `Client → Mine Site → Plant →
Plant Section → Equipment Tag`. The fixture's flat `sites` list (e.g.
`SITE-01A`) was loaded as one `mine_site` per code; `plant`/`plant_section`/
`equipment_tag` were left unset (the fixture has no data to populate them
with). Relevant to **Chat H** (entity master data / site hierarchy).

**G-WORKSHEET-HISTORY** — Real `field_worksheets` carry a single current
`status`; the fixture's per-timesheet `history` array (Submitted → Returned →
Submitted → Approved, e.g. T-002) was folded into the final status only. The
transient states are not recreated as separate real audit events. This
chat does not touch the client-signature/Timesheet workflow — that is
**Chat B's** scope.

## Extension scenarios added in the second pass (only where source supports them)

| Step | Loaded? | Basis |
|---|---|---|
| Client request → lead | Yes (3 each) | real `service_requests` / `leads` shapes; mutations copied from `triageServiceRequest` / `convertServiceRequestToLead` |
| Supplier receipt, service issue, return | Yes (already in pass 1) | `movement_type` in/out |
| Stock adjustment | Yes (1, STK-003, −2 cycle-count) | `movement_type: "adjustment"` exists in schema; source fixture never used it |
| On-hand stock | Yes | `stock_items.quantity_on_hand`, replay-verified |
| Client acknowledgement / direct-sale evidence (EV-01..05) | **No** | no evidence/document collection and no acknowledgement field exists (`documentController.js` generates PDFs on demand only) |

## Owner decisions (recorded, not guessed)

- **OD-1 Sales-order object**: fixture/plan mention direct client sales; no sales-order entity exists. Delivery-only dispatch + invoice is the closest thing (see G-DELIVERY-ONLY).
- **OD-2 Costing / tax**: invoices carry `total_amount` from labour + material only; no tax, cost-of-sale or margin fields exist. None invented.
- **OD-3 Stock reservation**: no field; the 3 `Reserve` movements are skipped.
- **OD-4 Warehouse / location model**: `stock_items.location` is a free-text string only; no warehouse hierarchy.
- **OD-5 Client acknowledgement + evidence gate**: not modelled; whether it blocks invoice readiness is an owner rule (Chat B).
- **OD-6 Approval thresholds / void-reissue**: no thresholds exist in code; `voidInvoice` is the only reversal.
- **OD-7 Request→quote linkage**: see G-REQUEST-TO-QUOTE-LINK.
- **OD-8 Mark-paid**: `"paid"` is checked but never set anywhere.

## Internal Work Requests — 2 of 12 have no real pairing at all

Checked programmatically against the actual
`INTERNAL_WORK_REQUEST_POLICY` in `src/internalWorkRequestRules.js`
(via `isPairingAllowed`, imported — not reimplemented) rather than guessed:

- **IWR-003** (Technician TEC-01 → Supervisor, re: Dispatch D-001): the real
  policy's `FIELD_CLARIFICATION` type only allows `Technician → Operations`
  and `Supervisor → Operations`. Technician → Supervisor is not a permitted
  pairing in any real type. Not loaded. (The fixture's own compatibility note
  already flagged this as `requires_implementation`.)
- **IWR-011** (Management MGT-01 → Sales, re: Quote Q-007): the real policy's
  only Management-as-sender type is `ADMINISTRATIVE_SUPPORT`, whose only
  recipient for Management is `Admin`. Management → Sales has no real pairing
  in any type. Not loaded.

The other 10 were mapped to the closest real type (see
`build-fixture-records.mjs`, `IWR_REAL_TYPE_BY_FIXTURE_ID`) and every mapping
was re-validated independently by `verify-pilot-fixture.mjs` calling the same
real `isPairingAllowed` function — 10/10 pass. Several of the 10 (e.g.
IWR-007, IWR-008, IWR-009, all Finance → Operations) were mapped to
`PO_AMENDMENT_CONFIRMATION` only because it is the *sole* real type that
permits that sender/recipient direction at all — the fixture's own proposed
type names for them (`invoice_commercial_reconciliation`,
`client_completion_signoff_clarification`, `document_evidence_request`) do
not exist as real types. This is a real finding for **Chat E**: the current
IWR type catalogue may be narrower than day-to-day cross-department
communication needs.

## Negative/edge-case scenarios: executed vs. still open

The fixture's `negativeAndEdgeCaseScenarios` (12 items, NT-01..NT-12) are all
marked `"status": "requires_source_execution"` in the source package — i.e.
things to test against running code, not data to load. This chat executed 4
of them as real automated tests
(`tests/pilotFixtureNegativeScenarios.test.js`, 6 test cases, all passing —
see `npm test` output in `VALIDATION_REPORT.md`):

| ID | Description | Result |
|---|---|---|
| NT-01 | Client Viewer requests another client's quote by ID | confirmed refused (data-isolation via `scopeByClient`) |
| NT-02 | Technician sends an IWR addressed to Finance | confirmed rejected (403, no record written) |
| NT-03 | Supervisor approves a worksheet not assigned to them | confirmed denied (403); assigned Supervisor control case confirmed allowed |
| NT-04 | Issue more stock than is on hand | confirmed refused (409, on-hand unchanged) |

**Still open (not executed in this chat) — for a later session:**
- NT-05 (concurrent PO edit / stale-write conflict) — needs the HTTP layer
  and two overlapping requests; out of scope for an in-process unit test.
- NT-06 (duplicate Timesheet submission de-duplication) — `addTimesheet`
  (`src/controllers/dispatchController.js`) currently has **no visible
  duplicate-submission guard** on a quick read of the handler; this needs
  confirming against the real endpoint, not assumed either way.
- NT-07 (session expiry mid-form) — needs the auth/session middleware layer.
- NT-08 (empty-state dashboard for a newly linked Client Viewer) — needs a
  frontend check, out of this backend-only chat's scope.
- NT-09 (Client Viewer document download scoping) — plausible via
  `scopeByClient`-style logic in `src/controllers/documentController.js`, not
  yet checked line-by-line.
- NT-10 (CSV export formula-injection escaping) — already covered by
  `csvEscape` in `src/exporter.js`, which the existing test suite already
  exercises; no new test needed, just noting it here for completeness.
- NT-11 (AI assistant cross-client refusal) — `tests/aiAssistant.test.js`
  already exists in the suite; not re-verified against this specific phrasing
  in this chat.
- NT-12 (Finance authorising an invoice with a negative amount adjustment) —
  **there is no "authorise invoice with adjustment" endpoint in the current
  code at all** (only `createInvoice`, which takes no adjustment input, and
  `voidInvoice`). This may itself be worth flagging to whoever owns invoice
  authorisation UX, since the fixture assumes an adjustment path exists.

## What this chat did NOT do (by design, per its own scope)

- No workflow changes, no digital-signature work (Chat B), no UI changes
  (Chat F), no deployment, no seeding of any real Fly.io/Neon database — the
  loader was run only against a local JSON store inside this sandboxed
  session (`STORE_DRIVER=json`, see `VALIDATION_REPORT.md`).
- `checkpoints` (12 point-in-time snapshots) and `outOfScopeAcceptanceStubs`
  (6 explicit placeholders) from the fixture package were not loaded as
  records — neither has a real schema equivalent, and the fixture package
  itself marks the stubs out of scope.
