// Worksheet: pure consolidation logic. No req/res and no db writes, so it
// is unit-testable and is the single server-side source of truth for what a
// Worksheet contains.
//
// Business model (see REGISTER_DESIGN_DELTA.md):
//   * A Worksheet is a register: employees down the rows, dates across
//     the columns, each cell holding Normal / 1.5 / 2.0 hours (the shape of the
//     supplied monthly Excel register).
//   * It is CONSOLIDATED from Supervisor-approved Daily Time Sheet rows. Nobody
//     re-keys hours. Every consolidated cell keeps lineage back to the exact
//     Daily Time Sheet rows (sheet id + row index + content hash).
//   * It is hours only. It never reads, writes or returns a rate, amount or cost.
//   * It never creates billable time. See reconciliationEvidence() below.
//
// TWO CONCEPTS: a Timesheet is the one daily source record (a version-2
// `field_worksheets` record); a Worksheet is this auto-generated register.
//
// SOURCE PRECEDENCE (a worker + date is counted from ONE source kind):
//   1. Timesheet (version 2: approved, with all three sign-offs) is canonical.
//      One worker may have Timesheets on several dispatches the same day; they are
//      added only when distinct dispatches and non-overlapping times. Two for the
//      same dispatch are a blocking duplicate.
//   2. Legacy Daily Time Sheet rows (history, read-only) count only if no
//      Timesheet covers that worker/date.
//   3. Legacy Contractor Log rows count only if neither of the above covers it,
//      and only with an individual worker, a valid date and an hour breakdown.
//   4. Legacy Field Worksheets with no Normal/1.5/2.0 breakdown cannot be
//      classified, so they are never counted.
//   Every counted cell lists the source record ids and rows it came from.

import { createHash } from "node:crypto";
import { isTimesheetV2, timesheetSignoff, normaliseBreakdown } from "./timesheetModel.js";

export const REGISTER_STATUS = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  RETURNED: "Returned_For_Correction",
  APPROVED: "Approved",
  CANCELLED: "Cancelled"
});

export const RECONCILIATION_STATE = Object.freeze({
  NOT_BUILT: "Not_Built",
  EXCEPTIONS_OPEN: "Exceptions_Open",
  AWAITING_ACK: "Awaiting_Acknowledgement",
  CLEAR: "Clear",
  EVIDENCE_RECORDED: "Evidence_Recorded"
});

export const SEVERITY = Object.freeze({ BLOCKING: "blocking", WARNING: "warning", INFO: "info" });

export const EXCEPTION_CODES = Object.freeze({
  DAILY_NOT_SUBMITTED: "SOURCE_NOT_SUBMITTED",
  DAILY_AWAITING_REVIEW: "SOURCE_AWAITING_REVIEW",
  DAILY_RETURNED: "SOURCE_RETURNED",
  OUT_OF_PERIOD: "OUT_OF_PERIOD",
  CARRY_OVER_NOT_ELIGIBLE: "CARRY_OVER_NOT_ELIGIBLE",
  ROW_CLAIMED_ELSEWHERE: "ROW_CLAIMED_ELSEWHERE",
  DUPLICATE_RECORDS: "DUPLICATE_RECORDS",
  MULTIPLE_RECORDS_SAME_DATE: "MULTIPLE_RECORDS_SAME_DATE",
  DAILY_SIGNOFF_INCOMPLETE: "SOURCE_SIGNOFF_INCOMPLETE",
  MULTIPLE_JOBS_SAME_DATE: "MULTIPLE_JOBS_SAME_DATE",
  OVERLAPPING_JOBS: "OVERLAPPING_JOBS",
  LEGACY_SOURCE_SUPERSEDED: "LEGACY_SOURCE_SUPERSEDED",
  LEGACY_NO_BREAKDOWN: "LEGACY_NO_BREAKDOWN",
  WEEKDAY_OT15_OVER_THRESHOLD: "WEEKDAY_OT15_OVER_THRESHOLD",
  CONTRACTOR_LOG_SUPERSEDED: "CONTRACTOR_LOG_SUPERSEDED",
  CONTRACTOR_LOG_EVIDENCE_ONLY: "CONTRACTOR_LOG_EVIDENCE_ONLY",
  WORKER_DATE_CLAIMED_ELSEWHERE: "WORKER_DATE_CLAIMED_ELSEWHERE",
  NO_DAILY_RECORDS: "NO_DAILY_RECORDS",
  INVALID_HOURS: "INVALID_HOURS",
  HOURS_EXCEED_24: "HOURS_EXCEED_24",
  NORMAL_HOURS_MISSING: "NORMAL_HOURS_MISSING",
  EMPTY_HOURS_ROW: "EMPTY_HOURS_ROW",
  ROW_EXCLUDED: "ROW_EXCLUDED",
  UNROSTERED_WORKER: "UNROSTERED_WORKER",
  UNLINKED_EMPLOYEE: "UNLINKED_EMPLOYEE",
  DAY_TYPE_BUCKET_MISMATCH: "DAY_TYPE_BUCKET_MISMATCH",
  BILLABLE_ENTRY_OVERLAP: "BILLABLE_ENTRY_OVERLAP",
  EXCLUSION_REF_UNKNOWN: "EXCLUSION_REF_UNKNOWN"
});

// Daily Time Sheet statuses (dailyTimesheetController.js).
const DTS_APPROVED = "Supervisor_Approved";
const DTS_SUBMITTED = "Submitted";
const DTS_RETURNED = "Returned_For_Correction";
const CL_APPROVED = "Supervisor_Approved";
export const SOURCE_TYPES = Object.freeze({ TIMESHEET: "timesheet", DAILY: "daily_timesheet", CONTRACTOR: "contractor_log" });
const TS_APPROVED = "Supervisor_Approved";

export const MAX_PERIOD_DAYS = 62;
// Reviewer-exception threshold, NOT a hard limit: more than this many 1.5-rate
// hours on one weekday raises a warning that a person must acknowledge with a note.
export const WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS = 3;
export const DEFAULT_LOOK_AROUND_DAYS = 35; // OWNER DECISION OD-06 (default pending confirmation)
export const MAX_ROSTER = 150;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BUCKETS = ["normal", "ot_15", "ot_20"];
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const sha = (text) => createHash("sha256").update(text).digest("hex");

