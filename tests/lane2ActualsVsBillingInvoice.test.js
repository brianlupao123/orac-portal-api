// Lane 2, Batch 1 (test-only): real-store proof that invoicing bills approved kiosk
// hours, and that this is a different quantity from "Actual field hours".
//
// Uses the same real store + real state machine fixture pattern as
// task03KioskDuplicatesAndInvoice.test.js. The hourly rate below is a TEST-ONLY
// number: it is not a policy and nothing here asserts any approved rate.
// No production file, flag, permission or data is changed.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { issueLegacyInvoice, transitionQuote } from "../src/stateMachine.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { reviewKioskTimesheet } from "../src/controllers/timesheetReviewController.js";
import { assignDispatchSupervisor } from "../src/controllers/dispatchController.js";
import { billedHours } from "../src/timesheetWorkflow.js";
import { hoursContract, snapshot, withFlagsUnset } from "./helpers/lane2HoursContract.js";

const TEST_ONLY_RATE = 10;
let restoreFlags;
before(() => { restoreFlags = withFlagsUnset(); });
after(() => { restoreFlags?.(); });

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }

const v2 = (id, over = {}) => ({ id, timesheet_version: 2, status: "Supervisor_Approved", activity: "Work", technician_id: "u_t1", work_date: "2026-09-21", hours: 0, hours_breakdown: { normal: 0, ot_15: 0, ot_20: 0 }, ...over });

function world() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", name: "Admin", is_active: true },
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_sup", role: "Supervisor", name: "Sup", is_active: true },
      { id: "u_t1", role: "Technician", name: "Tech One", is_active: true },
      { id: "u_t2", role: "Technician", name: "Tech Two", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "Labour", quantity: 1, unit_price: 100, line_total: 100 }],
    quotes: [{ id: "q1", quote_number: "Q-1", client_id: "c1", equipment_tag_id: "eq1", status: "Draft", total_amount: 100 }],
    purchase_orders: [], dispatch_cards: [], field_worksheets: [], timesheets: [], material_usage: [],
    invoices: [], invoice_lines: [], audit_logs: []
  };
  const admin = db.users[0];
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", { approval_exception_reason: "Sales approver unavailable during client operational deadline." }, admin);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-1", po_amount: 100000, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, admin);
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, admin);
  const dispatch = db.dispatch_cards[0];
  dispatch.assigned_technician_ids = ["u_t1", "u_t2"];
  // Actual field hours for this dispatch: ws_a 3h + ws_rev 4h = 7h. The superseded original (5h) must not count.
  db.field_worksheets.push(
    v2("ws_a", { dispatch_card_id: dispatch.id, hours: 3, hours_breakdown: { normal: 3, ot_15: 0, ot_20: 0 } }),
    v2("ws_orig", { dispatch_card_id: dispatch.id, hours: 5, hours_breakdown: { normal: 5, ot_15: 0, ot_20: 0 }, superseded_by: "ws_rev" }),
    v2("ws_rev", { dispatch_card_id: dispatch.id, hours: 4, hours_breakdown: { normal: 4, ot_15: 0, ot_20: 0 } })
  );
  return { db, store, dispatch, admin };
}
function rq(w, userId, extra = {}) { return { user: { id: userId }, db: w.db, store: w.store, params: { id: w.dispatch.id }, query: {}, body: {}, ...extra }; }
function submit(w, body, userId = "u_ops") { const r = response(); submitKioskTimesheets(rq(w, userId, { body }), r); return r; }
function review(w, userId, id, body) { const r = response(); reviewKioskTimesheet(rq(w, userId, { params: { id }, body }), r); return r; }
function assignSupervisor(w) { const r = response(); assignDispatchSupervisor(rq(w, "u_ops", { body: { supervisor_id: "u_sup" } }), r); assert.equal(r.statusCode, 200); }
const invoice = (w) => () => issueLegacyInvoice(w.db, w.store, "q1", w.admin);
const entries = () => [
  { technician_id: "u_t1", hours_logged: 2, hourly_rate: TEST_ONLY_RATE },
  { technician_id: "u_t2", hours_logged: 3, hourly_rate: TEST_ONLY_RATE }
];

