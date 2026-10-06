// Timesheet (the ONE daily source record) - pure logic, no req/res.
//
// A Timesheet is the existing `field_worksheets` record, extended ADDITIVELY
// (nothing renamed or removed, so dispatch completion, client acknowledgement,
// Supervisor review, revisions, job packs, reports, notifications and the
// invoice gate keep working). A record is "version 2" once it carries the
// Normal / 1.5 / 2.0 breakdown. Version 2 records are the canonical hours
// source for the Worksheet (monthly register); older records are history.
//
// Sign-off = three explicit, attributable events, each stored server-side:
//   1. worker (employee / contractor): signatures.employee, set on the record;
//   2. customer representative: the existing client_acknowledgement (a Client
//      Viewer's authenticated acknowledgement with signer, role, time, evidence id);
//   3. foreman / Supervisor: the independent Supervisor approval (approved_by/at).

export const TIMESHEET_VERSION = 2;
export const WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS = 3; // reviewer exception, NOT a limit

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v) => ISO.test(String(v || "")) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function dayTypeOf(date) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 6 ? "saturday" : d === 0 ? "sunday" : "weekday"; // public holidays: blocked until policy (OD-05)
}

function bucket(value) {
  if (value === undefined || value === null || value === "" || value === "X" || value === "x") return { value: 0, valid: true };
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? { value: r2(n), valid: true } : { value: 0, valid: false };
}

// Accepts { normal, ot_15, ot_20 } (numbers, blanks or "X"). Returns the clean
// breakdown plus the server-derived total used for the legacy `hours` field.
export function normaliseBreakdown(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "Normal, 1.5 and 2.0 hours are required." };
  const n = bucket(input.normal); const a = bucket(input.ot_15); const b = bucket(input.ot_20);
  if (!n.valid || !a.valid || !b.valid) return { ok: false, error: "Each of Normal, 1.5 and 2.0 must be a number of hours from 0 to 24." };
  const total = r2(n.value + a.value + b.value);
  if (total <= 0) return { ok: false, error: "Total hours must be greater than zero." };
  if (total > 24) return { ok: false, error: "A Timesheet cannot record more than 24 hours." };
  return { ok: true, breakdown: { normal: n.value, ot_15: a.value, ot_20: b.value }, total };
}

const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "")); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
export function validateTimes(start, end) {
  if (!start && !end) return null;
  const s = toMin(start); const e = toMin(end);
  if (s === null || e === null) return "Start and end must both be valid times (HH:MM).";
  if (e <= s) return "End time must be after start time.";
  return null;
}

export const isTimesheetV2 = (ws) => ws?.timesheet_version === TIMESHEET_VERSION && ws?.hours_breakdown && typeof ws.hours_breakdown === "object";

// ---- sign-off ----
export function employeeSignoffMissing(ws) {
  const sig = ws?.signatures?.employee || {};
  const reasons = [];
  if (!String(sig.name || "").trim()) reasons.push("name");
  if (!isIsoDate(sig.date)) reasons.push("date");
  if (!(ws?.signed_copy_image || (sig.method === "on_device" && sig.attested_at))) reasons.push("signed copy or on-device attestation");
  return reasons;
}

export function timesheetSignoff(ws) {
  const parties = [];
  const emp = employeeSignoffMissing(ws);
  parties.push({ party: "employee", label: "Worker (employee / contractor)", done: emp.length === 0, missing: emp });
  parties.push({ party: "customer_representative", label: "Customer representative (client acknowledgement)", done: Boolean(ws?.client_acknowledgement?.acknowledged_at), missing: ws?.client_acknowledgement?.acknowledged_at ? [] : ["client acknowledgement"] });
  parties.push({ party: "supervisor", label: "Foreman / Supervisor (approval)", done: Boolean(ws?.approved_by && ws?.approved_at), missing: ws?.approved_by && ws?.approved_at ? [] : ["Supervisor approval"] });
  return { complete: parties.every((p) => p.done), parties, missing: parties.filter((p) => !p.done) };
}

// ---- server-side classification (runs on create / update / submit / review) ----
export function classifyTimesheet(ws, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const flags = [];
  if (!isTimesheetV2(ws)) {
    flags.push({ code: "LEGACY_NO_BREAKDOWN", severity: "info", message: "Recorded before Normal / 1.5 / 2.0 was captured. Its hours cannot be classified, so it is not counted in a Worksheet." });
    return { flags, checked_at: new Date().toISOString() };
  }
  const { normal, ot_15, ot_20 } = ws.hours_breakdown;
  const total = r2(normal + ot_15 + ot_20);
  const type = isIsoDate(ws.work_date) ? dayTypeOf(ws.work_date) : null;
  if (!isIsoDate(ws.work_date)) flags.push({ code: "INVALID_DATE", severity: "blocking", message: "Work date is not a valid date." });
  if (total > 24) flags.push({ code: "HOURS_EXCEED_24", severity: "blocking", message: `Total ${total} hours is more than 24.` });
  if (type === "weekday" && ot_15 > WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS) {
    flags.push({ code: "WEEKDAY_OT15_OVER_THRESHOLD", severity: "warning", message: `${ot_15} hours at 1.5 on a weekday is above the ${WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS}-hour review threshold. Reviewer check, not a limit.` });
  }
  if (type && ((type === "weekday" || type === "saturday") ? ot_20 > 0 : ot_15 > 0)) {
    flags.push({ code: "DAY_TYPE_BUCKET_MISMATCH", severity: "info", message: `This ${type} has hours in a column not normally used that day.` });
  }
  if (isIsoDate(ws.work_date) && ws.work_date > today) flags.push({ code: "FUTURE_DATE", severity: "warning", message: `Work date ${ws.work_date} is in the future.` });
  const timeError = validateTimes(ws.start_time, ws.end_time);
  if (timeError) flags.push({ code: "INVALID_TIMES", severity: "blocking", message: timeError });
  if (!String(ws.activity || "").trim()) flags.push({ code: "NO_DESCRIPTION", severity: "blocking", message: "Work description is required." });
  return { flags, checked_at: new Date().toISOString() };
}

export const workerIdentity = (ws) => ({
  technician_id: ws?.technician_id || null,
  name: ws?.worker_name || null
});
