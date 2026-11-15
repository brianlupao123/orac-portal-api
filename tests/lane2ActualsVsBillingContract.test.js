// Lane 2, Batch 1 (test-only): "Actual field hours" vs "Billable hours" contract.
//
// Characterization tests. They describe what the current code does and pin the
// separation the programme requires. They change no production file and enable
// no flag: every timesheet flag is forced to its shipped default (unset).
//
// Pure: no store, no state machine. The real-store invoice proof is in
// lane2ActualsVsBillingInvoice.test.js.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { eligibleHours, billedHours, computeVariance, invoiceVarianceGate } from "../src/timesheetWorkflow.js";
import { evaluateEligibility, INELIGIBLE } from "../src/timesheetEligibility.js";
import { submitKioskTimesheets } from "../src/controllers/kioskController.js";
import { KIOSK_REVIEW_STATUS } from "../src/timesheetReview.js";
import { jobActuals } from "../src/jobActuals.js";
import {
  LABELS, actualFieldHours, referenceActualFieldHours, billableHours, hoursContract, kioskToCanonicalBreakdown, snapshot, withFlagsUnset
} from "./helpers/lane2HoursContract.js";

let restoreFlags;
before(() => { restoreFlags = withFlagsUnset(); });
after(() => { restoreFlags?.(); });

const D1 = "d1"; const D2 = "d2";
const bd = (normal, ot_15 = 0, ot_20 = 0) => ({ normal, ot_15, ot_20 });
const v2 = (id, over = {}) => ({ id, dispatch_card_id: D1, timesheet_version: 2, status: "Supervisor_Approved", technician_id: `t_${id}`, work_date: "2026-09-21", hours: 0, hours_breakdown: bd(0), ...over });

function world() {
  const db = {
    users: [
      { id: "u_ops", role: "Operations", name: "Ops", is_active: true },
      { id: "u_t1", role: "Technician", name: "Tech One", is_active: true },
      { id: "u_t2", role: "Technician", name: "Tech Two", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }],
    quotes: [{ id: "q1", client_id: "c1" }],
    dispatch_cards: [
      { id: D1, quotation_id: "q1", dispatch_number: "D-1", status: "In_Progress", assigned_technician_ids: ["u_t1", "u_t2"] },
      { id: D2, quotation_id: "q1", dispatch_number: "D-2", status: "In_Progress", assigned_technician_ids: [] }
    ],
    field_worksheets: [
      v2("ws_ok1", { hours: 8, hours_breakdown: bd(6, 2, 0) }),
      v2("ws_ok2", { hours: 4, hours_breakdown: bd(4) }),
      v2("ws_orig", { hours: 8, hours_breakdown: bd(8), superseded_by: "ws_rev" }),   // superseded original
      v2("ws_rev", { hours: 7, hours_breakdown: bd(7) }),                              // its approved revision
      v2("ws_draft", { status: "Draft", hours: 5, hours_breakdown: bd(5) }),
      v2("ws_submitted", { status: "Submitted", hours: 5, hours_breakdown: bd(5) }),
      v2("ws_ack", { status: "Client_Acknowledged", hours: 3, hours_breakdown: bd(3) }),
      v2("ws_returned", { status: "Returned", hours: 3, hours_breakdown: bd(3) }),
      v2("ws_other_dispatch", { dispatch_card_id: D2, hours: 100, hours_breakdown: bd(100) }),
      // Historical approved record: not version 2, hours only, no breakdown.
      { id: "ws_legacy", dispatch_card_id: D1, status: "Supervisor_Approved", technician_id: "t_legacy", work_date: "2026-09-20", hours: 2 }
    ],
    timesheets: [], daily_timesheets: [], worksheet_registers: [], audit_logs: []
  };
  return db;
}

