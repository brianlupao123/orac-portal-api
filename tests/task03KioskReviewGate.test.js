import test from "node:test";
import assert from "node:assert/strict";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { listDispatchTimesheets, listKioskReviewQueue, reviewKioskTimesheet } from "../src/controllers/timesheetReviewController.js";
import { exportInvoicesCsv } from "../src/exporter.js";
import { approvedLabourValue, timesheetCountsAsApproved, kioskReviewStatus } from "../src/timesheetReview.js";
import { transitionQuote } from "../src/stateMachine.js";

function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }

function makeDb() {
  return {
    users: [
      { id: "ops-1", role: "Operations", name: "Ops", is_active: true },
      { id: "sup-1", role: "Supervisor", name: "Sup One", is_active: true },
      { id: "sup-2", role: "Supervisor", name: "Sup Two", is_active: true },
      { id: "tech-1", role: "Technician", name: "Tech One", trade: "Fitter", is_active: true },
      { id: "tech-2", role: "Technician", name: "Tech Two", trade: "Welder", is_active: true }
    ],
    dispatch_cards: [{ id: "d1", dispatch_number: "DC-1", status: "In_Progress", assigned_technician_id: "tech-1", assigned_supervisor_id: "sup-1", purchase_order_id: "po-1" }],
    field_worksheets: [],
    invoices: [],
    timesheets: []
  };
}
function store() { const calls = []; return { calls, id: (() => { let i = 0; return () => `ts-${++i}`; })(), audit(...a) { calls.push(a[4]); }, recalculateVariance() { calls.push("variance"); } }; }
function req(db, st, userId, extra = {}) { return { user: { id: userId }, db, store: st, params: {}, query: {}, body: {}, ...extra }; }

function submitAs(db, st) {
  const r = req(db, st, "ops-1", { params: { id: "d1" }, body: { work_date: "2026-09-21", entries: [{ technician_id: "tech-1", hours_logged: 8, hourly_rate: 45, hours_breakdown: { normal: 6, ot_1_5: 1, ot_2_0: 1 } }] } });
  const res = response(); submitKioskTimesheets(r, res); return res;
}
function review(db, st, userId, id, body) { const res = response(); reviewKioskTimesheet(req(db, st, userId, { params: { id }, body }), res); return res; }

test("kiosk submission is pending review and does not count as approved", () => {
  const db = makeDb(); const st = store(); const res = submitAs(db, st);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.entries[0].review_status, "pending_review");
  const row = db.timesheets[0];
  assert.equal(kioskReviewStatus(row), "pending_review");
  assert.equal(timesheetCountsAsApproved(row), false);
  assert.equal(approvedLabourValue(db, ["d1"]), 0);
  assert.deepEqual(row.hours_breakdown, { normal: 6, ot_1_5: 1, ot_2_0: 1 });
});

test("legacy kiosk row without review_status fails closed; non-kiosk rows are unaffected", () => {
  assert.equal(timesheetCountsAsApproved({ entry_source: "kiosk" }), false);
  assert.equal(timesheetCountsAsApproved({ entry_source: "kiosk", review_status: "bogus" }), false);
  assert.equal(timesheetCountsAsApproved({ hours_logged: 2 }), true);
});

test("only an assigned Supervisor can review; approval counts hours, audits and recalculates", () => {
  const db = makeDb(); const st = store(); submitAs(db, st); const id = db.timesheets[0].id;
  assert.throws(() => review(db, st, "ops-1", id, { decision: "approve" }));
  assert.throws(() => review(db, st, "tech-1", id, { decision: "approve" }));
  assert.equal(review(db, st, "sup-2", id, { decision: "approve" }).statusCode, 403);
  const ok = review(db, st, "sup-1", id, { decision: "approve" });
  assert.equal(ok.statusCode, 200);
  assert.equal(db.timesheets[0].review_status, "approved");
  assert.equal(db.timesheets[0].reviewed_by, "sup-1");
  assert.equal(approvedLabourValue(db, ["d1"]), 8 * 45);
  assert.ok(st.calls.includes("KIOSK_TIMESHEET_APPROVED") && st.calls.includes("variance"));
});

test("reject needs a comment, rejected rows never count, decisions are terminal", () => {
  const db = makeDb(); const st = store(); submitAs(db, st); const id = db.timesheets[0].id;
  assert.equal(review(db, st, "sup-1", id, { decision: "reject" }).statusCode, 400);
  assert.equal(review(db, st, "sup-1", id, { decision: "reject", comment: "  " }).statusCode, 400);
  assert.equal(review(db, st, "sup-1", id, { decision: "reject", comment: "Wrong day" }).statusCode, 200);
  assert.equal(approvedLabourValue(db, ["d1"]), 0);
  assert.equal(review(db, st, "sup-1", id, { decision: "approve" }).statusCode, 409);
});

