// Pure logic for the Daily Time Sheet feature: no db/req/res knowledge, so
// this can be unit tested directly and is the single source of truth for
// "is this set of rows valid" on the backend. (The frontend has its own
// copy in frontend/src/lib/dailyTimesheetLogic.js — see that file's header
// comment for why this isn't shared as one module across the two packages.)

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/; // ISO, consistent with work_date elsewhere in this codebase

export function toMinutes(value) {
  const match = TIME_PATTERN.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function isValidIsoDate(value) {
  const str = String(value || "");
  if (!DATE_PATTERN.test(str)) return false;
  const timestamp = Date.parse(`${str}T00:00:00Z`);
  return !Number.isNaN(timestamp);
}

/**
 * NORMAL hours from start/end, straight end-start with no lunch deduction
 * (the paper form does not deduct one either — see README). Returns null
 * when either time is missing/invalid or end is not after start, so a
 * caller can tell "can't compute" from "computed to zero".
 */
export function computeNormalHours(startTime, endTime) {
  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  if (startMin === null || endMin === null || endMin <= startMin) return null;
  return Math.round(((endMin - startMin) / 60) * 100) / 100;
}

/**
 * Validates one row's overtime cell: the paper form's convention is either
 * a number of hours, or a literal "X" meaning "no overtime applies" (an
 * assumption carried from the visual prototype — see README). Empty is
 * allowed (rows are entered incrementally while drafting).
 */
export function isValidOvertimeCell(value) {
  if (value === undefined || value === null || value === "") return true;
  if (value === "X" || value === "x") return true;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && num <= 24;
}

/**
 * Validates a full entries array (the rows the clerk has actually typed,
 * not a fixed 24-row grid — unused trailing rows are a print-time concern,
 * not stored data; see voidStartIndex below).
 *
 * Rules enforced:
 *  - a "separator" row (the paper form's "—" convention) carries no time
 *    data and is always valid;
 *  - every other row needs a valid date;
 *  - start/end, if present, must be valid times with end after start;
 *  - two entry rows on the same date must not have overlapping start/end
 *    ranges;
 *  - 1.5 / 2.0 cells must be blank, a non-negative number, or "X".
 *
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateDailyTimesheetEntries(entries) {
  const errors = [];
  const rangesByDate = new Map();

  (entries || []).forEach((row, index) => {
    const label = `Row ${index + 1}`;
    if (row && row.kind === "separator") return;

    if (!isValidIsoDate(row?.date)) {
      errors.push(`${label}: date is required and must be a valid date.`);
      return;
    }

    if (!isValidOvertimeCell(row?.ot_15)) errors.push(`${label}: the 1.5 column must be a number of hours or "X".`);
    if (!isValidOvertimeCell(row?.ot_20)) errors.push(`${label}: the 2.0 column must be a number of hours or "X".`);

    const hasStart = row?.start_time !== undefined && row.start_time !== "";
    const hasEnd = row?.end_time !== undefined && row.end_time !== "";
    if (!hasStart && !hasEnd) return;

    const startMin = hasStart ? toMinutes(row.start_time) : null;
    const endMin = hasEnd ? toMinutes(row.end_time) : null;
    if (hasStart && startMin === null) errors.push(`${label}: start time is not a valid time (expected HH:MM).`);
    if (hasEnd && endMin === null) errors.push(`${label}: end time is not a valid time (expected HH:MM).`);
    if (startMin === null || endMin === null) return;
    if (endMin <= startMin) {
      errors.push(`${label}: end time must be after start time.`);
      return;
    }

    const existing = rangesByDate.get(row.date) || [];
    const overlaps = existing.some((range) => startMin < range.end && endMin > range.start);
    if (overlaps) errors.push(`${label}: overlaps another row already entered for ${row.date}.`);
    existing.push({ start: startMin, end: endMin });
    rangesByDate.set(row.date, existing);
  });

  return errors;
}

/**
 * Index of the first row that should be struck through as "unused" when
 * printing — i.e. the row immediately after the last row carrying any
 * data. Mirrors the visual prototype's firstEmptyRow() but operates on
 * stored entries rather than scanning DOM inputs.
 */
export function voidStartIndex(entries) {
  const rows = entries || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const hasData = row && (row.kind === "separator" || row.date || row.start_time || row.end_time || row.normal_hours || row.ot_15 || row.ot_20 || row.description);
    if (hasData) return i + 1;
  }
  return 0;
}
