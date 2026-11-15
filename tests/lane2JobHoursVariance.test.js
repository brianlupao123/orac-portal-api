// Lane 2, FB2 (test-only for the new read-only module src/jobHoursVariance.js).
// Proves: two separate labelled measures; billable = approved, non-voided kiosk rows;
// pending, rejected, voided and non-kiosk rows reported separately; no rate or amount read
// or returned; no mutation; no dependence on flags; no new keys on any record.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { jobHoursVariance, jobHoursVarianceForDispatches, HOURS_LABELS } from "../src/jobHoursVariance.js";
import { jobActuals } from "../src/jobActuals.js";
import { countedTimesheets } from "../src/timesheetReview.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";

let saved;
before(() => {
  saved = {};
  for (const key of Object.keys(process.env)) if (key.startsWith("TIMESHEET_")) { saved[key] = process.env[key]; delete process.env[key]; }
});
after(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("TIMESHEET_")) delete process.env[key];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
});

const D1 = "d1";
const bd = (normal, ot_15 = 0, ot_20 = 0) => ({ normal, ot_15, ot_20 });
const ws = (id, over = {}) => ({ id, dispatch_card_id: D1, timesheet_version: 2, status: "Supervisor_Approved", technician_id: `t_${id}`, work_date: "2026-10-05", hours: 0, hours_breakdown: bd(0), ...over });
const kiosk = (id, hours, review_status, over = {}) => ({ id, dispatch_card_id: D1, entry_source: "kiosk", technician_id: "u_t1", work_date: "2026-10-05", hours_logged: hours, review_status, ...over });

