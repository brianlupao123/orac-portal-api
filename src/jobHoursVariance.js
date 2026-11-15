// Lane 2, FB2: read-only comparison of "Actual field hours" and "Billable hours" for a dispatch card.
//
// Pure reporting logic. It never writes to the database, never reads a rate or an amount,
// never consults a feature flag, a tolerance, an override or a policy, and creates no record.
// It is information only: it does not gate, block or change an invoice.
//
//   Actual field hours  src/jobActuals.js (eligible, non-superseded version-2 field worksheets).
//   Billable hours      Supervisor-approved, non-voided kiosk rows in `timesheets`.
//
// The two are returned side by side and never merged into one total. Rows that are not
// Billable hours (pending, rejected, voided, and non-kiosk rows) are reported separately so a
// difference can be explained. Totals only are compared: kiosk overtime keys (ot_1_5, ot_2_0)
// differ from the canonical keys (ot_15, ot_20) and the kiosk breakdown is evidence only.
import { jobActuals } from "./jobActuals.js";
import { KIOSK_REVIEW_STATUS, isKioskEntry, kioskReviewStatus } from "./timesheetReview.js";

export const HOURS_LABELS = Object.freeze({ actual: "Actual field hours", billable: "Billable hours" });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const bucket = () => ({ count: 0, hours: 0, row_ids: [] });
function add(target, row) {
  target.count += 1;
  target.hours = r2(target.hours + r2(row.hours_logged));
  target.row_ids.push(row.id);
}

export function jobHoursVariance(db, dispatchId) {
  const actual = jobActuals(db, dispatchId);
  const billable = { total: 0, row_ids: [] };
  const pending = bucket();
  const rejected = bucket();
  const voided = bucket();
  const other = bucket();

  if (db && dispatchId) {
    for (const row of db.timesheets || []) {
      if (row.dispatch_card_id !== dispatchId) continue;
      if (row.voided_at) { add(voided, row); continue; }
      if (!isKioskEntry(row)) { add(other, row); continue; }
      const status = kioskReviewStatus(row);
      if (status === KIOSK_REVIEW_STATUS.APPROVED) { billable.row_ids.push(row.id); billable.total = r2(billable.total + r2(row.hours_logged)); }
      else if (status === KIOSK_REVIEW_STATUS.REJECTED) add(rejected, row);
      else add(pending, row);
    }
  }
  for (const b of [pending, rejected, voided, other]) b.row_ids.sort();
  billable.row_ids.sort();

  const difference = r2(billable.total - actual.total);
  return {
    dispatch_card_id: dispatchId || null,
    actual_field_hours: {
      label: HOURS_LABELS.actual,
      total: actual.total, normal: actual.normal, ot_15: actual.ot_15, ot_20: actual.ot_20,
      worksheet_ids: [...actual.ids].sort()
    },
    billable_hours: {
      label: HOURS_LABELS.billable,
      basis: "Supervisor-approved, non-voided kiosk rows",
      total: billable.total,
      row_ids: billable.row_ids
    },
    not_billable_kiosk_rows: { pending_review: pending, rejected },
    voided_rows: voided,
    other_billing_rows: other,
    comparison: {
      basis: "totals only; the two measures are never added together",
      billable_minus_actual_hours: difference,
      direction: difference > 0 ? "billable_exceeds_actual" : difference < 0 ? "actual_exceeds_billable" : "equal"
    }
  };
}

export function jobHoursVarianceForDispatches(db, dispatchIds) {
  return [...new Set(dispatchIds || [])].map((id) => jobHoursVariance(db, id));
}
