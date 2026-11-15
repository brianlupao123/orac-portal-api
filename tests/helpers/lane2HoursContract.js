// TEST-ONLY helpers for the Lane 2 "actual field hours vs billable hours" contract.
//
// These are NOT production helpers. They are a reference oracle that states, in
// executable form, the two separate concepts the platform must keep apart:
//
//   "Actual field hours"  eligible, non-superseded version-2 field_worksheets
//                         linked to the dispatch by dispatch_card_id.
//   "Billable hours"      Supervisor-approved, non-voided kiosk rows in `timesheets`
//                         (what the legacy invoice path bills today).
//
// Lane 1 owns the production `jobActuals` helper (src/jobActuals.js, verified by
// Antigravity at backend commit 948e851: jobActuals(db, dispatchId) returns
// { total, normal, ot_15, ot_20, ids }). `actualFieldHours` below delegates to it, so
// the contract tests exercise the real helper. `referenceActualFieldHours` is an
// independent test-only computation used to cross-check the helper.
// Billable hours has no production helper; `billableHours` stays a test-only oracle.
// Nothing here writes to a record: every function only reads `db`.
import { evaluateForDb, FLAG_ELIGIBILITY_CUTOVER, FLAG_CLIENT_RETURN } from "../../src/timesheetEligibility.js";
import { jobActuals } from "../../src/jobActuals.js";
import { FLAGS } from "../../src/timesheetWorkflow.js";
import { isTimesheetV2 } from "../../src/timesheetModel.js";
import { KIOSK_REVIEW_STATUS, isKioskEntry, kioskReviewStatus } from "../../src/timesheetReview.js";

export const LABELS = Object.freeze({ actual: "Actual field hours", billable: "Billable hours" });
export const CLASSES = Object.freeze(["normal", "ot_15", "ot_20"]);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---- environment: keep every timesheet flag at its shipped default (unset) ----------
const FLAG_NAMES = [...Object.values(FLAGS), FLAG_ELIGIBILITY_CUTOVER, FLAG_CLIENT_RETURN];
export function withFlagsUnset() {
  const saved = {};
  for (const name of FLAG_NAMES) { saved[name] = process.env[name]; delete process.env[name]; }
  return () => { for (const name of FLAG_NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } };
}

// ---- concept 1: Actual field hours ---------------------------------------------------
export function actualFieldHours(db, dispatchId) {
  const r = jobActuals(db, dispatchId);
  return {
    label: LABELS.actual, source: "field_worksheets (version 2, eligible, not superseded) via src/jobActuals.js",
    total: r.total, normal: r.normal, ot_15: r.ot_15, ot_20: r.ot_20, worksheet_ids: [...r.ids].sort()
  };
}

// Independent reference computation (test-only). Must agree with jobActuals.
export function referenceActualFieldHours(db, dispatchId) {
  const out = { label: LABELS.actual, source: "reference oracle", total: 0, normal: 0, ot_15: 0, ot_20: 0, worksheet_ids: [] };
  for (const ws of db.field_worksheets || []) {
    if (ws.dispatch_card_id !== dispatchId) continue;
    if (ws.superseded_by) continue;
    if (!isTimesheetV2(ws)) continue;
    if (!evaluateForDb(db, ws).eligible) continue;
    out.worksheet_ids.push(ws.id);
    out.total = r2(out.total + r2(ws.hours || 0));
    for (const c of CLASSES) out[c] = r2(out[c] + r2(ws.hours_breakdown?.[c] || 0));
  }
  out.worksheet_ids.sort();
  return out;
}

// ---- concept 2: Billable hours -------------------------------------------------------
// A kiosk row bills only once a Supervisor has approved it: pending and rejected rows
// do not. Rows that are not kiosk entries are NOT classified here (the invoice code
// that bills them is not in the review packet); they are counted, never summed.
export function isApprovedKioskRow(row) {
  const status = kioskReviewStatus(row);
  return status !== KIOSK_REVIEW_STATUS.PENDING && status !== KIOSK_REVIEW_STATUS.REJECTED;
}
export function billableHours(db, dispatchId) {
  const out = { label: LABELS.billable, source: "timesheets (kiosk rows approved by a Supervisor, not voided)", total: 0, row_ids: [], unclassified_non_kiosk_rows: 0 };
  for (const row of db.timesheets || []) {
    if (row.dispatch_card_id !== dispatchId || row.voided_at) continue;
    if (!isKioskEntry(row)) { out.unclassified_non_kiosk_rows += 1; continue; }
    if (!isApprovedKioskRow(row)) continue;
    out.row_ids.push(row.id);
    out.total = r2(out.total + r2(row.hours_logged || 0));
  }
  out.row_ids.sort();
  return out;
}

// The two concepts returned side by side, never merged into one number.
export function hoursContract(db, dispatchId) {
  return { dispatch_card_id: dispatchId, actual_field_hours: actualFieldHours(db, dispatchId), billable_hours: billableHours(db, dispatchId) };
}

// ---- kiosk overtime keys -> canonical keys -------------------------------------------
// Kiosk stores hours_breakdown as { normal, ot_1_5, ot_2_0 }. Every other hours store
// (field_worksheets, daily timesheets, registers, billedHours) uses { normal, ot_15, ot_20 }.
// The mapping is explicit and total: an unknown key is reported, never silently dropped.
export const KIOSK_TO_CANONICAL = Object.freeze({ normal: "normal", ot_1_5: "ot_15", ot_2_0: "ot_20" });
export function kioskToCanonicalBreakdown(breakdown) {
  const canonical = { normal: 0, ot_15: 0, ot_20: 0 };
  const unmapped = [];
  for (const [key, value] of Object.entries(breakdown || {})) {
    const target = KIOSK_TO_CANONICAL[key];
    if (target) canonical[target] = r2(canonical[target] + r2(value || 0)); else unmapped.push(key);
  }
  return { canonical, unmapped };
}

// ---- no-mutation evidence ------------------------------------------------------------
export const snapshot = (value) => JSON.stringify(value);
