// tests/pilotFixtureNegativeScenarios.test.js
//
// Executes a subset of the reconciled pilot fixture's
// negativeAndEdgeCaseScenarios (see scripts/pilot-fixture/
// fixture-scenarios.source.json, array `negativeAndEdgeCaseScenarios`)
// as real automated tests against the actual controllers and rules —
// not left as "requires_source_execution" the way the fixture package
// itself marks every one of them.
//
// Only NT-01 through NT-04 are covered here. NT-05..NT-12 are listed,
// unexecuted, in GAPS_REPORT.md for a later chat/session — most of them
// need either a running HTTP server (NT-05 concurrent-edit, NT-07 session
// expiry) or a feature this chat does not touch (NT-10 CSV export escaping
// is already covered by the existing exporter tests; NT-12 assumes an
// "authorise invoice with adjustment" endpoint that does not exist in the
// current codebase at all).
//
// Uses the same fake-req/res unit-test convention as the app's own
// tests/segregationOfDuties.test.js and tests/inventoryController.test.js —
// no HTTP server, no real database, calling the real exported controller
// functions directly.

import assert from "node:assert/strict";
import test from "node:test";

import { scopeByClient } from "../src/middleware/clientScope.js";
import { isPairingAllowed } from "../src/internalWorkRequestRules.js";
import { createInternalWorkRequest } from "../src/controllers/internalWorkRequestsController.js";
import { reviewWorksheet } from "../src/controllers/dispatchController.js";
import { recordStockMovement } from "../src/controllers/inventoryController.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

// ── NT-01: CLV-01 (client UAT-CLI-01) requests Quote Q-004 (client UAT-CLI-02) by ID ──
// Fixture expected outcome: "Not found; access attempt logged."
test("NT-01: a Client Viewer never sees another client's quote through scopeByClient", () => {
  const cli01 = { id: "u_clv01", role: "Client Viewer", client_id: "c_uat01" };
  const quotes = [
    { id: "q_own", client_id: "c_uat01", quote_number: "Q-OWN" },
    { id: "q_other", client_id: "c_uat02", quote_number: "Q-004" } // belongs to a different client
  ];

  const visible = scopeByClient(quotes, cli01, (q) => q.client_id);

  assert.equal(visible.some((q) => q.id === "q_other"), false, "another client's quote must not be visible");
  assert.deepEqual(visible.map((q) => q.id), ["q_own"], "only the caller's own client's quote is visible");
});

// ── NT-02: TEC-01 sends an IWR addressed to Finance ────────────────────────
// Fixture expected outcome: "Rejected at the server; attempt logged."
test("NT-02: the real IWR pairing policy has no Technician -> Finance route at all", () => {
  // Technician's only real recipient (any type) is Operations (FIELD_CLARIFICATION)
  // or Admin/Management (ADMINISTRATIVE_SUPPORT). Finance is never reachable.
  assert.equal(isPairingAllowed("FIELD_CLARIFICATION", "Technician", "Finance"), false);
  assert.equal(isPairingAllowed("ADMINISTRATIVE_SUPPORT", "Technician", "Finance"), false);
});

test("NT-02: createInternalWorkRequest rejects Technician -> Finance at the controller (403, no record written)", () => {
  const actor = { id: "u_tec01", role: "Technician", is_active: true };
  const db = {
    users: [actor],
    dispatch_cards: [{ id: "job-1", assigned_technician_id: "u_tec01" }],
    internal_work_requests: [],
    notifications: []
  };
  const req = {
    user: { id: actor.id },
    db,
    store: { id: () => "iwr-x", audit: () => {} },
    body: {
      request_type: "FIELD_CLARIFICATION",
      recipient_role: "Finance", // not a real recipient for this type/role
      subject: "Bogus cross-department request",
      description: "Attempting to reach Finance directly, which is not a permitted pairing.",
      priority: "Normal",
      related_entity_type: "dispatch_card",
      related_entity_id: "job-1"
    }
  };
  const res = createResponse();

  createInternalWorkRequest(req, res);

  assert.equal(res.statusCode, 403, "the controller must refuse this at the server, not silently accept it");
  assert.equal(db.internal_work_requests.length, 0, "no IWR record is created for a rejected request");
});

// ── NT-03: SUP-01 attempts to approve a worksheet assigned to SUP-02 ────────
// Fixture expected outcome: "Denied."
test("NT-03: a Supervisor not assigned to the dispatch cannot approve its worksheet", () => {
  const sup01 = { id: "u_sup01", role: "Supervisor", is_active: true };
  const sup02 = { id: "u_sup02", role: "Supervisor", is_active: true };
  const dispatch = { id: "dispatch-d2", assigned_supervisor_id: sup02.id };
  const worksheet = { id: "worksheet-t4", dispatch_card_id: dispatch.id, status: "Submitted", submitted_by: "u_tec04" };
  const db = {
    users: [sup01, sup02, { id: "u_tec04", role: "Technician", is_active: true }],
    dispatch_cards: [dispatch],
    field_worksheets: [worksheet],
    purchase_orders: [],
    audit_logs: []
  };
  const req = {
    user: { id: sup01.id },
    params: { id: worksheet.id },
    body: { decision: "approve", comment: "" },
    db,
    store: { audit: () => {} }
  };
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 403, "an unassigned Supervisor must be denied, not silently allowed to approve");
  assert.equal(worksheet.status, "Submitted", "the worksheet status must not change on a denied attempt");
});

test("NT-03 (control): the assigned Supervisor CAN approve the same worksheet", () => {
  const sup02 = { id: "u_sup02", role: "Supervisor", is_active: true };
  const dispatch = { id: "dispatch-d2b", assigned_supervisor_id: sup02.id };
  const worksheet = { id: "worksheet-t4b", dispatch_card_id: dispatch.id, status: "Client_Acknowledged", submitted_by: "u_tec04" };
  const db = {
    users: [sup02, { id: "u_tec04", role: "Technician", is_active: true }],
    dispatch_cards: [dispatch],
    field_worksheets: [worksheet],
    purchase_orders: [],
    audit_logs: []
  };
  const req = {
    user: { id: sup02.id },
    params: { id: worksheet.id },
    body: { decision: "approve", comment: "" },
    db,
    store: { audit: () => {} }
  };
  const res = createResponse();

  reviewWorksheet(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(worksheet.status, "Supervisor_Approved");
});

// ── NT-04: Issue 45 sheets of STK-001 when fewer are available ─────────────
// Fixture expected outcome: "Refused; on-hand not reduced."
test("NT-04: issuing more stock than is on hand is refused and on-hand is unchanged", () => {
  const actor = { id: "u_ops01", role: "Operations", is_active: true };
  const item = { id: "stk-001", item_name: "Steel plate 10mm", quantity_on_hand: 7, unit_of_measure: "sheet" };
  const db = { users: [actor], stock_items: [item], stock_movements: [] };
  const req = {
    user: { id: actor.id },
    db,
    store: { id: () => "smv-x", audit: () => {} },
    body: { stock_item_id: item.id, movement_type: "out", quantity: 45, reason: "Fixture NT-04: over-issue attempt", override_negative: false }
  };
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 409, "an over-issue must be refused with a conflict, not silently clamped or allowed");
  assert.equal(item.quantity_on_hand, 7, "on-hand quantity must be unchanged after a refused movement");
  assert.equal(db.stock_movements.length, 0, "no movement record is written for a refused issue");
});