function response() { return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function fakeStore() {
  let n = 0;
  return { id: (prefix) => `${prefix}_${++n}`, audit() {}, recalculateVariance() {} };
}
function kioskSubmit(db, entries, work_date = "2026-09-22") {
  const res = response();
  submitKioskTimesheets({ user: { id: "u_ops" }, db, store: fakeStore(), params: { id: D1 }, query: {}, body: { work_date, entries } }, res);
  return res;
}

// ---- 1. Actual field hours -----------------------------------------------------------
test("src/jobActuals.js returns { total, normal, ot_15, ot_20, ids } for eligible, non-superseded version-2 worksheets", () => {
  const r = jobActuals(world(), D1);
  assert.equal(r.total, 19);
  assert.equal(r.normal, 17);
  assert.equal(r.ot_15, 2);
  assert.equal(r.ot_20, 0);
  assert.deepEqual([...r.ids].sort(), ["ws_ok1", "ws_ok2", "ws_rev"]);
});

test("src/jobActuals.js agrees with the independent reference computation", () => {
  const real = actualFieldHours(world(), D1);
  const ref = referenceActualFieldHours(world(), D1);
  for (const key of ["total", "normal", "ot_15", "ot_20", "worksheet_ids"]) assert.deepEqual(real[key], ref[key], key);
});

test("src/jobActuals.js for a dispatch with no worksheets returns zeros and no ids", () => {
  const r = jobActuals(world(), "d_unknown");
  assert.deepEqual([r.total, r.normal, r.ot_15, r.ot_20], [0, 0, 0, 0]);
  assert.deepEqual([...r.ids], []);
});

test("src/jobActuals.js and a superseded-only dispatch: a superseded original with no revision yet counts nothing", () => {
  const db = world();
  db.field_worksheets = [v2("only_orig", { hours: 6, hours_breakdown: bd(6), superseded_by: "missing_rev" })];
  assert.equal(jobActuals(db, D1).total, 0);
});

test("Actual field hours = eligible, non-superseded version-2 field worksheets for the dispatch, and nothing else", () => {
  const a = actualFieldHours(world(), D1);
  assert.equal(a.label, "Actual field hours");
  assert.deepEqual(a.worksheet_ids, ["ws_ok1", "ws_ok2", "ws_rev"]);
  assert.equal(a.total, 19);
  assert.deepEqual([a.normal, a.ot_15, a.ot_20], [17, 2, 0]);
});

test("Actual field hours excludes draft / submitted / client-acknowledged / returned sheets, other dispatches, superseded originals and non-v2 history", () => {
  const a = actualFieldHours(world(), D1);
  for (const excluded of ["ws_draft", "ws_submitted", "ws_ack", "ws_returned", "ws_other_dispatch", "ws_orig", "ws_legacy"]) {
    assert.equal(a.worksheet_ids.includes(excluded), false, `${excluded} must not count`);
  }
});

test("CHARACTERIZATION (gap L2-F02): eligibleHours also counts the superseded original and the non-v2 legacy record", () => {
  const e = eligibleHours(world(), D1);
  assert.deepEqual([...e.ids].sort(), ["ws_legacy", "ws_ok1", "ws_ok2", "ws_orig", "ws_rev"]);
  assert.equal(e.total, 29);                       // 19 actual + 8 superseded + 2 legacy
  assert.notEqual(e.total, actualFieldHours(world(), D1).total);
  // Antigravity confirmed eligibleHours still lacks the superseded check: src/jobActuals.js, not eligibleHours, is the single source for Actual field hours.
});

test("CHARACTERIZATION: the shared predicate ignores superseded_by with the cutover flag off, and refuses it with the flag on", () => {
  const sheet = { id: "x", status: "Supervisor_Approved", superseded_by: "y" };
  assert.equal(evaluateEligibility(sheet, { cutoverEnabled: false }).eligible, true);
  const on = evaluateEligibility(sheet, { cutoverEnabled: true });
  assert.equal(on.eligible, false);
  assert.equal(on.reason, INELIGIBLE.SUPERSEDED);
});

// ---- 2. Other stores are not silently added -------------------------------------------
test("Daily timesheets and worksheet registers are never added to Actual field hours", () => {
  const base = world();
  const withExtras = world();
  withExtras.daily_timesheets.push({ id: "dts1", status: "Supervisor_Approved", worker_name: "Test Worker", rows: [{ date: "2026-09-21", normal_hours: 8, ot_15: 2, ot_20: 1 }] });
  withExtras.worksheet_registers.push({ id: "wks1", status: "Approved", lines: [{ roster_key: "t_ws_ok1", date: "2026-09-21", normal: 100, ot_15: 50, ot_20: 25 }] });
  assert.deepEqual(actualFieldHours(withExtras, D1), actualFieldHours(base, D1));
  assert.deepEqual(eligibleHours(withExtras, D1), eligibleHours(base, D1));
});

test("Kiosk / billing rows are never added to Actual field hours", () => {
  const base = world();
  const withKiosk = world();
  assert.equal(kioskSubmit(withKiosk, [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10 }]).statusCode, 200);
  assert.equal(withKiosk.timesheets.length, 1);
  assert.deepEqual(actualFieldHours(withKiosk, D1), actualFieldHours(base, D1));
  assert.deepEqual(eligibleHours(withKiosk, D1), eligibleHours(base, D1));
});