// ---------- dates ----------
export function isIsoDate(value) {
  const str = String(value || "");
  if (!DATE_PATTERN.test(str)) return false;
  const t = Date.parse(`${str}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === str;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function enumerateDates(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

// weekday | saturday | sunday ONLY. Public-holiday classification is BLOCKED until
// the company policy is decided (owner decision OD-05): no date is ever treated as
// a public holiday here, and the API rejects a holiday list outright.
export function dayTypeOf(date) {
  const wd = weekdayOf(date);
  if (wd === "Sat") return "saturday";
  if (wd === "Sun") return "sunday";
  return "weekday";
}

export function validatePeriod(start, end) {
  const errors = [];
  if (!isIsoDate(start)) errors.push("Period start must be a valid date (YYYY-MM-DD).");
  if (!isIsoDate(end)) errors.push("Period end must be a valid date (YYYY-MM-DD).");
  if (errors.length) return errors;
  if (end < start) errors.push("Period end cannot be before period start.");
  else if (daysBetween(start, end) + 1 > MAX_PERIOD_DAYS) errors.push(`A Worksheet period cannot exceed ${MAX_PERIOD_DAYS} days.`);
  return errors;
}

export function normaliseName(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- hours ----------
// Daily Time Sheet cells: a number of hours, blank, or "X" (= no overtime).
// X and blank count as zero. Anything else is invalid and is never guessed at.
export function parseHourCell(value) {
  if (value === undefined || value === null || value === "") return { value: 0, valid: true, blank: true };
  if (value === "X" || value === "x") return { value: 0, valid: true, blank: false, isX: true };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 24) return { value: 0, valid: false, blank: false };
  return { value: r2(n), valid: true, blank: false };
}

export function rowHours(row) {
  const normal = parseHourCell(row?.normal_hours);
  const ot15 = parseHourCell(row?.ot_15);
  const ot20 = parseHourCell(row?.ot_20);
  return {
    normal: normal.value, ot_15: ot15.value, ot_20: ot20.value,
    valid: normal.valid && ot15.valid && ot20.valid,
    allBlank: normal.blank && ot15.blank && ot20.blank
  };
}

export function rowFingerprint(type, recordId, index, row) {
  if (type === SOURCE_TYPES.TIMESHEET) {
    return sha(JSON.stringify([type, recordId, row?.dispatch_card_id || "", row?.work_date || "", row?.hours_breakdown || null, row?.start_time || "", row?.end_time || "", row?.activity || ""])).slice(0, 16);
  }
  const canonical = type === SOURCE_TYPES.CONTRACTOR
    ? JSON.stringify([type, recordId, index, row?.worker_name || "", row?.normal ?? null, row?.ot_15 ?? null, row?.ot_20 ?? null])
    : JSON.stringify([type, recordId, index, row?.date || "", row?.start_time || "", row?.end_time || "",
      row?.normal_hours ?? null, row?.ot_15 ?? null, row?.ot_20 ?? null, row?.description || ""]);
  return sha(canonical).slice(0, 16);
}

export const rowKey = (type, recordId, index) => `${type}:${recordId}#${index}`;
const refOf = (type, recordId, index) => ({ source_type: type, record_id: recordId, row_index: index });

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

// ---------- sign-off (Daily Time Sheet ONLY) ----------
// Explicit sign-off = a named signatory, a valid date, and evidence that it really
// was signed (a signed copy attached to the sheet, or captured on a device). This
// reads ONLY the Daily Time Sheet's own signatures. A Field Worksheet's client
// acknowledgement is a different record and is never consulted here.
export const SIGNOFF_PARTY_LABEL = Object.freeze({ employee: "Employee / contractor", site_foreman: "Foreman / Supervisor", customer_representative: "Customer representative" });

export function signoffStatus(sheet) {
  const required = ["employee", "site_foreman"];
  if (sheet?.customer_signoff_required === true) required.push("customer_representative");
  const missing = [];
  for (const party of required) {
    const sig = sheet?.signatures?.[party] || {};
    const reasons = [];
    if (!String(sig.name || "").trim()) reasons.push("name");
    if (!isIsoDate(sig.date)) reasons.push("date");
    if (!(sheet?.signed_copy_image || sig.method === "on_device")) reasons.push("signed copy or on-device capture");
    if (reasons.length) missing.push({ party, label: SIGNOFF_PARTY_LABEL[party], missing: reasons });
  }
  return { complete: missing.length === 0, required, missing };
}

function contractorSignoffOk(log) {
  const sigs = log?.signatures || {};
  return ["foreman", "supervisor"].some((k) => String(sigs[k]?.name || "").trim() && isIsoDate(sigs[k]?.date));
}

// ---------- exceptions ----------
function makeException(code, severity, message, parts = {}, details = {}) {
  const { roster_key = null, dts_id = null, record_id = null, date = null } = parts;
  const rid = record_id || dts_id;
  const key = `${code}:${roster_key || "-"}:${rid || "-"}:${date || "-"}`;
  const fingerprint = sha(JSON.stringify([message, details])).slice(0, 12);
  return { key, code, severity, roster_key, record_id: rid, dts_id: rid, date, message, details, fingerprint };
}

// Carry an acknowledgement forward only while the exception is unchanged.
export function mergeAcknowledgements(previous = [], fresh = []) {
  const prior = new Map((previous || []).map((e) => [e.key, e]));
  return fresh.map((exc) => {
    const old = prior.get(exc.key);
    if (old?.acknowledged_at && old.fingerprint === exc.fingerprint && exc.severity === SEVERITY.WARNING) {
      return { ...exc, acknowledged_by: old.acknowledged_by, acknowledged_at: old.acknowledged_at, acknowledgement_note: old.acknowledgement_note };
    }
    return exc;
  });
}

export const blockingExceptions = (exceptions) => (exceptions || []).filter((e) => e.severity === SEVERITY.BLOCKING);
export const unacknowledgedWarnings = (exceptions) => (exceptions || []).filter((e) => e.severity === SEVERITY.WARNING && !e.acknowledged_at);

export function countExceptions(exceptions) {
  const list = exceptions || [];
  return {
    blocking: list.filter((e) => e.severity === SEVERITY.BLOCKING).length,
    warning: list.filter((e) => e.severity === SEVERITY.WARNING).length,
    warning_unacknowledged: unacknowledgedWarnings(list).length,
    info: list.filter((e) => e.severity === SEVERITY.INFO).length
  };
}

export function deriveReconciliationState(record) {
  if (record.reconciliation) return RECONCILIATION_STATE.EVIDENCE_RECORDED;
  if (!record.built_at) return RECONCILIATION_STATE.NOT_BUILT;
  if (blockingExceptions(record.exceptions).length) return RECONCILIATION_STATE.EXCEPTIONS_OPEN;
  if (unacknowledgedWarnings(record.exceptions).length) return RECONCILIATION_STATE.AWAITING_ACK;
  return RECONCILIATION_STATE.CLEAR;
}

// ---------- claims ----------
// A source row may belong to at most one live Worksheet, and one
// worker + date may be counted by at most one live Worksheet, whichever
// source supplied it. Drafts do not reserve (an abandoned draft must not starve a
// month); Submitted and Approved ones do. Identity keys are deliberately
// conservative (technician id AND normalised name) so a linked worker in one
// month and the same person typed by name in another still collide.
const identityKeysFor = (r) => [r?.technician_id ? `tech:${r.technician_id}` : null, r?.display_name ? `name:${normaliseName(r.display_name)}` : null].filter(Boolean);

export function claimedRows(db, excludeId = null) {
  const rows = new Map();
  const workerDates = new Map();
  for (const m of db.worksheet_registers || []) {
    if (m.id === excludeId) continue;
    if (![REGISTER_STATUS.SUBMITTED, REGISTER_STATUS.APPROVED].includes(m.status)) continue;
    const rosterByKey = new Map((m.roster || []).map((r) => [r.key, r]));
    for (const line of m.lines || []) {
      if (line.carry_over) { /* carry-over dates are explicit, row-level claims still apply */ }
      for (const s of line.sources || []) {
        rows.set(rowKey(s.source_type || SOURCE_TYPES.DAILY, s.record_id ?? s.dts_id, s.row_index), { register_id: m.id, reference: m.reference, status: m.status });
      }
      for (const id of identityKeysFor(rosterByKey.get(line.roster_key))) {
        workerDates.set(`${id}|${line.date}`, { register_id: m.id, reference: m.reference, status: m.status, sources: line.sources || [], kinds: [...new Set((line.sources || []).map((x) => x.source_type || SOURCE_TYPES.DAILY))] });
      }
    }
  }
  return { rows, workerDates };
}

const sumBuckets = (cands) => ({
  normal: r2(cands.reduce((a, c) => a + c.hours.normal, 0)),
  ot_15: r2(cands.reduce((a, c) => a + c.hours.ot_15, 0)),
  ot_20: r2(cands.reduce((a, c) => a + c.hours.ot_20, 0))
});

// ---------- consolidation ----------
export function consolidate(monthly, db) {
  const period = monthly.period || {};
  const roster = monthly.roster || [];
  const lookAround = Number.isInteger(monthly.look_around_days) ? monthly.look_around_days : DEFAULT_LOOK_AROUND_DAYS;
  const deptFilter = normaliseName(monthly.scope?.department_section);
  const refKey = (x) => rowKey(x.source_type || SOURCE_TYPES.DAILY, x.record_id ?? x.dts_id, x.row_index);
  const exclusions = new Map((monthly.exclusions || []).map((x) => [refKey(x), x]));
  const carryOvers = new Map((monthly.carry_overs || []).map((x) => [refKey(x), x]));
  const claims = claimedRows(db, monthly.id);
  const exceptions = [];
  const push = (e) => { if (!exceptions.some((x) => x.key === e.key)) exceptions.push(e); };

  const rosterByTech = new Map();
  const rosterByName = new Map();
  roster.forEach((r) => {
    if (r.technician_id) rosterByTech.set(r.technician_id, r.key);
    rosterByName.set(normaliseName(r.display_name), r.key);
  });
  const rosterEntry = (key) => roster.find((r) => r.key === key);
  const label = (key) => rosterEntry(key)?.display_name || key;
  const near = (date) => date >= addDays(period.start, -lookAround) && date <= addDays(period.end, lookAround);

  const candidates = []; // every approved, eligible, unexcluded, unclaimed source row
  const touchedRoster = new Set();
  const usedRefs = new Set();

  // ----- Daily Time Sheets (canonical) -----
  for (const sheet of db.daily_timesheets || []) {
    if (deptFilter && normaliseName(sheet.department_section) !== deptFilter) continue;
    const rosterKeyFor = (sheet.technician_id && rosterByTech.get(sheet.technician_id))
      || (!sheet.technician_id ? rosterByName.get(normaliseName(sheet.name_on_form)) : null) || null;
    const entries = sheet.entries || [];
    const T = SOURCE_TYPES.DAILY;

    if (!rosterKeyFor) {
      const inPeriod = entries.some((row) => row?.kind !== "separator" && row?.date >= period.start && row?.date <= period.end);
      if (inPeriod && sheet.status === DTS_APPROVED) {
        push(makeException(EXCEPTION_CODES.UNROSTERED_WORKER, SEVERITY.INFO,
          `Approved Daily Time Sheet for ${sheet.name_on_form || "an unnamed worker"} has rows in this period but the worker is not on this roster.`,
          { record_id: sheet.id }, { name: sheet.name_on_form || null }));
      }
      continue;
    }

    const gate = { status: [], signoff: [] };
    const signoff = signoffStatus(sheet);
    entries.forEach((row, index) => {
      if (!row || row.kind === "separator") return;
      const ref = rowKey(T, sheet.id, index);
      usedRefs.add(ref);
      const date = row.date;
      if (!isIsoDate(date)) {
        push(makeException(EXCEPTION_CODES.INVALID_HOURS, SEVERITY.BLOCKING,
          `${label(rosterKeyFor)}: row ${index + 1} of Daily Time Sheet ${sheet.id} has no valid date.`,
          { roster_key: rosterKeyFor, record_id: sheet.id }, { row_index: index, rows: [refOf(T, sheet.id, index)] }));
        return;
      }
      const inPeriod = date >= period.start && date <= period.end;
      const isCarry = carryOvers.has(ref);
      if (inPeriod) touchedRoster.add(rosterKeyFor);

      if (exclusions.has(ref)) {
        push(makeException(EXCEPTION_CODES.ROW_EXCLUDED, SEVERITY.INFO,
          `${label(rosterKeyFor)}: row ${index + 1} (${date}) of ${sheet.id} excluded: ${exclusions.get(ref).reason}`,
          { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index, source_type: T }));
        return;
      }
      if (!inPeriod && !isCarry) {
        if (near(date) && !claims.rows.has(ref)) {
          push(makeException(EXCEPTION_CODES.OUT_OF_PERIOD, SEVERITY.WARNING,
            `${label(rosterKeyFor)}: ${date} (Daily Time Sheet ${sheet.id}, ${sheet.status}) falls outside ${period.start} to ${period.end} and is not in any other submitted or approved Worksheet. It is not counted here. Exclude it, include it as an explicit carry-over, or acknowledge.`,
            { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index, status: sheet.status, rows: [refOf(T, sheet.id, index)] }));
        }
        return;
      }
      if (sheet.status !== DTS_APPROVED) { gate.status.push(index); return; }
      if (!signoff.complete) { gate.signoff.push(index); return; }
      if (isCarry && inPeriod) {
        push(makeException(EXCEPTION_CODES.CARRY_OVER_NOT_ELIGIBLE, SEVERITY.WARNING,
          `${label(rosterKeyFor)}: ${date} is inside the period, so the carry-over flag was ignored.`,
          { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index }));
      }
      if (claims.rows.has(ref)) {
        const c = claims.rows.get(ref);
        push(makeException(EXCEPTION_CODES.ROW_CLAIMED_ELSEWHERE, SEVERITY.WARNING,
          `${label(rosterKeyFor)}: ${date} (Daily Time Sheet ${sheet.id}) is already counted in ${c.reference || c.register_id} (${c.status}), so it is not counted again here.`,
          { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index, other_register_id: c.register_id }));
        return;
      }
      const hours = rowHours(row);
      if (!hours.valid) {
        push(makeException(EXCEPTION_CODES.INVALID_HOURS, SEVERITY.BLOCKING,
          `${label(rosterKeyFor)}: ${date} (Daily Time Sheet ${sheet.id}) has hours outside 0 to 24 or not a number.`,
          { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index, rows: [refOf(T, sheet.id, index)] }));
        return;
      }
      const total = r2(hours.normal + hours.ot_15 + hours.ot_20);
      if (total === 0) {
        if (row.start_time || row.end_time) {
          push(makeException(EXCEPTION_CODES.NORMAL_HOURS_MISSING, SEVERITY.WARNING,
            `${label(rosterKeyFor)}: ${date} (Daily Time Sheet ${sheet.id}) has start/end times but no hours recorded, so it counts as 0 hours. Hours are never derived from times here.`,
            { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index }));
        } else {
          push(makeException(EXCEPTION_CODES.EMPTY_HOURS_ROW, SEVERITY.INFO,
            `${label(rosterKeyFor)}: ${date} (Daily Time Sheet ${sheet.id}) has no hours.`,
            { roster_key: rosterKeyFor, record_id: sheet.id, date }, { row_index: index }));
        }
      }
      candidates.push({ roster_key: rosterKeyFor, date, carry: !inPeriod, source_type: T, record_id: sheet.id, row_index: index,
        row_hash: rowFingerprint(T, sheet.id, index, row), hours: { normal: hours.normal, ot_15: hours.ot_15, ot_20: hours.ot_20 } });
    });
    if (gate.status.length) {
      const code = sheet.status === DTS_SUBMITTED ? EXCEPTION_CODES.DAILY_AWAITING_REVIEW
        : sheet.status === DTS_RETURNED ? EXCEPTION_CODES.DAILY_RETURNED : EXCEPTION_CODES.DAILY_NOT_SUBMITTED;
      const text = code === EXCEPTION_CODES.DAILY_AWAITING_REVIEW ? "is submitted but not yet approved"
        : code === EXCEPTION_CODES.DAILY_RETURNED ? "was returned for correction" : "is still a draft";
      push(makeException(code, SEVERITY.BLOCKING,
        `${label(rosterKeyFor)}: Daily Time Sheet ${sheet.id} ${text}, so its hours cannot be counted. Get it approved, or exclude the affected rows with a reason.`,
        { roster_key: rosterKeyFor, record_id: sheet.id }, { status: sheet.status, row_indexes: gate.status, rows: gate.status.map((i) => refOf(T, sheet.id, i)) }));
    }
    if (gate.signoff.length) {
      const what = signoff.missing.map((m) => `${m.label} (${m.missing.join(", ")})`).join("; ");
      push(makeException(EXCEPTION_CODES.DAILY_SIGNOFF_INCOMPLETE, SEVERITY.BLOCKING,
        `${label(rosterKeyFor)}: Daily Time Sheet ${sheet.id} is approved but its own sign-off is incomplete: ${what}. A Field Worksheet's client acknowledgement does not replace it. Complete the sign-off on the Daily Time Sheet, or exclude the affected rows with a reason.`,
        { roster_key: rosterKeyFor, record_id: sheet.id }, { missing: signoff.missing, row_indexes: gate.signoff, rows: gate.signoff.map((i) => refOf(T, sheet.id, i)) }));
    }
  }

  // ----- Timesheets (version 2 = canonical) -----
  const dispatchOf = (ws) => (db.dispatch_cards || []).find((d) => d.id === ws.dispatch_card_id) || null;
  const quoteOfDispatch = (d) => (db.quotes || []).find((q) => q.id === d?.quotation_id) || null;
  const inScope = (ws) => {
    const q = quoteOfDispatch(dispatchOf(ws));
    if (!q || q.client_id !== monthly.scope?.client_id) return false;
    if (monthly.scope?.quote_id && q.id !== monthly.scope.quote_id) return false;
    if (monthly.scope?.purchase_order_id) {
      const po = (db.purchase_orders || []).find((x) => x.id === monthly.scope.purchase_order_id);
      if (!po || po.quotation_id !== q.id) return false;
    }
    return true;
  };
  const legacyNoBreakdown = new Map(); // roster key -> [ids]
  for (const ws of db.field_worksheets || []) {
    const T = SOURCE_TYPES.TIMESHEET;
    if (ws.superseded_by) continue;
    const rosterKeyFor = (ws.technician_id && rosterByTech.get(ws.technician_id))
      || (!ws.technician_id ? rosterByName.get(normaliseName(ws.worker_name)) : null) || null;
    if (!rosterKeyFor || !inScope(ws)) continue;
    const date = ws.work_date;
    const inPeriod = isIsoDate(date) && date >= period.start && date <= period.end;
    if (!isTimesheetV2(ws)) {
      if (inPeriod && ws.status === TS_APPROVED) (legacyNoBreakdown.get(rosterKeyFor) || legacyNoBreakdown.set(rosterKeyFor, []).get(rosterKeyFor)).push(ws.id);
      continue;
    }
    const ref = rowKey(T, ws.id, 0);
    usedRefs.add(ref);
    if (!isIsoDate(date)) {
      push(makeException(EXCEPTION_CODES.INVALID_HOURS, SEVERITY.BLOCKING, `${label(rosterKeyFor)}: Timesheet ${ws.id} has no valid work date.`, { roster_key: rosterKeyFor, record_id: ws.id }, { rows: [refOf(T, ws.id, 0)] }));
      continue;
    }
    const isCarry = carryOvers.has(ref);
    if (inPeriod) touchedRoster.add(rosterKeyFor);
    if (exclusions.has(ref)) {
      push(makeException(EXCEPTION_CODES.ROW_EXCLUDED, SEVERITY.INFO, `${label(rosterKeyFor)}: Timesheet ${ws.id} (${date}) excluded: ${exclusions.get(ref).reason}`, { roster_key: rosterKeyFor, record_id: ws.id, date }, { row_index: 0, source_type: T }));
      continue;
    }
    if (!inPeriod && !isCarry) {
      if (near(date) && !claims.rows.has(ref)) {
        push(makeException(EXCEPTION_CODES.OUT_OF_PERIOD, SEVERITY.WARNING,
          `${label(rosterKeyFor)}: ${date} (Timesheet ${ws.id}, ${ws.status}) falls outside ${period.start} to ${period.end} and is not in any other submitted or approved Worksheet. It is not counted here. Exclude it, include it as an explicit carry-over, or acknowledge.`,
          { roster_key: rosterKeyFor, record_id: ws.id, date }, { row_index: 0, status: ws.status, rows: [refOf(T, ws.id, 0)] }));
      }
      continue;
    }
    if (ws.status !== TS_APPROVED) {
      const code = ws.status === "Draft" ? EXCEPTION_CODES.DAILY_NOT_SUBMITTED
        : ws.status === "Returned_For_Correction" ? EXCEPTION_CODES.DAILY_RETURNED : EXCEPTION_CODES.DAILY_AWAITING_REVIEW;
      const text = code === EXCEPTION_CODES.DAILY_NOT_SUBMITTED ? "is still a draft" : code === EXCEPTION_CODES.DAILY_RETURNED ? "was returned for correction"
        : ws.status === "Submitted" ? "is waiting for the customer's acknowledgement" : "is waiting for Supervisor approval";
      push(makeException(code, SEVERITY.BLOCKING, `${label(rosterKeyFor)}: Timesheet ${ws.id} (${date}) ${text}, so its hours cannot be counted. Get it approved, or exclude it with a reason.`,
        { roster_key: rosterKeyFor, record_id: ws.id, date }, { status: ws.status, rows: [refOf(T, ws.id, 0)] }));
      continue;
    }
    const so = timesheetSignoff(ws);
    if (!so.complete) {
      push(makeException(EXCEPTION_CODES.DAILY_SIGNOFF_INCOMPLETE, SEVERITY.BLOCKING,
        `${label(rosterKeyFor)}: Timesheet ${ws.id} (${date}) is approved but sign-off is incomplete: ${so.missing.map((m) => `${m.label} (${m.missing.join(", ")})`).join("; ")}. Exclude it with a reason, or have it revised.`,
        { roster_key: rosterKeyFor, record_id: ws.id, date }, { missing: so.missing, rows: [refOf(T, ws.id, 0)] }));
      continue;
    }
    if (isCarry && inPeriod) {
      push(makeException(EXCEPTION_CODES.CARRY_OVER_NOT_ELIGIBLE, SEVERITY.WARNING, `${label(rosterKeyFor)}: ${date} is inside the period, so the carry-over flag was ignored.`, { roster_key: rosterKeyFor, record_id: ws.id, date }, { row_index: 0 }));
    }
    if (claims.rows.has(ref)) {
      const c = claims.rows.get(ref);
      push(makeException(EXCEPTION_CODES.ROW_CLAIMED_ELSEWHERE, SEVERITY.WARNING, `${label(rosterKeyFor)}: ${date} (Timesheet ${ws.id}) is already counted in ${c.reference || c.register_id} (${c.status}), so it is not counted again here.`, { roster_key: rosterKeyFor, record_id: ws.id, date }, { row_index: 0, other_register_id: c.register_id }));
      continue;
    }
    const parsed = normaliseBreakdown(ws.hours_breakdown);
    if (!parsed.ok) {
      push(makeException(EXCEPTION_CODES.INVALID_HOURS, SEVERITY.BLOCKING, `${label(rosterKeyFor)}: ${date} (Timesheet ${ws.id}) has invalid hours: ${parsed.error}`, { roster_key: rosterKeyFor, record_id: ws.id, date }, { rows: [refOf(T, ws.id, 0)] }));
      continue;
    }
    candidates.push({ roster_key: rosterKeyFor, date, carry: !inPeriod, source_type: T, record_id: ws.id, row_index: 0,
      row_hash: rowFingerprint(T, ws.id, 0, ws), hours: parsed.breakdown, dispatch_id: ws.dispatch_card_id,
      start: toMinutes(ws.start_time), end: toMinutes(ws.end_time) });
  }
  for (const [rk, ids] of legacyNoBreakdown) {
    push(makeException(EXCEPTION_CODES.LEGACY_NO_BREAKDOWN, SEVERITY.INFO,
      `${label(rk)}: ${ids.length} approved record(s) in this period (${ids.sort().join(", ")}) predate the Normal / 1.5 / 2.0 breakdown. Their hours cannot be classified, so they are not counted. Record the work on a Timesheet if it must appear here.`,
      { roster_key: rk }, { record_ids: ids }));
  }

  // ----- Contractor Logs (legacy; count only with worker + date + hour breakdown) -----
  const evidenceOnly = new Map(); // log id -> { reasons: Map(reason -> n) , name }
  const noteEvidenceOnly = (log, reason) => {
    const e = evidenceOnly.get(log.id) || { name: log.contractor_name, reasons: new Map() };
    e.reasons.set(reason, (e.reasons.get(reason) || 0) + 1); evidenceOnly.set(log.id, e);
  };
  for (const log of db.contractor_log_sheets || []) {
    if (deptFilter && normaliseName(log.department_section) !== deptFilter) continue;
    const T = SOURCE_TYPES.CONTRACTOR;
    const date = log.log_date;
    const validDate = isIsoDate(date);
    (log.rows || []).forEach((row, index) => {
      const ref = rowKey(T, log.id, index);
      usedRefs.add(ref);
      const name = String(row?.worker_name || "").trim();
      const anyHours = ["normal", "ot_15", "ot_20"].some((k) => row?.[k] !== undefined && row[k] !== null && row[k] !== "");
      if (!name && !anyHours) return;
      const inPeriod = validDate && date >= period.start && date <= period.end;
      const isCarry = carryOvers.has(ref);
      if (validDate && !inPeriod && !isCarry) return; // not this period: no noise
      if (exclusions.has(ref)) { noteEvidenceOnly(log, "excluded by a reviewer"); return; }
      if (!validDate) return noteEvidenceOnly(log, "no valid work date on the log");
      if (log.status !== CL_APPROVED) return noteEvidenceOnly(log, `log is ${log.status}, not approved`);
      if (!name) return noteEvidenceOnly(log, "row has no individual worker name");
      if (!anyHours) return noteEvidenceOnly(log, "row has no hour breakdown");
      const hours = rowHours({ normal_hours: row.normal, ot_15: row.ot_15, ot_20: row.ot_20 });
      if (!hours.valid) return noteEvidenceOnly(log, "row has invalid hours");
      if (!contractorSignoffOk(log)) return noteEvidenceOnly(log, "no foreman/supervisor sign-off with name and date");
      const rosterKeyFor = rosterByName.get(normaliseName(name));
      if (!rosterKeyFor) return noteEvidenceOnly(log, "worker is not on this roster");
      touchedRoster.add(rosterKeyFor);
      if (claims.rows.has(ref)) {
        const c = claims.rows.get(ref);
        push(makeException(EXCEPTION_CODES.ROW_CLAIMED_ELSEWHERE, SEVERITY.WARNING,
          `${label(rosterKeyFor)}: ${date} (Contractor Log ${log.id}) is already counted in ${c.reference || c.register_id} (${c.status}), so it is not counted again here.`,
          { roster_key: rosterKeyFor, record_id: log.id, date }, { row_index: index, other_register_id: c.register_id }));
        return;
      }
      candidates.push({ roster_key: rosterKeyFor, date, carry: !inPeriod, source_type: T, record_id: log.id, row_index: index,
        row_hash: rowFingerprint(T, log.id, index, row), hours: { normal: hours.normal, ot_15: hours.ot_15, ot_20: hours.ot_20 }, log_name: log.contractor_name });
    });
  }
  for (const [logId, e] of evidenceOnly) {
    const why = [...e.reasons].map(([r, n]) => `${n} row(s): ${r}`).join("; ");
    push(makeException(EXCEPTION_CODES.CONTRACTOR_LOG_EVIDENCE_ONLY, SEVERITY.INFO,
      `Contractor Log ${logId}${e.name ? ` (${e.name})` : ""} is supporting evidence only for this period. ${why}. Its hours are not counted.`,
      { record_id: logId }, { reasons: Object.fromEntries(e.reasons) }));
  }

  // Exclusion / carry-over references that match no known source row.
  for (const [ref, x] of [...exclusions, ...carryOvers]) {
    if (!usedRefs.has(ref)) {
      push(makeException(EXCEPTION_CODES.EXCLUSION_REF_UNKNOWN, SEVERITY.WARNING,
        `An exclusion or carry-over refers to ${x.source_type || SOURCE_TYPES.DAILY} ${x.record_id ?? x.dts_id} row ${x.row_index + 1}, which does not belong to a rostered worker's record.`,
        { record_id: x.record_id ?? x.dts_id }, { row_index: x.row_index }));
    }
  }

  // ----- Resolve ONE canonical source per worker + date -----
  const groups = new Map();
  for (const c of candidates) {
    const k = `${c.roster_key}|${c.date}|${c.carry ? 1 : 0}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(c);
  }
  const cells = new Map();
  for (const [k, group] of groups) {
    const { roster_key, date, carry } = group[0];
    const who = label(roster_key);
    const ts = group.filter((c) => c.source_type === SOURCE_TYPES.TIMESHEET);
    const dts = group.filter((c) => c.source_type === SOURCE_TYPES.DAILY);
    const cl = group.filter((c) => c.source_type === SOURCE_TYPES.CONTRACTOR);
    const rowsOf = (list) => list.map((c) => refOf(c.source_type, c.record_id, c.row_index));
    const totalsText = (t) => `${t.normal}/${t.ot_15}/${t.ot_20}`;
    let counted = [];
    let evidenceLogs = [];
    let evidenceLegacy = [];
    const lower = [...dts, ...cl];

    if (ts.length) {
      const byDispatch = new Map();
      for (const c of ts) (byDispatch.get(c.dispatch_id) || byDispatch.set(c.dispatch_id, []).get(c.dispatch_id)).push(c);
      const dupDispatch = [...byDispatch.values()].find((l) => l.length > 1);
      if (dupDispatch) {
        push(makeException(EXCEPTION_CODES.DUPLICATE_RECORDS, SEVERITY.BLOCKING,
          `${who}: ${date} has ${dupDispatch.length} Timesheets for the same dispatch (${dupDispatch.map((c) => c.record_id).sort().join(", ")}). One worker, date and dispatch can have one Timesheet. Exclude the duplicate with a reason.`,
          { roster_key, date }, { source_type: SOURCE_TYPES.TIMESHEET, record_ids: dupDispatch.map((c) => c.record_id).sort(), rows: rowsOf(dupDispatch) }));
        continue;
      }
      if (ts.length > 1) {
        const timed = ts.every((c) => c.start !== null && c.end !== null && c.end > c.start);
        const sorted = [...ts].sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
        const overlaps = timed && sorted.some((c, i) => i > 0 && c.start < sorted[i - 1].end);
        if (overlaps) {
          push(makeException(EXCEPTION_CODES.OVERLAPPING_JOBS, SEVERITY.BLOCKING,
            `${who}: ${date} has Timesheets on ${ts.length} dispatches with overlapping times. A worker cannot be on two jobs at once. Exclude the wrong one with a reason.`,
            { roster_key, date }, { record_ids: ts.map((c) => c.record_id).sort(), rows: rowsOf(ts) }));
          continue;
        }
        push(makeException(EXCEPTION_CODES.MULTIPLE_JOBS_SAME_DATE, timed ? SEVERITY.INFO : SEVERITY.WARNING,
          timed ? `${who}: ${date} has Timesheets on ${ts.length} different dispatches with separate times. Hours are added together.`
            : `${who}: ${date} has Timesheets on ${ts.length} different dispatches and times are not recorded on all of them. Hours are added together; confirm the total is real, then acknowledge.`,
          { roster_key, date }, { record_ids: ts.map((c) => c.record_id).sort(), rows: rowsOf(ts) }));
      }
      counted = ts;
      if (lower.length) {
        // Compare with the highest-precedence legacy source only (never legacy-plus-legacy).
        const a = sumBuckets(ts); const b = sumBuckets(dts.length ? dts : cl);
        const same = a.normal === b.normal && a.ot_15 === b.ot_15 && a.ot_20 === b.ot_20;
        evidenceLegacy = [...new Set(dts.map((c) => c.record_id))]; evidenceLogs = [...new Set(cl.map((c) => c.record_id))];
        push(makeException(EXCEPTION_CODES.LEGACY_SOURCE_SUPERSEDED, same ? SEVERITY.INFO : SEVERITY.WARNING,
          same ? `${who}: ${date} is also on legacy record(s) ${[...evidenceLegacy, ...evidenceLogs].join(", ")} with the same hours. The Timesheet is the canonical source; the legacy record is linked as evidence and NOT added.`
            : `${who}: ${date} is also on legacy record(s) ${[...evidenceLegacy, ...evidenceLogs].join(", ")} with DIFFERENT hours (Timesheet ${totalsText(a)}, legacy ${totalsText(b)}). The Timesheet is counted; the legacy record is NOT added. Check which is right, then acknowledge.`,
          { roster_key, date }, { timesheet_totals: a, legacy_totals: b, record_ids: [...evidenceLegacy, ...evidenceLogs], rows: rowsOf(lower) }));
      }
    } else {
      const dtsIds = [...new Set(dts.map((c) => c.record_id))];
      if (dtsIds.length > 1) {
        push(makeException(EXCEPTION_CODES.DUPLICATE_RECORDS, SEVERITY.BLOCKING,
          `${who}: ${date} appears on ${dtsIds.length} different approved Daily Time Sheets (${dtsIds.sort().join(", ")}). Only one source per worker and date may be counted, and the hours are never added together. Exclude the duplicate rows with a reason.`,
          { roster_key, date }, { source_type: SOURCE_TYPES.DAILY, record_ids: dtsIds, rows: rowsOf(dts) }));
        continue;
      }
      if (dts.length) {
        counted = dts;
        if (cl.length) {
          const a = sumBuckets(dts); const b = sumBuckets(cl);
          const same = a.normal === b.normal && a.ot_15 === b.ot_15 && a.ot_20 === b.ot_20;
          evidenceLogs = [...new Set(cl.map((c) => c.record_id))];
          push(makeException(EXCEPTION_CODES.CONTRACTOR_LOG_SUPERSEDED, same ? SEVERITY.INFO : SEVERITY.WARNING,
            same ? `${who}: ${date} is also on Contractor Log ${evidenceLogs.join(", ")} with the same hours. The Daily Time Sheet is the canonical source; the log is linked as evidence and NOT added.`
              : `${who}: ${date} is also on Contractor Log ${evidenceLogs.join(", ")} with DIFFERENT hours (Daily Time Sheet ${totalsText(a)}, log ${totalsText(b)}). The Daily Time Sheet is counted; the log is NOT added. Check which is right, then acknowledge.`,
            { roster_key, date }, { daily_totals: a, log_totals: b, log_ids: evidenceLogs, rows: rowsOf(cl) }));
        }
      } else if (cl.length > 1) {
        push(makeException(EXCEPTION_CODES.DUPLICATE_RECORDS, SEVERITY.BLOCKING,
          `${who}: ${date} appears on ${cl.length} Contractor Log rows and no Timesheet. Only one source may be counted. Exclude the duplicate rows with a reason.`,
          { roster_key, date }, { source_type: SOURCE_TYPES.CONTRACTOR, record_ids: [...new Set(cl.map((c) => c.record_id))].sort(), rows: rowsOf(cl) }));
        continue;
      } else counted = cl;
    }

    // Same worker + date already counted by another live month from a different source.
    const r = rosterEntry(roster_key);
    const ourKind = counted[0].source_type;
    // Another live Worksheet counting this worker+date from a DIFFERENT source kind is a
    // double count. The same kind (e.g. a Timesheet on another client's dispatch) is not.
    const other = identityKeysFor(r).map((id) => claims.workerDates.get(`${id}|${date}`)).find((o) => o && o.kinds.some((k) => k !== ourKind));
    if (other) {
      push(makeException(EXCEPTION_CODES.WORKER_DATE_CLAIMED_ELSEWHERE, SEVERITY.BLOCKING,
        `${who}: ${date} is already counted in ${other.reference || other.register_id} (${other.status}) from a different source record. One worker and date can be counted once. Exclude these rows with a reason.`,
        { roster_key, date }, { other_register_id: other.register_id, rows: rowsOf(counted) }));
      continue;
    }

    const totals = sumBuckets(counted);
    cells.set(k, { roster_key, date, carry_over: carry, ...totals, source_type: counted[0].source_type,
      sources: counted.map((c) => ({ source_type: c.source_type, record_id: c.record_id, row_index: c.row_index, row_hash: c.row_hash })),
      evidence: { contractor_logs: evidenceLogs, legacy_daily: evidenceLegacy } });
  }

  // ----- Cell-level checks -----
  for (const cell of cells.values()) {
    const total = r2(cell.normal + cell.ot_15 + cell.ot_20);
    const who = label(cell.roster_key);
    const rows = cell.sources.map((s) => refOf(s.source_type, s.record_id, s.row_index));
    if (total > 24) {
      push(makeException(EXCEPTION_CODES.HOURS_EXCEED_24, SEVERITY.BLOCKING,
        `${who}: ${cell.date} totals ${total} hours across rows of one source, which is more than 24.`,
        { roster_key: cell.roster_key, date: cell.date }, { total, rows }));
    }
    const type = dayTypeOf(cell.date);
    if (type === "weekday" && cell.ot_15 > WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS) {
      push(makeException(EXCEPTION_CODES.WEEKDAY_OT15_OVER_THRESHOLD, SEVERITY.WARNING,
        `${who}: ${cell.date} is a weekday with ${cell.ot_15} hours at 1.5, above the ${WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS}-hour review threshold. This is a reviewer check, not a limit: confirm against the signed sheet and acknowledge with a note.`,
        { roster_key: cell.roster_key, date: cell.date }, { ot_15: cell.ot_15, threshold: WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS, rows }));
    }
    if (!cell.carry_over) {
      const odd = (type === "weekday" || type === "saturday") ? cell.ot_20 > 0 : cell.ot_15 > 0;
      if (odd) {
        push(makeException(EXCEPTION_CODES.DAY_TYPE_BUCKET_MISMATCH, SEVERITY.INFO,
          `${who}: ${cell.date} is a ${type} but has hours in a column not normally used that day. Confirm the 1.5 / 2.0 classification on the source sheet.`,
          { roster_key: cell.roster_key, date: cell.date }, { day_type: type }));
      }
    }
  }

  // ----- Roster-level checks -----
  const hasLines = new Set([...cells.values()].map((c) => c.roster_key));
  for (const r of roster) {
    if (!touchedRoster.has(r.key) && !hasLines.has(r.key)) {
      push(makeException(EXCEPTION_CODES.NO_DAILY_RECORDS, SEVERITY.WARNING,
        `${r.display_name} has no source rows in ${period.start} to ${period.end}. Confirm they did not work, or find the missing Daily Time Sheet.`,
        { roster_key: r.key }, {}));
    }
    if (!r.technician_id) {
      push(makeException(EXCEPTION_CODES.UNLINKED_EMPLOYEE, SEVERITY.INFO,
        `${r.display_name} is matched by name only (no linked Technician account), so billable-time overlap checks cannot be run for them.`,
        { roster_key: r.key }, {}));
    }
  }

  // ----- Existing billable time entries (kiosk batches): a separate record of the same labour -----
  for (const r of roster) {
    if (!r.technician_id) continue;
    const myDates = new Set([...cells.values()].filter((c) => c.roster_key === r.key && !c.carry_over && (c.normal + c.ot_15 + c.ot_20) > 0).map((c) => c.date));
    const billable = (db.timesheets || []).filter((t) => (t.technician_id || t.user_id) === r.technician_id
      && myDates.has(t.work_date) && t.review_status !== "rejected");
    if (billable.length) {
      const dates = [...new Set(billable.map((t) => t.work_date))].sort();
      push(makeException(EXCEPTION_CODES.BILLABLE_ENTRY_OVERLAP, SEVERITY.WARNING,
        `${r.display_name}: ${billable.length} existing billable time entr${billable.length === 1 ? "y" : "ies"} already cover ${dates.length} of the same date(s). Approving this Worksheet never bills time, but billing must not be raised from both. Acknowledge to confirm.`,
        { roster_key: r.key }, { dates, entry_ids: billable.map((t) => t.id).sort() }));
    }
  }

  const lines = [...cells.values()]
    .sort((a, b) => a.roster_key.localeCompare(b.roster_key) || a.date.localeCompare(b.date) || Number(a.carry_over) - Number(b.carry_over));
  const order = { blocking: 0, warning: 1, info: 2 };
  exceptions.sort((a, b) => (order[a.severity] - order[b.severity]) || a.key.localeCompare(b.key));
  return { lines, exceptions };
}

// ---------- totals and grid ----------
export function computeTotals(lines, roster = []) {
  const blank = () => ({ normal: 0, ot_15: 0, ot_20: 0, total_hours: 0 });
  const add = (t, l) => {
    t.normal = r2(t.normal + l.normal); t.ot_15 = r2(t.ot_15 + l.ot_15); t.ot_20 = r2(t.ot_20 + l.ot_20);
    t.total_hours = r2(t.normal + t.ot_15 + t.ot_20);
  };
  const byEmployee = {}; const byDate = {}; const byGroup = {}; const carry = blank(); const grand = blank();
  const groupOf = new Map(roster.map((r) => [r.key, r.group || ""]));
  for (const line of lines) {
    byEmployee[line.roster_key] = byEmployee[line.roster_key] || blank();
    add(byEmployee[line.roster_key], line);
    const g = groupOf.get(line.roster_key) || "";
    byGroup[g] = byGroup[g] || blank(); add(byGroup[g], line);
    if (line.carry_over) add(carry, line);
    else { byDate[line.date] = byDate[line.date] || blank(); add(byDate[line.date], line); }
    add(grand, line);
  }
  // total_hours is the RAW sum of Normal + 1.5 + 2.0 hours as the register's
  // "Total Hours" columns show them. No weighted/payable hours and no amounts
  // are computed: the weighting formula is an open owner decision (OD-04) and
  // amounts need the controlled rate card, which does not exist yet.
  return { by_employee: byEmployee, by_date: byDate, by_group: byGroup, carry_over: carry, grand };
}

export function buildGridView(record) {
  const period = record.period || {};
  const dates = period.start && period.end && validatePeriod(period.start, period.end).length === 0
    ? enumerateDates(period.start, period.end) : [];
  const dateCols = dates.map((date) => {
    const type = dayTypeOf(date);
    return { date, weekday: weekdayOf(date), day_type: type, expected: type === "sunday" ? ["normal", "ot_20"] : ["normal", "ot_15"] };
  });
  const lineMap = new Map();
  const carryMap = new Map();
  for (const line of record.lines || []) {
    if (line.carry_over) {
      const c = carryMap.get(line.roster_key) || { normal: 0, ot_15: 0, ot_20: 0, dates: [] };
      c.normal = r2(c.normal + line.normal); c.ot_15 = r2(c.ot_15 + line.ot_15); c.ot_20 = r2(c.ot_20 + line.ot_20);
      c.dates.push(line.date); carryMap.set(line.roster_key, c);
    } else lineMap.set(`${line.roster_key}|${line.date}`, line);
  }
  const totals = computeTotals(record.lines || [], record.roster || []);
  const rows = (record.roster || []).map((r) => {
    const cellsOut = {};
    for (const d of dates) {
      const l = lineMap.get(`${r.key}|${d}`);
      if (l) cellsOut[d] = { normal: l.normal, ot_15: l.ot_15, ot_20: l.ot_20, source_type: l.source_type || SOURCE_TYPES.DAILY,
        sources: (l.sources || []).map((x) => ({ source_type: x.source_type || SOURCE_TYPES.DAILY, record_id: x.record_id ?? x.dts_id, row_index: x.row_index })),
        evidence: l.evidence || { contractor_logs: [], legacy_daily: [] } };
    }
    return {
      roster_key: r.key, display_name: r.display_name, technician_id: r.technician_id || null, group: r.group || "",
      cells: cellsOut, carry_over: carryMap.get(r.key) || null,
      totals: totals.by_employee[r.key] || { normal: 0, ot_15: 0, ot_20: 0, total_hours: 0 }
    };
  });
  return { dates: dateCols, rows, totals };
}

export const linesHash = (lines) => sha(JSON.stringify((lines || []).map((l) => [l.roster_key, l.date, l.carry_over, l.normal, l.ot_15, l.ot_20, (l.sources || []).map((s) => [s.source_type, s.record_id, s.row_index, s.row_hash])])));

// Every distinct source record a month counted, for the audit trail.
export function sourceRecordIds(lines) {
  const out = new Set();
  for (const l of lines || []) for (const s of l.sources || []) out.add(`${s.source_type}:${s.record_id}`);
  return [...out].sort();
}

// ---------- reconciliation evidence (approved, non-billable) ----------
// DELIBERATE LIMIT: this records an immutable, hours-only evidence snapshot of an
// approved Worksheet. It creates no billable time entry, because billable
// time needs a server-resolved rate from a controlled rate card, and that does not
// exist yet. Nothing here invents, defaults or accepts a rate.
export function reconciliationEvidence(record, { actorId, now, id }) {
  const totals = computeTotals(record.lines || [], record.roster || []);
  const overlapOf = (code) => (record.exceptions || []).filter((e) => e.code === code)
    .map((e) => ({ roster_key: e.roster_key, ...e.details, acknowledged: Boolean(e.acknowledged_at) }));
  const billableOverlaps = overlapOf(EXCEPTION_CODES.BILLABLE_ENTRY_OVERLAP);
  const sheetIds = new Map();
  for (const l of record.lines || []) for (const s of l.sources || []) { const k = `${s.source_type}:${s.record_id}`; sheetIds.set(k, (sheetIds.get(k) || 0) + 1); }
  return {
    id,
    idempotency_key: `worksheet_register:${record.id}:reconcile:v1`,
    status: "Evidence_Recorded_NonBillable",
    recorded_by: actorId,
    recorded_at: now,
    source_lines_hash: record.approved_lines_hash,
    totals: totals.grand,
    per_worker: (record.roster || []).map((r) => ({
      roster_key: r.key, display_name: r.display_name, technician_id: r.technician_id || null, group: r.group || "",
      ...(totals.by_employee[r.key] || { normal: 0, ot_15: 0, ot_20: 0, total_hours: 0 }),
      days: (record.lines || []).filter((l) => l.roster_key === r.key).length
    })),
    sources: [...sheetIds.entries()].map(([k, row_count]) => { const [source_type, ...rest] = k.split(":"); return { source_type, record_id: rest.join(":"), row_count }; }).sort((a, b) => `${a.source_type}${a.record_id}`.localeCompare(`${b.source_type}${b.record_id}`)),
    overlaps: { billable_entries: billableOverlaps },
    acknowledged_warning_keys: (record.exceptions || []).filter((e) => e.acknowledged_at).map((e) => e.key),
    billing: {
      state: "not_billed",
      billable_entries_created: 0,
      hold_reason: "RATE_CARD_NOT_AVAILABLE",
      overlap_hold: billableOverlaps.length > 0
    },
    rate_source: { status: "not_available", note: "Rates are resolved on the server from a controlled rate card, which is not part of this release. No rate, amount or cost is stored or accepted." }
  };
}

// For the future billable-conversion step (not implemented): lists approved
// Worksheets that already cover a worker/date, so a later step can refuse
// to bill the same labour from a second source.
export function findApprovedRegisterCoverage(db, { technician_id, date }) {
  const out = [];
  for (const m of db.worksheet_registers || []) {
    if (m.status !== REGISTER_STATUS.APPROVED) continue;
    const keys = new Set((m.roster || []).filter((r) => r.technician_id === technician_id).map((r) => r.key));
    for (const l of m.lines || []) {
      if (keys.has(l.roster_key) && l.date === date) {
        out.push({ register_id: m.id, reference: m.reference, normal: l.normal, ot_15: l.ot_15, ot_20: l.ot_20, billing_state: m.reconciliation?.billing?.state || "not_reconciled" });
      }
    }
  }
  return out;
}

// Re-checks that every Daily Time Sheet row an approved Worksheet was
// built from is still approved and byte-for-byte the row that was consolidated.
// Used before recording reconciliation evidence. (Approved Daily Time Sheets are
// not editable today; this proves it rather than assuming it.)
export function verifySourceLineage(record, db) {
  const drift = [];
  const daily = new Map((db.daily_timesheets || []).map((x) => [x.id, x]));
  const logs = new Map((db.contractor_log_sheets || []).map((x) => [x.id, x]));
  const timesheets = new Map((db.field_worksheets || []).map((x) => [x.id, x]));
  for (const line of record.lines || []) {
    for (const s of line.sources || []) {
      const type = s.source_type || SOURCE_TYPES.DAILY;
      const ref = { source_type: type, record_id: s.record_id, row_index: s.row_index };
      if (type === SOURCE_TYPES.TIMESHEET) {
        const ws = timesheets.get(s.record_id);
        if (!ws) drift.push({ ...ref, reason: "Timesheet no longer exists." });
        else if (ws.superseded_by) drift.push({ ...ref, reason: "Timesheet has been superseded by a revision." });
        else if (ws.status !== TS_APPROVED) drift.push({ ...ref, reason: `Timesheet is now ${ws.status}.` });
        else if (!timesheetSignoff(ws).complete) drift.push({ ...ref, reason: "Timesheet sign-off is no longer complete." });
        else if (rowFingerprint(type, s.record_id, 0, ws) !== s.row_hash) drift.push({ ...ref, reason: "Source row content changed since consolidation." });
        continue;
      }
      if (type === SOURCE_TYPES.CONTRACTOR) {
        const log = logs.get(s.record_id); const row = log?.rows?.[s.row_index];
        if (!log) drift.push({ ...ref, reason: "Contractor Log no longer exists." });
        else if (log.status !== CL_APPROVED) drift.push({ ...ref, reason: `Contractor Log is now ${log.status}.` });
        else if (!row || rowFingerprint(type, s.record_id, s.row_index, row) !== s.row_hash) drift.push({ ...ref, reason: "Source row content changed since consolidation." });
        continue;
      }
      const sheet = daily.get(s.record_id); const row = sheet?.entries?.[s.row_index];
      if (!sheet) drift.push({ ...ref, reason: "Daily Time Sheet no longer exists." });
      else if (sheet.status !== DTS_APPROVED) drift.push({ ...ref, reason: `Daily Time Sheet is now ${sheet.status}.` });
      else if (!signoffStatus(sheet).complete) drift.push({ ...ref, reason: "Daily Time Sheet sign-off is no longer complete." });
      else if (!row || rowFingerprint(type, s.record_id, s.row_index, row) !== s.row_hash) drift.push({ ...ref, reason: "Source row content changed since consolidation." });
    }
  }
  return drift;
}

// Fingerprint of everything a reviewer is shown: the consolidated lines plus the
// exception set. Submit/approve compare it with a fresh consolidation so nobody
// signs off a grid that no longer matches the source records.
// Information items gate nothing, so they are left out: an unrelated Field
// Worksheet appearing must not force a rebuild.
export function stateHash(lines, exceptions) {
  return sha(JSON.stringify([linesHash(lines), (exceptions || []).filter((e) => e.severity !== SEVERITY.INFO).map((e) => [e.key, e.fingerprint])]));
}
