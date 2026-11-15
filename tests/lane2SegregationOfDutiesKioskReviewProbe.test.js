// Lane 2, FB6 (test-only) FINDING PROBE: kiosk review controller behaviour.
// The author did not have src/controllers/timesheetReviewController.js. These tests state
// the secure behaviour the programme needs. If one fails, that is a FINDING to report to the
// owner; do not change production code in this batch to make it pass.
// Fixture pattern copied from task03KioskDuplicatesAndInvoice.test.js and the BATCH_01 invoice test.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { reviewKioskTimesheet } from "../src/controllers/timesheetReviewController.js";
import { assignDispatchSupervisor } from "../src/controllers/dispatchController.js";
import { transitionQuote } from "../src/stateMachine.js";

let savedEnv;
before(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("TIMESHEET_")) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});
after(() => { for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; });

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function call(fn, request) {
  const res = response();
  try { fn(request, res); } catch (error) { res.statusCode = error.status || 500; res.body = { message: error.message }; }
  return res;
}

function world() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", name: "Admin", is_active: true },
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_sup", role: "Supervisor", name: "Sup", is_active: true },
      { id: "u_sup2", role: "Supervisor", name: "Other Sup", is_active: true },
      { id: "u_t1", role: "Technician", name: "Tech One", is_active: true },
      { id: "u_fin", role: "Finance", name: "Fin", is_active: true },
      { id: "u_mgmt", role: "Management", name: "Mgmt", is_active: true },
      { id: "u_sales", role: "Sales", name: "Sales", is_active: true },
      { id: "u_client", role: "Client Viewer", name: "Client", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Labour", quantity: 1, unit_price: 100, line_total: 100 }],
    quotes: [{ id: "q1", quote_number: "Q-1", client_id: "c1", equipment_tag_id: "eq1", status: "Draft", total_amount: 100 }],
    purchase_orders: [], dispatch_cards: [], field_worksheets: [], timesheets: [], material_usage: [], invoices: [], invoice_lines: [], audit_logs: []
  };
  const admin = db.users[0];
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", { approval_exception_reason: "Sales approver unavailable during client operational deadline." }, admin);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-1", po_amount: 100000, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, admin);
  const dispatch = db.dispatch_cards[0];
  dispatch.assigned_technician_ids = ["u_t1"];
  return { db, store, dispatch };
}
const rq = (w, userId, extra = {}) => ({ user: { id: userId }, db: w.db, store: w.store, params: { id: w.dispatch.id }, query: {}, body: {}, ...extra });

function pendingRow() {
  const w = world();
  assert.equal(call(assignDispatchSupervisor, rq(w, "u_ops", { body: { supervisor_id: "u_sup" } })).statusCode, 200);
  const res = call(submitKioskTimesheets, rq(w, "u_ops", { body: { work_date: "2026-10-05", entries: [{ technician_id: "u_t1", hours_logged: 2, hourly_rate: 10 }] } }));
  assert.equal(res.statusCode, 200);
  return { w, row: w.db.timesheets[0] };
}
const review = (w, userId, id, body) => call(reviewKioskTimesheet, rq(w, userId, { params: { id }, body }));

test("PROBE: roles other than Supervisor cannot approve a kiosk row; the row stays pending", () => {
  for (const userId of ["u_admin", "u_ops", "u_t1", "u_fin", "u_mgmt", "u_sales", "u_client"]) {
    const { w, row } = pendingRow();
    const res = review(w, userId, row.id, { decision: "approve" });
    assert.notEqual(res.statusCode, 200, userId);
    assert.equal(row.review_status, "pending_review", userId);
    assert.equal(row.reviewed_by, null, userId);
  }
});

test("PROBE: a Supervisor who is not the dispatch's assigned Supervisor cannot approve its kiosk rows", () => {
  const { w, row } = pendingRow();
  const res = review(w, "u_sup2", row.id, { decision: "approve" });
  assert.notEqual(res.statusCode, 200);
  assert.equal(row.review_status, "pending_review");
});

test("PROBE: the assigned Supervisor can approve; reviewed_by and reviewed_at are stamped and the recorder differs from the reviewer", () => {
  const { w, row } = pendingRow();
  const res = review(w, "u_sup", row.id, { decision: "approve" });
  assert.equal(res.statusCode, 200);
  assert.equal(row.review_status, "approved");
  assert.equal(row.reviewed_by, "u_sup");
  assert.ok(row.reviewed_at);
  assert.notEqual(row.reviewed_by, row.recorded_by_user_id);
});

test("PROBE: a decided kiosk row cannot be approved a second time by another reviewer", () => {
  const { w, row } = pendingRow();
  assert.equal(review(w, "u_sup", row.id, { decision: "reject", comment: "Not on site" }).statusCode, 200);
  const again = review(w, "u_sup", row.id, { decision: "approve" });
  assert.notEqual(again.statusCode, 200);
  assert.equal(row.review_status, "rejected");
});