// ---- 3. Billable hours: pending blocks / rejected excluded (calculation level) --------
test("Billable hours: a pending kiosk row is not billable; a rejected kiosk row is not billable", () => {
  const db = world();
  assert.equal(kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 2, hourly_rate: 10 }, { technician_id: "u_t2", hours_logged: 3, hourly_rate: 10 }]).statusCode, 200);
  assert.ok(db.timesheets.every((t) => t.review_status === KIOSK_REVIEW_STATUS.PENDING));
  assert.equal(billableHours(db, D1).total, 0);

  db.timesheets[1].review_status = KIOSK_REVIEW_STATUS.REJECTED;
  assert.equal(billableHours(db, D1).total, 0);
  assert.deepEqual(billableHours(db, D1).row_ids, []);
});

test("CHARACTERIZATION (gap L2-F04): billedHours, the variance helper, counts every non-voided row regardless of review status, so it is not 'Billable hours'", () => {
  const db = world();
  kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 2, hourly_rate: 10 }, { technician_id: "u_t2", hours_logged: 3, hourly_rate: 10 }]);
  db.timesheets[1].review_status = KIOSK_REVIEW_STATUS.REJECTED;
  assert.equal(billedHours(db, D1).total, 5);            // pending 2 + rejected 3
  assert.equal(billableHours(db, D1).total, 0);          // neither bills
  db.timesheets[0].voided_at = "2026-09-23T00:00:00Z";
  assert.equal(billedHours(db, D1).total, 3);            // voided rows are the only ones dropped
});

test("CHARACTERIZATION: the variance gate is dark, so actual-vs-billed disagreement is not enforced with the flag unset", () => {
  const db = world();
  kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 20, hourly_rate: 10 }]);
  const variance = computeVariance(db, D1);              // pure calculation, available even when the gate is dark
  assert.equal(variance.billed.total, 20);
  assert.equal(variance.eligible.total, 29);
  assert.deepEqual(invoiceVarianceGate(db, D1), { allow: true, skipped: true });
});

// ---- 4. Two distinct concepts ---------------------------------------------------------
test("hoursContract returns Actual field hours and Billable hours as separate, labelled values that are never merged", () => {
  const db = world();
  kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 6, hourly_rate: 10 }]);
  const c = hoursContract(db, D1);
  assert.deepEqual(Object.keys(c).sort(), ["actual_field_hours", "billable_hours", "dispatch_card_id"]);
  assert.equal(c.actual_field_hours.label, LABELS.actual);
  assert.equal(c.billable_hours.label, LABELS.billable);
  assert.equal(c.actual_field_hours.total, 19);
  assert.equal(c.billable_hours.total, 0);               // the 6h kiosk row is still pending
  assert.equal("total" in c, false, "no combined total exists");
  assert.notEqual(c.actual_field_hours.source, c.billable_hours.source);
});

