// Pure logic for the Contractors Log Sheet feature: no db/req/res knowledge,
// mirrors dailyTimesheetValidation.js's split (see that file's header). The
// frontend keeps its own copy in frontend/src/lib/contractorLogLogic.js for
// the same reason.
//
// IMPORTANT — unconfirmed assumption carried from the visual prototype
// (orac-contractors-log-sheet.html), not a verified business rule:
//   Total Hours (per row) = Normal + 1.5 + 2.0
//   Total OT Hrs (per row) = 1.5 + 2.0
//   Total Hrs   (per row) = Normal + 1.5*(OT 1.5) + 2*(OT 2.0)   (weighted/payable hours)
// This should be checked against how stateMachine.js's createInvoice()
// actually prices labour (currently a flat hours_logged * hourly_rate, with
// no overtime multiplier at all) before this is relied on for billing. See
// the feature README's "Assumptions / unclear items" list.

function round2(n) {
  return Math.round(n * 100) / 100;
}

function num(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A row counts as "in use" if any hour cell or the worker name has been entered. */
export function isRowInUse(row) {
  if (!row) return false;
  return Boolean(
    String(row.worker_name || "").trim() ||
    row.normal !== undefined && row.normal !== null && row.normal !== "" ||
    row.ot_15 !== undefined && row.ot_15 !== null && row.ot_15 !== "" ||
    row.ot_20 !== undefined && row.ot_20 !== null && row.ot_20 !== ""
  );
}

/** Per-row derived totals. Returns null fields (not zero) for a row with no hours entered at all, matching the prototype's blank-cell behaviour. */
export function computeRowTotals(row) {
  const hasAnyHours = ["normal", "ot_15", "ot_20"].some((key) => row?.[key] !== undefined && row[key] !== null && row[key] !== "");
  if (!hasAnyHours) return { total_hours: null, total_ot_hours: null, total_payable_hours: null };
  const normal = num(row.normal);
  const ot15 = num(row.ot_15);
  const ot20 = num(row.ot_20);
  return {
    total_hours: round2(normal + ot15 + ot20),
    total_ot_hours: round2(ot15 + ot20),
    total_payable_hours: round2(normal + 1.5 * ot15 + 2 * ot20)
  };
}

/** Grand totals across all rows, for the sheet's footer totals row. */
export function computeLogTotals(rows) {
  const sums = { normal: 0, ot_15: 0, ot_20: 0, total_hours: 0, total_ot_hours: 0, total_payable_hours: 0 };
  for (const row of rows || []) {
    if (!isRowInUse(row)) continue;
    const rowTotals = computeRowTotals(row);
    sums.normal += num(row.normal);
    sums.ot_15 += num(row.ot_15);
    sums.ot_20 += num(row.ot_20);
    sums.total_hours += rowTotals.total_hours || 0;
    sums.total_ot_hours += rowTotals.total_ot_hours || 0;
    sums.total_payable_hours += rowTotals.total_payable_hours || 0;
  }
  return {
    normal: round2(sums.normal),
    ot_15: round2(sums.ot_15),
    ot_20: round2(sums.ot_20),
    total_hours: round2(sums.total_hours),
    total_ot_hours: round2(sums.total_ot_hours),
    total_payable_hours: round2(sums.total_payable_hours)
  };
}

function isValidHourCell(value) {
  if (value === undefined || value === null || value === "") return true;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 24;
}

/**
 * Validates the rows array. Rules:
 *  - a row with any hours entered must have a worker name;
 *  - grade, if present, must be "Artisan" or "Assistant" (the prototype's
 *    tick-column convention — see README for the tick-vs-hours-entry
 *    assumption this maps from);
 *  - normal/ot_15/ot_20 must be blank or a number in [0, 24].
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateContractorLogRows(rows) {
  const errors = [];
  (rows || []).forEach((row, index) => {
    const label = `Row ${index + 1}`;
    if (!isRowInUse(row)) return;

    if (!String(row.worker_name || "").trim()) {
      errors.push(`${label}: a worker name is required once hours are entered.`);
    }
    if (row.grade !== undefined && row.grade !== null && row.grade !== "" && !["Artisan", "Assistant"].includes(row.grade)) {
      errors.push(`${label}: grade must be "Artisan" or "Assistant".`);
    }
    if (!isValidHourCell(row.normal)) errors.push(`${label}: Normal must be a number of hours (0-24).`);
    if (!isValidHourCell(row.ot_15)) errors.push(`${label}: Overtime 1.5 must be a number of hours (0-24).`);
    if (!isValidHourCell(row.ot_20)) errors.push(`${label}: Overtime 2.0 must be a number of hours (0-24).`);
  });
  return errors;
}

/** Index of the first row to show as unused when printing (mirrors dailyTimesheetValidation.js's voidStartIndex). */
export function voidStartIndex(rows) {
  const list = rows || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isRowInUse(list[i])) return i + 1;
  }
  return 0;
}