test("pending kiosk rows block invoicing; approved rows are billed; rejected rows are excluded", () => {
  const w = world();
  assignSupervisor(w);
  assert.equal(submit(w, { work_date: "2026-09-21", entries: entries() }).statusCode, 200);
  const [t1, t2] = w.db.timesheets;

  assert.throws(invoice(w), (e) => /2 kiosk timesheet entries are awaiting Supervisor review/.test(e.message) && e.status === 400);
  assert.equal(w.db.invoices.length, 0);

  assert.equal(review(w, "u_sup", t1.id, { decision: "approve" }).statusCode, 200);
  assert.equal(review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" }).statusCode, 200);

  assert.equal(invoice(w)().status, "sent");
  assert.equal(w.db.invoices.length, 1);
  assert.equal(w.db.invoices[0].total_amount, 2 * TEST_ONLY_RATE);       // approved 2h billed; rejected 3h excluded
});

test("Actual field hours (7) and Billable hours (2) are different quantities for the same dispatch, and the invoice follows Billable hours", () => {
  const w = world();
  assignSupervisor(w);
  submit(w, { work_date: "2026-09-21", entries: entries() });
  const [t1, t2] = w.db.timesheets;
  review(w, "u_sup", t1.id, { decision: "approve" });
  review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" });
  invoice(w)();

  const c = hoursContract(w.db, w.dispatch.id);
  assert.equal(c.actual_field_hours.label, "Actual field hours");
  assert.equal(c.billable_hours.label, "Billable hours");
  assert.equal(c.actual_field_hours.total, 7);                            // superseded 5h excluded
  assert.deepEqual(c.actual_field_hours.worksheet_ids, ["ws_a", "ws_rev"]);
  assert.equal(c.billable_hours.total, 2);
  assert.deepEqual(c.billable_hours.row_ids, [t1.id]);
  assert.notEqual(c.actual_field_hours.total, c.billable_hours.total);
  assert.equal(w.db.invoices[0].total_amount / TEST_ONLY_RATE, c.billable_hours.total);   // invoice = Billable hours x rate
  assert.notEqual(w.db.invoices[0].total_amount / TEST_ONLY_RATE, c.actual_field_hours.total);
});

test("CHARACTERIZATION: billedHours (variance helper) counts the rejected row too, so it differs from the hours the invoice actually bills", () => {
  const w = world();
  assignSupervisor(w);
  submit(w, { work_date: "2026-09-21", entries: entries() });
  const [t1, t2] = w.db.timesheets;
  review(w, "u_sup", t1.id, { decision: "approve" });
  review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" });
  invoice(w)();
  assert.equal(billedHours(w.db, w.dispatch.id).total, 5);                // 2 approved + 3 rejected
  assert.equal(w.db.invoices[0].total_amount / TEST_ONLY_RATE, 2);        // the invoice bills 2
});

test("Daily timesheets and worksheet registers present on the database change neither the invoice nor Actual field hours", () => {
  const w = world();
  w.db.daily_timesheets = [{ id: "dts1", status: "Supervisor_Approved", worker_name: "Test Worker", rows: [{ date: "2026-09-21", normal_hours: 8, ot_15: 2, ot_20: 1 }] }];
  w.db.worksheet_registers = [{ id: "wks1", status: "Approved", lines: [{ roster_key: "t_u_t1", date: "2026-09-21", normal: 100, ot_15: 50, ot_20: 25 }] }];
  assignSupervisor(w);
  submit(w, { work_date: "2026-09-21", entries: entries() });
  const [t1, t2] = w.db.timesheets;
  review(w, "u_sup", t1.id, { decision: "approve" });
  review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" });
  invoice(w)();
  assert.equal(w.db.invoices[0].total_amount, 2 * TEST_ONLY_RATE);
  assert.equal(hoursContract(w.db, w.dispatch.id).actual_field_hours.total, 7);
});

test("Reading Actual field hours and Billable hours after invoicing mutates no source record", () => {
  const w = world();
  assignSupervisor(w);
  submit(w, { work_date: "2026-09-21", entries: entries() });
  const [t1, t2] = w.db.timesheets;
  review(w, "u_sup", t1.id, { decision: "approve" });
  review(w, "u_sup", t2.id, { decision: "reject", comment: "Not on site" });
  invoice(w)();
  const before = snapshot(w.db);
  hoursContract(w.db, w.dispatch.id); billedHours(w.db, w.dispatch.id);
  assert.equal(snapshot(w.db), before);
});