test("separation of duties: a Supervisor cannot review their own time or entry they recorded", () => {
  const db = makeDb(); const st = store();
  db.timesheets.push({ id: "t-own", dispatch_card_id: "d1", technician_id: "sup-1", recorded_by_user_id: "ops-1", entry_source: "kiosk", hours_logged: 4 });
  db.timesheets.push({ id: "t-rec", dispatch_card_id: "d1", technician_id: "tech-1", recorded_by_user_id: "sup-1", entry_source: "kiosk", hours_logged: 4 });
  assert.equal(review(db, st, "sup-1", "t-own", { decision: "approve" }).statusCode, 403);
  assert.equal(review(db, st, "sup-1", "t-rec", { decision: "approve" }).statusCode, 403);
});

test("non-kiosk entries cannot be reviewed here and invoiced dispatches are frozen", () => {
  const db = makeDb(); const st = store();
  db.timesheets.push({ id: "t-direct", dispatch_card_id: "d1", technician_id: "tech-1", hours_logged: 2 });
  assert.equal(review(db, st, "sup-1", "t-direct", { decision: "approve" }).statusCode, 400);
  submitAs(db, st); const id = db.timesheets[1].id;
  db.invoices.push({ id: "inv-1", dispatch_card_id: "d1", status: "Generated", purchase_order_id: "po-1" });
  const res = review(db, st, "sup-1", id, { decision: "approve" });
  assert.ok([409, 400].includes(res.statusCode), `got ${res.statusCode}`);
});

test("review queue and dispatch timesheet reads never expose a rate; Technician sees own entries only", () => {
  const db = makeDb(); const st = store(); submitAs(db, st);
  db.timesheets.push({ id: "t-other", dispatch_card_id: "d1", technician_id: "tech-2", entry_source: "kiosk", hours_logged: 3, hourly_rate: 99 });
  const q = response(); listKioskReviewQueue(req(db, st, "sup-1"), q);
  assert.equal(q.statusCode, 200); assert.equal(q.body.data.length, 2);
  assert.ok(q.body.data.every((row) => !("hourly_rate" in row)));
  assert.equal(q.body.data.find((row) => row.id === db.timesheets[0].id).can_review, true);
  const noSup = response(); listKioskReviewQueue(req(db, st, "sup-2"), noSup); assert.equal(noSup.body.data.length, 0);
  const adminRead = response(); listKioskReviewQueue(req(db, st, "ops-1"), adminRead);
  assert.ok(adminRead.body.data.every((row) => row.can_review === false));
  assert.throws(() => listKioskReviewQueue(req(db, st, "tech-1"), response()));
  const mine = response(); listDispatchTimesheets(req(db, st, "tech-1", { params: { id: "d1" } }), mine);
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.body.data.map((row) => row.technician_id), ["tech-1"]);
  assert.ok(mine.body.data.every((row) => !("hourly_rate" in row)));
  const bad = response(); listKioskReviewQueue(req(db, st, "sup-1", { query: { status: "nope" } }), bad); assert.equal(bad.statusCode, 400);
});

test("Pastel export labor_hours counts only approved kiosk rows", () => {
  const db = makeDb();
  db.clients = [{ id: "c1", name: "Client" }]; db.quotes = [{ id: "q1", client_id: "c1" }];
  db.purchase_orders = [{ id: "po-1", quotation_id: "q1", po_reference: "PO1" }]; db.equipment_tags = []; db.material_usage = [];
  db.invoices = [{ id: "inv-1", invoice_number: "INV-1", purchase_order_id: "po-1", dispatch_card_id: "d1", total_amount: 100, generated_at: "2026-09-22" }];
  db.invoice_lines = [{ invoice_id: "inv-1", description: "Labour" }];
  db.timesheets = [
    { id: "a", dispatch_card_id: "d1", hours_logged: 2 },
    { id: "b", dispatch_card_id: "d1", entry_source: "kiosk", review_status: "approved", hours_logged: 8 },
    { id: "c", dispatch_card_id: "d1", entry_source: "kiosk", review_status: "pending_review", hours_logged: 5 },
    { id: "d", dispatch_card_id: "d1", entry_source: "kiosk", review_status: "rejected", hours_logged: 7 }
  ];
  const row = exportInvoicesCsv(db).split("\n")[1].split(",");
  assert.equal(row[9], "10");
});