test("Billable hours counts non-kiosk billing rows as unclassified, never into the total (their invoice treatment is not shown in the packet)", () => {
  const db = world();
  db.timesheets.push({ id: "manual1", dispatch_card_id: D1, technician_id: "u_t1", work_date: "2026-09-22", hours_logged: 9, hourly_rate: 10 });
  const b = billableHours(db, D1);
  assert.equal(b.total, 0);
  assert.equal(b.unclassified_non_kiosk_rows, 1);
});

// ---- 5. Kiosk overtime keys -----------------------------------------------------------
test("Kiosk stores overtime as ot_1_5 / ot_2_0, not the canonical ot_15 / ot_20", () => {
  const db = world();
  const res = kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10, hours_breakdown: { normal: 5, ot_1_5: 2, ot_2_0: 1 } }]);
  assert.equal(res.statusCode, 200);
  const stored = db.timesheets[0].hours_breakdown;
  assert.deepEqual(Object.keys(stored).sort(), ["normal", "ot_1_5", "ot_2_0"]);
  assert.equal("ot_15" in stored, false);
  assert.equal("ot_20" in stored, false);
});

test("Explicit mapping: kiosk normal / ot_1_5 / ot_2_0 mean canonical normal / ot_15 / ot_20, and unknown keys are reported not dropped", () => {
  const { canonical, unmapped } = kioskToCanonicalBreakdown({ normal: 5, ot_1_5: 2, ot_2_0: 1 });
  assert.deepEqual(canonical, { normal: 5, ot_15: 2, ot_20: 1 });
  assert.deepEqual(unmapped, []);
  const wrong = kioskToCanonicalBreakdown({ normal: 5, overtime_1_5: 2, overtime_2_0: 1, overtime_hours: 3 });
  assert.deepEqual(wrong.canonical, { normal: 5, ot_15: 0, ot_20: 0 });
  assert.deepEqual(wrong.unmapped.sort(), ["overtime_1_5", "overtime_2_0", "overtime_hours"]);
});

test("CHARACTERIZATION: a kiosk row is never 'classed' by billedHours until its keys are mapped; mapped, the classes line up with eligibleHours", () => {
  const db = world();
  kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10, hours_breakdown: { normal: 5, ot_1_5: 2, ot_2_0: 1 } }]);
  const raw = billedHours(db, D1);
  assert.equal(raw.classed, false);
  assert.deepEqual([raw.total, raw.normal, raw.ot_15, raw.ot_20], [8, 0, 0, 0]);

  const mapped = world();
  kioskSubmit(mapped, [{ technician_id: "u_t1", hours_logged: 8, hourly_rate: 10, hours_breakdown: { normal: 5, ot_1_5: 2, ot_2_0: 1 } }]);
  mapped.timesheets[0].hours_breakdown = kioskToCanonicalBreakdown(mapped.timesheets[0].hours_breakdown).canonical;   // test copy only
  const after = billedHours(mapped, D1);
  assert.equal(after.classed, true);
  assert.deepEqual([after.total, after.normal, after.ot_15, after.ot_20], [8, 5, 2, 1]);
});

// ---- 6. No mutation -------------------------------------------------------------------
test("Calculation and reporting paths do not mutate any source record", () => {
  const db = world();
  kioskSubmit(db, [{ technician_id: "u_t1", hours_logged: 6, hourly_rate: 10, hours_breakdown: { normal: 4, ot_1_5: 1, ot_2_0: 1 } }]);
  db.daily_timesheets.push({ id: "dts1", status: "Supervisor_Approved", rows: [{ normal_hours: 8 }] });
  db.worksheet_registers.push({ id: "wks1", status: "Approved", lines: [] });
  const before = snapshot(db);
  eligibleHours(db, D1); billedHours(db, D1); computeVariance(db, D1); invoiceVarianceGate(db, D1);
  actualFieldHours(db, D1); billableHours(db, D1); hoursContract(db, D1); kioskToCanonicalBreakdown(db.timesheets[0].hours_breakdown);
  evaluateEligibility(db.field_worksheets[0], { cutoverEnabled: false });
  assert.equal(snapshot(db), before);
});