function world() {
  return {
    users: [{ id: "u_ops", role: "Operations", name: "Ops", is_active: true }, { id: "u_t1", role: "Technician", name: "Tech", is_active: true }],
    dispatch_cards: [{ id: D1, assigned_technician_ids: ["u_t1"] }, { id: "d2", assigned_technician_ids: [] }],
    field_worksheets: [
      ws("ws_a", { hours: 3, hours_breakdown: bd(3) }),
      ws("ws_orig", { hours: 5, hours_breakdown: bd(5), superseded_by: "ws_rev" }),
      ws("ws_rev", { hours: 4, hours_breakdown: bd(2, 2) }),
      ws("ws_draft", { status: "Draft", hours: 9, hours_breakdown: bd(9) }),
      ws("ws_other", { dispatch_card_id: "d2", hours: 50, hours_breakdown: bd(50) })
    ],
    timesheets: [
      kiosk("k_ok", 2, "approved"),
      kiosk("k_pending", 1, "pending_review"),
      kiosk("k_rejected", 3, "rejected"),
      kiosk("k_void", 6, "approved", { voided_at: "2026-10-06T00:00:00Z" }),
      kiosk("k_other_dispatch", 40, "approved", { dispatch_card_id: "d2" }),
      { id: "manual1", dispatch_card_id: D1, technician_id: "u_t1", work_date: "2026-10-05", hours_logged: 7 }
    ],
    daily_timesheets: [{ id: "dts1", status: "Supervisor_Approved", rows: [{ normal_hours: 100 }] }],
    worksheet_registers: [{ id: "reg1", status: "Approved", lines: [{ normal: 100 }] }],
    audit_logs: []
  };
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
function keysDeep(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  return out;
}

test("returns Actual field hours and Billable hours as two separately labelled measures, never merged", () => {
  const r = jobHoursVariance(world(), D1);
  assert.equal(r.actual_field_hours.label, "Actual field hours");
  assert.equal(r.billable_hours.label, "Billable hours");
  assert.deepEqual(HOURS_LABELS, { actual: "Actual field hours", billable: "Billable hours" });
  assert.equal("total" in r, false, "no top-level combined total");
  assert.equal(Object.keys(r.comparison).includes("total"), false);
});

test("Actual field hours come from src/jobActuals.js: eligible, non-superseded v2 worksheets only (3 + 4 = 7)", () => {
  const db = world();
  const r = jobHoursVariance(db, D1);
  const direct = jobActuals(db, D1);
  assert.equal(r.actual_field_hours.total, 7);
  assert.equal(r.actual_field_hours.total, direct.total);
  assert.deepEqual([r.actual_field_hours.normal, r.actual_field_hours.ot_15, r.actual_field_hours.ot_20], [direct.normal, direct.ot_15, direct.ot_20]);
  assert.deepEqual(r.actual_field_hours.worksheet_ids, ["ws_a", "ws_rev"]);
});

test("Billable hours are approved, non-voided kiosk rows for the dispatch only (2)", () => {
  const r = jobHoursVariance(world(), D1);
  assert.equal(r.billable_hours.total, 2);
  assert.deepEqual(r.billable_hours.row_ids, ["k_ok"]);
});

test("pending, rejected, voided and non-kiosk rows are reported separately and never added to Billable hours", () => {
  const r = jobHoursVariance(world(), D1);
  assert.deepEqual(r.not_billable_kiosk_rows.pending_review, { count: 1, hours: 1, row_ids: ["k_pending"] });
  assert.deepEqual(r.not_billable_kiosk_rows.rejected, { count: 1, hours: 3, row_ids: ["k_rejected"] });
  assert.deepEqual(r.voided_rows, { count: 1, hours: 6, row_ids: ["k_void"] });
  assert.deepEqual(r.other_billing_rows, { count: 1, hours: 7, row_ids: ["manual1"] });
  assert.equal(r.billable_hours.total, 2);
});

test("a kiosk row with no or an unknown review status is treated as pending (fail closed), not billable", () => {
  const db = world();
  db.timesheets.push(kiosk("k_blank", 4, undefined), kiosk("k_odd", 5, "mystery"));
  const r = jobHoursVariance(db, D1);
  assert.equal(r.billable_hours.total, 2);
  assert.deepEqual(r.not_billable_kiosk_rows.pending_review.row_ids, ["k_blank", "k_odd", "k_pending"]);
});

test("daily timesheets and worksheet registers are never added to either measure", () => {
  const withExtras = jobHoursVariance(world(), D1);
  const db = world(); db.daily_timesheets = []; db.worksheet_registers = [];
  assert.deepEqual(jobHoursVariance(db, D1), withExtras);
});

test("comparison reports totals only, with direction (actual 7 vs billable 2)", () => {
  const r = jobHoursVariance(world(), D1);
  assert.equal(r.comparison.billable_minus_actual_hours, -5);
  assert.equal(r.comparison.direction, "actual_exceeds_billable");
});

test("comparison direction: billable exceeds actual, and equal", () => {
  const over = world(); over.timesheets.push(kiosk("k_big", 20, "approved"));
  const a = jobHoursVariance(over, D1);
  assert.equal(a.comparison.billable_minus_actual_hours, 15);
  assert.equal(a.comparison.direction, "billable_exceeds_actual");
  const eq = world(); eq.timesheets.push(kiosk("k_five", 5, "approved"));
  const b = jobHoursVariance(eq, D1);
  assert.equal(b.comparison.billable_minus_actual_hours, 0);
  assert.equal(b.comparison.direction, "equal");
});

test("hours are rounded to two decimals", () => {
  const db = world(); db.timesheets.push(kiosk("k_frac1", 0.1, "approved"), kiosk("k_frac2", 0.2, "approved"));
  assert.equal(jobHoursVariance(db, D1).billable_hours.total, 2.3);
});

test("rate-blind: no rate is read and no rate, amount, cost, price, VAT or currency key is returned", () => {
  const db = world();
  for (const row of db.timesheets) {
    Object.defineProperty(row, "hourly_rate", { get() { throw new Error("hourly_rate must not be read"); }, enumerable: true });
    Object.defineProperty(row, "amount", { get() { throw new Error("amount must not be read"); }, enumerable: true });
  }
  const r = jobHoursVariance(db, D1);
  const banned = /rate|amount|cost|price|vat|money|value|usd|currency|total_amount/i;
  for (const key of keysDeep(r)) assert.equal(banned.test(key), false, `unexpected key ${key}`);
});

test("read-only: a deeply frozen database is accepted and no record gains or changes a field", () => {
  const db = deepFreeze(world());
  const before = JSON.stringify(db);
  jobHoursVariance(db, D1); jobHoursVarianceForDispatches(db, [D1, "d2"]);
  assert.equal(JSON.stringify(db), before);
});

test("does not depend on timesheet flags: the invoice variance flag does not change the report", () => {
  const baseline = jobHoursVariance(world(), D1);
  process.env.TIMESHEET_INVOICE_VARIANCE = "enabled";
  try { assert.deepEqual(jobHoursVariance(world(), D1), baseline); } finally { delete process.env.TIMESHEET_INVOICE_VARIANCE; }
});

test("unknown dispatch, missing collections and a missing database give zeros, not errors", () => {
  const zero = (r) => [r.actual_field_hours.total, r.billable_hours.total, r.comparison.billable_minus_actual_hours];
  assert.deepEqual(zero(jobHoursVariance(world(), "nope")), [0, 0, 0]);
  assert.deepEqual(zero(jobHoursVariance({}, D1)), [0, 0, 0]);
  assert.deepEqual(zero(jobHoursVariance(null, D1)), [0, 0, 0]);
  assert.deepEqual(zero(jobHoursVariance(world(), undefined)), [0, 0, 0]);
});

test("per-dispatch results do not leak rows from another dispatch; duplicates in the id list are collapsed", () => {
  const db = world();
  const list = jobHoursVarianceForDispatches(db, [D1, "d2", D1]);
  assert.equal(list.length, 2);
  assert.equal(list[0].dispatch_card_id, D1);
  assert.equal(list[1].dispatch_card_id, "d2");
  assert.equal(list[1].actual_field_hours.total, 50);
  assert.equal(list[1].billable_hours.total, 40);
  assert.equal(list[0].billable_hours.total, 2);
});

test("CHARACTERIZATION: countedTimesheets (the 'counts as approved' rule) also keeps approved voided rows and non-kiosk rows; this report excludes voided rows and lists non-kiosk rows separately", () => {
  const db = world();
  const counted = countedTimesheets(db, D1).map((t) => t.id).sort();
  assert.deepEqual(counted, ["k_ok", "k_void", "manual1"]);
  const r = jobHoursVariance(db, D1);
  assert.deepEqual(r.billable_hours.row_ids, ["k_ok"]);
  assert.deepEqual(r.voided_rows.row_ids, ["k_void"]);
  assert.deepEqual(r.other_billing_rows.row_ids, ["manual1"]);
});

test("a real kiosk submission is pending, so it is reported as not billable until a Supervisor approves it", () => {
  let n = 0;
  const db = world(); db.timesheets = [];
  db.clients = [{ id: "c1", name: "Client" }]; db.quotes = [{ id: "q1", client_id: "c1" }];
  db.dispatch_cards[0].quotation_id = "q1"; db.dispatch_cards[0].status = "In_Progress";
  const store = { id: (p) => `${p}_${++n}`, audit() {}, recalculateVariance() {} };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  submitKioskTimesheets({ user: { id: "u_ops" }, db, store, params: { id: D1 }, query: {}, body: { work_date: "2026-10-05", entries: [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10 }] } }, res);
  assert.equal(res.statusCode, 200);
  const r = jobHoursVariance(db, D1);
  assert.equal(r.billable_hours.total, 0);
  assert.equal(r.not_billable_kiosk_rows.pending_review.hours, 8);
  db.timesheets[0].review_status = "approved";          // simulates the Supervisor decision
  assert.equal(jobHoursVariance(db, D1).billable_hours.total, 8);
});
