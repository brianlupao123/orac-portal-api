import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePeriod, enumerateDates, dayTypeOf, weekdayOf, parseHourCell, consolidate, computeTotals, buildGridView,
  mergeAcknowledgements, verifySourceLineage, reconciliationEvidence, findApprovedRegisterCoverage, linesHash, signoffStatus,
  sourceRecordIds, blockingExceptions, WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS, EXCEPTION_CODES as C
} from "../src/worksheetRegisterLogic.js";
import { classifyTimesheet, normaliseBreakdown, timesheetSignoff, employeeSignoffMissing } from "../src/timesheetModel.js";
import { CreateWorksheetRegisterSchema } from "../src/worksheetRegisterSchemas.js";
import { makeDb, addDaily, addTimesheet, addContractorLog, clRow, row, baseBody } from "./helpers/worksheetRegisterFixture.js";

const D = "daily_timesheet"; const K = "contractor_log"; const TS = "timesheet";
const roster2 = [
  { key: "t_u_tech1", technician_id: "u_tech1", display_name: "Test Worker One", group: "Fitters" },
  { key: "t_u_tech2", technician_id: "u_tech2", display_name: "Test Worker Two", group: "Riggers" }
];
const monthly = (over = {}) => ({
  id: "wks_a", reference: "WKS-202609-001", period: { start: "2026-08-31", end: "2026-09-30" },
  scope: { client_id: "c_test", project_title: "P", department_section: "" }, roster: roster2,
  exclusions: [], carry_overs: [], status: "Draft", lines: [], exceptions: [], ...over
});
const codes = (r) => r.exceptions.map((e) => e.code);
const find = (r, code) => r.exceptions.find((e) => e.code === code);
const FORBIDDEN_KEYS = new Set(["hourly_rate", "rate", "rates", "amount", "total_amount", "cost", "total_cost", "unit_price", "price", "weighted_hours", "payable_hours"]);
function moneyKeys(value, found = []) {
  if (Array.isArray(value)) value.forEach((v) => moneyKeys(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(k)) found.push(k); moneyKeys(v, found); }
  return found;
}

test("period: 31 Aug to 30 Sep is a valid 31-day period; bad and over-long periods are rejected", () => {
  assert.deepEqual(validatePeriod("2026-08-31", "2026-09-30"), []);
  assert.equal(enumerateDates("2026-08-31", "2026-09-30").length, 31);
  assert.ok(validatePeriod("2026-09-30", "2026-09-01").length);
  assert.ok(validatePeriod("2026-02-30", "2026-03-01").length);
  assert.ok(validatePeriod("2026-01-01", "2026-04-01").length);
});

test("day types are weekday / saturday / sunday only: public-holiday classification is blocked, never guessed", () => {
  assert.equal(weekdayOf("2026-09-06"), "Sun");
  assert.equal(dayTypeOf("2026-09-05"), "saturday");
  assert.equal(dayTypeOf("2026-09-06"), "sunday");
  assert.equal(dayTypeOf("2026-09-15"), "weekday");
  assert.equal(dayTypeOf("2026-09-15", ["2026-09-15"]), "weekday", "a holiday list is ignored: no policy exists");
  const bad = CreateWorksheetRegisterSchema.safeParse({ ...baseBody(), public_holiday_dates: ["2026-09-15"] });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error.issues), /blocked until the company policy is decided/);
  assert.equal(CreateWorksheetRegisterSchema.safeParse({ ...baseBody(), public_holiday_dates: [] }).success, true);
});

test("hour cells: blank and X are zero, junk and out-of-range are invalid", () => {
  assert.deepEqual(parseHourCell("X"), { value: 0, valid: true, blank: false, isX: true });
  assert.equal(parseHourCell("").valid, true);
  assert.equal(parseHourCell(3.5).value, 3.5);
  for (const bad of [-1, 25, "abc"]) assert.equal(parseHourCell(bad).valid, false);
});

test("approved, signed-off Daily Time Sheet rows consolidate with source id, row and hash on every cell; X counts as zero", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_1", entries: [row("2026-09-01", 9, { ot_15: 2 }), row("2026-09-02", 8)] });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 2);
  const l = r.lines.find((x) => x.date === "2026-09-01");
  assert.deepEqual([l.normal, l.ot_15, l.ot_20], [9, 2, 0]);
  assert.equal(l.source_type, D);
  assert.deepEqual(l.sources.map((x) => [x.source_type, x.record_id, x.row_index]), [[D, "dts_1", 0]]);
  assert.match(l.sources[0].row_hash, /^[0-9a-f]{16}$/);
  assert.equal(r.lines.find((x) => x.date === "2026-09-02").ot_15, 0);
  assert.deepEqual(sourceRecordIds(r.lines), ["daily_timesheet:dts_1"]);
  const cell = buildGridView({ ...monthly(), lines: r.lines }).rows[0].cells["2026-09-01"];
  assert.deepEqual(cell.sources, [{ source_type: D, record_id: "dts_1", row_index: 0 }], "the source id is on the grid cell the user sees");
});

test("only Supervisor-approved rows count; non-approved sheets block, name the affected rows, and add no hours", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_d", status: "Draft", entries: [row("2026-09-01", 9), row("2026-09-02", 9)] });
  addDaily(db, { id: "dts_s", status: "Submitted", technician_id: "u_tech2", name: "Test Worker Two", entries: [row("2026-09-01", 9)] });
  addDaily(db, { id: "dts_r", status: "Returned_For_Correction", technician_id: "u_tech2", name: "Test Worker Two", entries: [row("2026-09-02", 9)] });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.deepEqual([...new Set(codes(r))].filter((c) => c.startsWith("SOURCE_")).sort(), ["SOURCE_AWAITING_REVIEW", "SOURCE_NOT_SUBMITTED", "SOURCE_RETURNED"]);
  assert.deepEqual(find(r, C.DAILY_NOT_SUBMITTED).details.rows.map((x) => x.row_index), [0, 1], "the UI can offer to exclude exactly these rows");
});

test("an exclusion with a reason clears the block and is shown as information", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_d", status: "Draft", entries: [row("2026-09-01", 9)] });
  const r = consolidate(monthly({ exclusions: [{ source_type: D, record_id: "dts_d", row_index: 0, reason: "Abandoned draft" }] }), db);
  assert.equal(blockingExceptions(r.exceptions).length, 0);
  assert.equal(find(r, C.ROW_EXCLUDED).severity, "info");
});

test("explicit sign-off: employee and foreman are required, customer representative only where the sheet requires it", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_ns", signoff: false, entries: [row("2026-09-01", 9)] });
  let r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0, "unsigned hours are never counted");
  const exc = find(r, C.DAILY_SIGNOFF_INCOMPLETE);
  assert.equal(exc.severity, "blocking");
  assert.deepEqual(exc.details.missing.map((m) => m.party), ["employee", "site_foreman"]);
  assert.match(exc.message, /Field Worksheet's client acknowledgement does not replace it/);

  db.daily_timesheets.length = 0;
  addDaily(db, { id: "dts_c", customer_signoff_required: true, entries: [row("2026-09-01", 9)] });
  r = consolidate(monthly(), db);
  assert.deepEqual(find(r, C.DAILY_SIGNOFF_INCOMPLETE).details.missing.map((m) => m.party), ["customer_representative"]);
  db.daily_timesheets[0].signatures.customer_representative = { name: "Fictional Customer Rep", date: "2026-09-30", method: "on_device" };
  assert.equal(consolidate(monthly(), db).lines.length, 1);
});

test("sign-off needs name, a valid date and evidence of signing; typed names alone are not enough", () => {
  const typedOnly = { signatures: { employee: { name: "A", date: "2026-09-01" }, site_foreman: { name: "B", date: "2026-09-01" } } };
  assert.equal(signoffStatus(typedOnly).complete, false);
  assert.equal(signoffStatus({ ...typedOnly, signed_copy_image: "data:image/png;base64,AAAA" }).complete, true, "a signed paper copy attached to the sheet is evidence");
  assert.equal(signoffStatus({ signatures: { employee: { name: "A", date: "bad", method: "on_device" }, site_foreman: { name: "B", date: "2026-09-01", method: "on_device" } } }).complete, false);
});

test("a Field Worksheet's client acknowledgement is never a Daily Time Sheet sign-off", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_ns", signoff: false, entries: [row("2026-09-01", 9)] });
  db.field_worksheets.push({ id: "ws_ack", technician_id: "u_tech1", work_date: "2026-09-01", hours: 9, status: "Client_Acknowledged", client_acknowledged_by: "Fictional Client Rep", client_signature: "x" });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.ok(codes(r).includes(C.DAILY_SIGNOFF_INCOMPLETE));
});

test("rows outside the period are not totalled; unclaimed near ones are flagged; carry-over is explicit and separate", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_o", entries: [row("2026-08-03", 9), row("2026-09-02", 8)] });
  let r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 1);
  const oop = find(r, C.OUT_OF_PERIOD);
  assert.ok(oop.severity === "warning" && oop.date === "2026-08-03");
  assert.deepEqual(oop.details.rows, [{ source_type: D, record_id: "dts_o", row_index: 0 }]);
  r = consolidate(monthly({ carry_overs: [{ source_type: D, record_id: "dts_o", row_index: 0, reason: "Late-booked day from prior period" }] }), db);
  assert.equal(r.lines.find((l) => l.carry_over).date, "2026-08-03");
  const totals = computeTotals(r.lines, roster2);
  assert.equal(totals.carry_over.normal, 9); assert.equal(totals.grand.normal, 17);
  assert.equal(totals.by_date["2026-08-03"], undefined);
});

test("a source row, and a worker + date, can be counted by only one live month; drafts and cancelled months do not reserve", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_1", entries: [row("2026-09-01", 9)] });
  const claim = { id: "wks_other", reference: "WKS-X", status: "Draft", roster: roster2, lines: [{ roster_key: "t_u_tech1", date: "2026-09-01", sources: [{ source_type: D, record_id: "dts_1", row_index: 0 }] }] };
  db.worksheet_registers.push(claim);
  assert.equal(consolidate(monthly(), db).lines.length, 1, "Draft does not reserve");
  claim.status = "Submitted";
  let r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.ok(find(r, C.ROW_CLAIMED_ELSEWHERE));
  claim.status = "Cancelled";
  assert.equal(consolidate(monthly(), db).lines.length, 1);

  // Same worker + date counted by another live month from a DIFFERENT source record.
  claim.status = "Approved"; claim.lines[0].sources = [{ source_type: K, record_id: "cls_other", row_index: 0 }];
  r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.equal(find(r, C.WORKER_DATE_CLAIMED_ELSEWHERE).severity, "blocking");
  // ... and the same person typed by name in the other month still collides.
  claim.roster = [{ key: "n_test_worker_one", technician_id: null, display_name: " test  worker ONE ", group: "" }];
  claim.lines[0].roster_key = "n_test_worker_one";
  assert.ok(find(consolidate(monthly(), db), C.WORKER_DATE_CLAIMED_ELSEWHERE));
});

test("ONE source per worker and date: two Daily Time Sheets are never added together, whatever their times", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 4, { start_time: "06:00", end_time: "10:00" })] });
  addDaily(db, { id: "dts_b", entries: [row("2026-09-01", 4, { start_time: "12:00", end_time: "16:00" })] });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0, "neither is counted until a person chooses");
  const e = find(r, C.DUPLICATE_RECORDS);
  assert.equal(e.severity, "blocking");
  assert.deepEqual(e.details.record_ids, ["dts_a", "dts_b"]);
  assert.equal(e.details.rows.length, 2);
  // Excluding one (with a reason) resolves it and the survivor is the single source.
  const r2 = consolidate(monthly({ exclusions: [{ source_type: D, record_id: "dts_b", row_index: 0, reason: "Duplicate of dts_a" }] }), db);
  assert.equal(blockingExceptions(r2.exceptions).length, 0);
  assert.deepEqual(r2.lines[0].sources.map((s) => s.record_id), ["dts_a"]);
  assert.equal(r2.lines[0].normal, 4);
});

test("several rows for one date on the SAME Daily Time Sheet are one source and are added (a split shift on one sheet)", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 4, { start_time: "06:00", end_time: "10:00" }), row("2026-09-01", 4, { start_time: "12:00", end_time: "16:00" })] });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines[0].normal, 8);
  assert.deepEqual(r.lines[0].sources.map((s) => [s.record_id, s.row_index]), [["dts_a", 0], ["dts_a", 1]]);
  assert.equal(blockingExceptions(r.exceptions).length, 0);
});

test("more than 24 hours for one worker/date is blocked; invalid hour values are blocked", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 20, { start_time: "", end_time: "" }), row("2026-09-01", 6, { start_time: "", end_time: "" })] });
  assert.ok(codes(consolidate(monthly(), db)).includes(C.HOURS_EXCEED_24));
  db.daily_timesheets.length = 0;
  addDaily(db, { id: "dts_b", entries: [row("2026-09-02", 99)] });
  assert.ok(consolidate(monthly(), db).exceptions.some((e) => e.code === C.INVALID_HOURS && e.severity === "blocking"));
});

test("an impossible calendar date (30 Feb) is a blocking exception, not silently rolled into March", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_bad", entries: [row("2026-02-30", 9)] });
  const r = consolidate(monthly({ period: { start: "2026-02-01", end: "2026-03-31" } }), db);
  assert.equal(r.lines.length, 0);
  assert.ok(r.exceptions.some((e) => e.code === C.INVALID_HOURS && /no valid date/.test(e.message)));
});

test("times without hours count as 0 with a warning; hours are never derived from start/end", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", null)] });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines[0].normal, 0);
  assert.ok(codes(r).includes(C.NORMAL_HOURS_MISSING));
});

test("3-hour weekday 1.5 threshold is a reviewer warning, not a hard limit: hours still count and a note clears it", () => {
  assert.equal(WEEKDAY_OT15_REVIEW_THRESHOLD_HOURS, 3);
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 8, { ot_15: 3 }), row("2026-09-02", 8, { ot_15: 3.5 }), row("2026-09-05", 8, { ot_15: 6 })] });
  const r = consolidate(monthly(), db);
  const w = r.exceptions.filter((e) => e.code === C.WEEKDAY_OT15_OVER_THRESHOLD);
  assert.deepEqual(w.map((e) => e.date), ["2026-09-02"], "exactly 3 is fine; 3.5 on a weekday warns; a Saturday has no threshold");
  assert.equal(w[0].severity, "warning");
  assert.equal(r.lines.find((l) => l.date === "2026-09-02").ot_15, 3.5, "the hours are counted as recorded, never capped");
  const acked = mergeAcknowledgements([{ ...w[0], acknowledged_at: "t", acknowledged_by: "u", acknowledgement_note: "Confirmed on paper" }], r.exceptions);
  assert.equal(acked.find((e) => e.key === w[0].key).acknowledged_by, "u");
  // The same server check runs when a sheet arrives, before anyone approves it.
  const t = addTimesheet(db, { id: "ws_ot", date: "2026-09-02", breakdown: { normal: 8, ot_15: 3.5, ot_20: 0 } });
  const checks = classifyTimesheet(t, { today: "2026-10-01" });
  assert.ok(checks.flags.some((f) => f.code === "WEEKDAY_OT15_OVER_THRESHOLD" && f.severity === "warning"), "the same server check runs on the Timesheet itself");
  assert.equal(classifyTimesheet({ ...t, hours_breakdown: { normal: 8, ot_15: 3, ot_20: 0 } }).flags.some((f) => f.code === "WEEKDAY_OT15_OVER_THRESHOLD"), false);
});

test("a legacy record with no Normal/1.5/2.0 breakdown is never counted: it cannot be classified", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9)] });
  db.field_worksheets.push({ id: "ws_legacy", dispatch_card_id: "d_1", technician_id: "u_tech1", work_date: "2026-09-02", hours: 8, status: "Supervisor_Approved", activity: "old" });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].normal, 9, "the legacy 8 single-number hours are not added");
  const e = find(r, C.LEGACY_NO_BREAKDOWN);
  assert.equal(e.severity, "info"); assert.deepEqual(e.details.record_ids, ["ws_legacy"]);
});

test("Contractor Log rows count ONLY with an approved log, valid date, individual worker on the roster, hour breakdown and a sign-off", () => {
  const db = makeDb();
  const roster = [{ key: "n_walk_in_worker", technician_id: null, display_name: "Walk In Worker", group: "" }];
  const m = () => monthly({ roster });
  addDaily(db, { id: "dts_other", technician_id: "u_tech2", name: "Other", entries: [row("2026-09-10", 1)] });
  addContractorLog(db, { id: "cls_ok", log_date: "2026-09-01", rows: [clRow("Walk In Worker", 9, { ot_15: 1 })] });
  let r = consolidate(m(), db);
  assert.equal(r.lines.length, 1);
  assert.deepEqual([r.lines[0].source_type, r.lines[0].normal, r.lines[0].ot_15], [K, 9, 1]);
  assert.deepEqual(r.lines[0].sources.map((s) => [s.source_type, s.record_id, s.row_index]), [[K, "cls_ok", 0]]);

  const cases = [
    ["not approved", { status: "Submitted" }, [clRow("Walk In Worker", 9)]],
    ["no date", { log_date: null }, [clRow("Walk In Worker", 9)]],
    ["no worker name", {}, [clRow("", 9)]],
    ["no hour breakdown", {}, [clRow("Walk In Worker", null)]],
    ["worker not on roster", {}, [clRow("Someone Unlisted", 9)]],
    ["no sign-off", { signatures: { foreman: { name: "", date: "" }, supervisor: { name: "", date: "" } } }, [clRow("Walk In Worker", 9)]]
  ];
  for (const [why, over, rows] of cases) {
    const d2 = makeDb();
    addContractorLog(d2, { id: "cls_x", log_date: "2026-09-01", rows, ...over });
    const out = consolidate(m(), d2);
    assert.equal(out.lines.length, 0, `${why}: evidence only, no hours`);
    assert.ok(out.exceptions.some((e) => e.code === C.CONTRACTOR_LOG_EVIDENCE_ONLY && e.severity === "info"), why);
  }
});

test("Daily Time Sheet takes precedence over a Contractor Log for the same worker/date: never double-counted", () => {
  const db = makeDb();
  const roster = [{ key: "t_u_tech1", technician_id: "u_tech1", display_name: "Test Worker One", group: "" }];
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9)] });
  addContractorLog(db, { id: "cls_same", log_date: "2026-09-01", rows: [clRow("test worker one", 9)] });
  let r = consolidate(monthly({ roster }), db);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].normal, 9, "9, not 18");
  assert.deepEqual(r.lines[0].sources.map((s) => s.source_type), [D]);
  assert.deepEqual(r.lines[0].evidence.contractor_logs, ["cls_same"]);
  assert.equal(find(r, C.CONTRACTOR_LOG_SUPERSEDED).severity, "info", "identical hours: linked as evidence");

  db.contractor_log_sheets[0].rows[0].normal = 7;
  r = consolidate(monthly({ roster }), db);
  assert.equal(r.lines[0].normal, 9, "the Daily Time Sheet still wins");
  assert.equal(find(r, C.CONTRACTOR_LOG_SUPERSEDED).severity, "warning", "different hours: a person must look and acknowledge");
});

test("two Contractor Log rows for one worker/date (and no Daily Time Sheet) block instead of adding", () => {
  const db = makeDb();
  const roster = [{ key: "n_walk_in_worker", technician_id: null, display_name: "Walk In Worker", group: "" }];
  addContractorLog(db, { id: "cls_1", rows: [clRow("Walk In Worker", 9)] });
  addContractorLog(db, { id: "cls_2", rows: [clRow("Walk In Worker", 9)] });
  const r = consolidate(monthly({ roster }), db);
  assert.equal(r.lines.length, 0);
  assert.equal(find(r, C.DUPLICATE_RECORDS).details.source_type, K);
});

test("no Daily Time Sheet + Contractor Log combination can double-count: totals always equal ONE source per worker/date", () => {
  const db = makeDb();
  const roster = [{ key: "t_u_tech1", technician_id: "u_tech1", display_name: "Test Worker One", group: "" }];
  for (let d = 1; d <= 5; d += 1) {
    const date = `2026-09-0${d}`;
    addDaily(db, { id: `dts_${d}`, entries: [row(date, 8)] });
    addContractorLog(db, { id: `cls_${d}`, log_date: date, rows: [clRow("Test Worker One", 8)] });
  }
  const r = consolidate(monthly({ roster }), db);
  assert.equal(computeTotals(r.lines, roster).grand.normal, 40);
  for (const l of r.lines) assert.equal(new Set(l.sources.map((s) => s.source_type)).size, 1, "one source type per cell");
});

test("billable-time overlap (existing kiosk entries) is still a warning; rejected entries are not", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9), row("2026-09-02", 9)] });
  db.timesheets.push({ id: "ts_1", technician_id: "u_tech1", work_date: "2026-09-02", hours_logged: 8, entry_source: "kiosk", review_status: "approved" });
  db.timesheets.push({ id: "ts_rej", technician_id: "u_tech1", work_date: "2026-09-01", hours_logged: 8, entry_source: "kiosk", review_status: "rejected" });
  const bt = find(consolidate(monthly(), db), C.BILLABLE_ENTRY_OVERLAP);
  assert.deepEqual(bt.details.entry_ids, ["ts_1"]); assert.equal(bt.severity, "warning");
});

test("a rostered worker with no rows is flagged; unlinked and unrostered workers are information only; a name-only roster entry matches by normalised name", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9)] });
  addDaily(db, { id: "dts_x", technician_id: "u_tech_off", name: "Someone Else", entries: [row("2026-09-01", 9)] });
  addDaily(db, { id: "dts_n", technician_id: null, name: "  walk   IN worker ", entries: [row("2026-09-01", 9)] });
  const m = monthly({ roster: [...roster2, { key: "n_walk_in", technician_id: null, display_name: "Walk In Worker", group: "" }] });
  const r = consolidate(m, db);
  assert.ok(r.exceptions.some((e) => e.code === C.NO_DAILY_RECORDS && e.roster_key === "t_u_tech2"));
  assert.ok(r.exceptions.some((e) => e.code === C.UNROSTERED_WORKER && e.severity === "info"));
  assert.ok(r.exceptions.some((e) => e.code === C.UNLINKED_EMPLOYEE && e.severity === "info"));
  assert.equal(r.lines.filter((l) => l.roster_key === "n_walk_in").length, 1);
});

test("totals are raw hours per bucket; no weighted hours, rate or amount is produced anywhere", () => {
  const db = makeDb();
  addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9, { ot_15: 2, ot_20: 1 })] });
  const r = consolidate(monthly(), db);
  const t = computeTotals(r.lines, roster2);
  assert.deepEqual(t.grand, { normal: 9, ot_15: 2, ot_20: 1, total_hours: 12 });
  assert.deepEqual(moneyKeys({ t, grid: buildGridView({ ...monthly(), lines: r.lines }) }), []);
});

test("acknowledgements carry over only while the exception is unchanged", () => {
  const prev = [{ key: "K", severity: "warning", fingerprint: "a", acknowledged_at: "t", acknowledged_by: "u", acknowledgement_note: "n" }];
  assert.equal(mergeAcknowledgements(prev, [{ key: "K", severity: "warning", fingerprint: "a" }])[0].acknowledged_by, "u");
  assert.equal(mergeAcknowledgements(prev, [{ key: "K", severity: "warning", fingerprint: "b" }])[0].acknowledged_at, undefined);
  assert.equal(mergeAcknowledgements(prev, [{ key: "K", severity: "blocking", fingerprint: "a" }])[0].acknowledged_at, undefined);
});

test("lineage verification covers both source types, changed rows, status changes and sign-off drift", () => {
  const db = makeDb();
  const roster = [{ key: "t_u_tech1", technician_id: "u_tech1", display_name: "Test Worker One", group: "" }, { key: "n_walk_in_worker", technician_id: null, display_name: "Walk In Worker", group: "" }];
  const s = addDaily(db, { id: "dts_a", entries: [row("2026-09-01", 9)] });
  const log = addContractorLog(db, { id: "cls_a", log_date: "2026-09-02", rows: [clRow("Walk In Worker", 8)] });
  const r = consolidate(monthly({ roster }), db);
  const rec = { ...monthly({ roster }), lines: r.lines };
  assert.equal(rec.lines.length, 2);
  assert.deepEqual(verifySourceLineage(rec, db), []);
  s.entries[0].normal_hours = 10;
  assert.match(verifySourceLineage(rec, db)[0].reason, /changed/);
  s.entries[0].normal_hours = 9; s.signatures.site_foreman.name = "";
  assert.match(verifySourceLineage(rec, db)[0].reason, /sign-off/);
  s.signatures.site_foreman.name = "Fictional Foreman"; log.status = "Returned_For_Correction";
  assert.match(verifySourceLineage(rec, db)[0].reason, /Contractor Log is now/);
});

test("reconciliation evidence is hours-only and non-billable and lists typed sources", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", date: "2026-09-01", breakdown: { normal: 9, ot_15: 2, ot_20: 0 } });
  const r = consolidate(monthly(), db);
  const rec = { ...monthly(), id: "wks_a", lines: r.lines, exceptions: r.exceptions, approved_lines_hash: linesHash(r.lines) };
  const ev = reconciliationEvidence(rec, { actorId: "u_ops", now: "2026-10-01T00:00:00.000Z", id: "rec_1" });
  assert.equal(ev.status, "Evidence_Recorded_NonBillable");
  assert.equal(ev.billing.billable_entries_created, 0);
  assert.equal(ev.billing.overlap_hold, false);
  assert.deepEqual(ev.sources, [{ source_type: TS, record_id: "ws_a", row_count: 1 }]);
  assert.deepEqual(moneyKeys(ev), []);
});

// ---------------- the Timesheet (canonical) source ----------------
test("an approved, fully signed-off Timesheet is the canonical source and its id is on the cell", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", date: "2026-09-01", breakdown: { normal: 9, ot_15: 2, ot_20: 0 } });
  const r = consolidate(monthly(), db);
  assert.deepEqual([r.lines[0].source_type, r.lines[0].normal, r.lines[0].ot_15], [TS, 9, 2]);
  assert.deepEqual(r.lines[0].sources.map((s) => [s.source_type, s.record_id]), [[TS, "ws_a"]]);
  assert.deepEqual(buildGridView({ ...monthly(), lines: r.lines }).rows[0].cells["2026-09-01"].sources, [{ source_type: TS, record_id: "ws_a", row_index: 0 }]);
  assert.equal(blockingExceptions(r.exceptions).length, 0);
});

test("Timesheet status gate: draft, submitted (awaiting customer), acknowledged (awaiting Supervisor) and returned never count", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_d", date: "2026-09-01", status: "Draft" });
  addTimesheet(db, { id: "ws_s", date: "2026-09-02", status: "Submitted" });
  addTimesheet(db, { id: "ws_c", date: "2026-09-03", status: "Client_Acknowledged" });
  addTimesheet(db, { id: "ws_r", date: "2026-09-04", status: "Returned_For_Correction" });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.deepEqual(r.exceptions.filter((e) => e.severity === "blocking").map((e) => e.code).sort(), ["SOURCE_AWAITING_REVIEW", "SOURCE_AWAITING_REVIEW", "SOURCE_NOT_SUBMITTED", "SOURCE_RETURNED"]);
  assert.match(find(r, C.DAILY_AWAITING_REVIEW).message, /customer's acknowledgement|Supervisor approval/);
});

test("Timesheet sign-off is three explicit events: worker, customer acknowledgement, Supervisor approval", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_nw", date: "2026-09-01", employee_signoff: false });
  addTimesheet(db, { id: "ws_nc", date: "2026-09-02", client_ack: false });
  addTimesheet(db, { id: "ws_ns", date: "2026-09-03", approved: false });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  const missing = r.exceptions.filter((e) => e.code === C.DAILY_SIGNOFF_INCOMPLETE).map((e) => e.details.missing.map((m) => m.party).join());
  assert.deepEqual(missing.sort(), ["customer_representative", "employee", "supervisor"]);
  assert.equal(timesheetSignoff(db.field_worksheets[0]).complete, false);
  assert.deepEqual(employeeSignoffMissing({ signatures: { employee: { name: "A", date: "2026-09-01", method: "on_device" } } }), ["signed copy or on-device attestation"], "typed name alone is not attested");
  assert.deepEqual(employeeSignoffMissing({ signed_copy_image: "data:x", signatures: { employee: { name: "A", date: "2026-09-01" } } }), []);
});

test("scope: only Timesheets for dispatches of the Worksheet's client (and quote / PO if set) are included", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_in", date: "2026-09-01", dispatch: "d_1" });
  addTimesheet(db, { id: "ws_out", date: "2026-09-02", dispatch: "d_other" });
  const r = consolidate(monthly(), db);
  assert.deepEqual(r.lines.map((l) => l.date), ["2026-09-01"]);
  assert.equal(consolidate(monthly({ scope: { client_id: "c_test", project_title: "P", quote_id: "q_other" } }), db).lines.length, 0);
});

test("one worker, one date, ONE dispatch = one Timesheet: a second is a blocking duplicate, never added", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", date: "2026-09-01" });
  addTimesheet(db, { id: "ws_b", date: "2026-09-01" });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.deepEqual(find(r, C.DUPLICATE_RECORDS).details.record_ids, ["ws_a", "ws_b"]);
  const r2 = consolidate(monthly({ exclusions: [{ source_type: TS, record_id: "ws_b", row_index: 0, reason: "Duplicate of ws_a" }] }), db);
  assert.equal(blockingExceptions(r2.exceptions).length, 0);
  assert.equal(r2.lines[0].normal, 9);
  assert.deepEqual(r2.lines[0].sources.map((s) => s.record_id), ["ws_a"]);
});

test("two jobs the same day: distinct dispatches add only if times do not overlap; untimed needs an acknowledgement; over 24 blocks", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", dispatch: "d_1", breakdown: { normal: 4, ot_15: 0, ot_20: 0 }, start_time: "06:00", end_time: "10:00" });
  addTimesheet(db, { id: "ws_b", dispatch: "d_2", breakdown: { normal: 4, ot_15: 0, ot_20: 0 }, start_time: "12:00", end_time: "16:00" });
  let r = consolidate(monthly(), db);
  assert.equal(r.lines[0].normal, 8);
  assert.deepEqual(r.lines[0].sources.map((s) => s.record_id).sort(), ["ws_a", "ws_b"]);
  assert.equal(find(r, C.MULTIPLE_JOBS_SAME_DATE).severity, "info");

  db.field_worksheets[1].start_time = "09:00"; db.field_worksheets[1].end_time = "13:00";
  r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.equal(find(r, C.OVERLAPPING_JOBS).severity, "blocking");

  db.field_worksheets[1].start_time = ""; db.field_worksheets[1].end_time = "";
  r = consolidate(monthly(), db);
  assert.equal(find(r, C.MULTIPLE_JOBS_SAME_DATE).severity, "warning");
  assert.equal(r.lines[0].normal, 8);

  db.field_worksheets[0].hours_breakdown = { normal: 20, ot_15: 0, ot_20: 0 }; db.field_worksheets[1].hours_breakdown = { normal: 6, ot_15: 0, ot_20: 0 };
  assert.ok(codes(consolidate(monthly(), db)).includes(C.HOURS_EXCEED_24));
});

test("Timesheet takes precedence over legacy Daily Time Sheet and Contractor Log for the same worker/date: no double count", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", date: "2026-09-01", breakdown: { normal: 9, ot_15: 0, ot_20: 0 } });
  addDaily(db, { id: "dts_old", entries: [row("2026-09-01", 9)] });
  addContractorLog(db, { id: "cls_old", log_date: "2026-09-01", rows: [clRow("Test Worker One", 9)] });
  const roster = [{ key: "t_u_tech1", technician_id: "u_tech1", display_name: "Test Worker One", group: "" }];
  let r = consolidate(monthly({ roster }), db);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].normal, 9, "9, not 18 or 27");
  assert.deepEqual(r.lines[0].sources.map((s) => s.source_type), [TS]);
  assert.deepEqual(r.lines[0].evidence.legacy_daily, ["dts_old"]);
  assert.deepEqual(r.lines[0].evidence.contractor_logs, ["cls_old"]);
  assert.equal(find(r, C.LEGACY_SOURCE_SUPERSEDED).severity, "info");
  db.daily_timesheets[0].entries[0].normal_hours = 7;
  assert.equal(find(consolidate(monthly({ roster }), db), C.LEGACY_SOURCE_SUPERSEDED).severity, "warning", "different legacy hours need a person to look");
});

test("a contractor without an account is matched by name on the roster and counted from their Timesheet", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_c", technician_id: null, worker_name: "Walk In Worker", date: "2026-09-01" });
  const roster = [{ key: "n_walk_in_worker", technician_id: null, display_name: "walk  in WORKER", group: "" }];
  const r = consolidate(monthly({ roster }), db);
  assert.equal(r.lines.length, 1);
  assert.deepEqual(r.lines[0].sources.map((s) => s.record_id), ["ws_c"]);
});

test("a superseded Timesheet (replaced by a revision) is ignored; the revision is what counts", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_old", date: "2026-09-01", superseded_by: "ws_new", breakdown: { normal: 9, ot_15: 0, ot_20: 0 } });
  addTimesheet(db, { id: "ws_new", date: "2026-09-01", breakdown: { normal: 8, ot_15: 0, ot_20: 0 } });
  const r = consolidate(monthly(), db);
  assert.equal(r.lines[0].normal, 8);
  assert.equal(blockingExceptions(r.exceptions).length, 0);
});

test("same worker/date on another live Worksheet from the SAME kind (another client's dispatch) is allowed; from a different kind it blocks", () => {
  const db = makeDb();
  addTimesheet(db, { id: "ws_a", date: "2026-09-01" });
  const other = { id: "wks_other", reference: "WKS-X", status: "Approved", roster: roster2, lines: [{ roster_key: "t_u_tech1", date: "2026-09-01", sources: [{ source_type: TS, record_id: "ws_other_client", row_index: 0 }] }] };
  db.worksheet_registers.push(other);
  assert.equal(consolidate(monthly(), db).lines.length, 1);
  other.lines[0].sources = [{ source_type: D, record_id: "dts_x", row_index: 0 }];
  const r = consolidate(monthly(), db);
  assert.equal(r.lines.length, 0);
  assert.equal(find(r, C.WORKER_DATE_CLAIMED_ELSEWHERE).severity, "blocking");
});

test("Timesheet lineage: a changed hour, a lost sign-off or a superseding revision after consolidation is detected", () => {
  const db = makeDb();
  const ws = addTimesheet(db, { id: "ws_a", date: "2026-09-01" });
  const r = consolidate(monthly(), db);
  const rec = { ...monthly(), lines: r.lines };
  assert.deepEqual(verifySourceLineage(rec, db), []);
  ws.hours_breakdown = { normal: 10, ot_15: 0, ot_20: 0 };
  assert.match(verifySourceLineage(rec, db)[0].reason, /changed/);
  ws.hours_breakdown = { normal: 9, ot_15: 0, ot_20: 0 }; ws.client_acknowledgement = null;
  assert.match(verifySourceLineage(rec, db)[0].reason, /sign-off/);
  ws.client_acknowledgement = { acknowledged_at: "t" }; ws.superseded_by = "ws_rev";
  assert.match(verifySourceLineage(rec, db)[0].reason, /superseded/);
});

test("Timesheet model: breakdown rules, X means zero, total must be 1-24, times valid", () => {
  assert.deepEqual(normaliseBreakdown({ normal: 8, ot_15: "X", ot_20: null }), { ok: true, breakdown: { normal: 8, ot_15: 0, ot_20: 0 }, total: 8 });
  assert.equal(normaliseBreakdown({ normal: 0, ot_15: 0, ot_20: 0 }).ok, false);
  assert.equal(normaliseBreakdown({ normal: 20, ot_15: 5 }).ok, false);
  assert.equal(normaliseBreakdown({ normal: -1 }).ok, false);
  assert.equal(normaliseBreakdown({ normal: "abc" }).ok, false);
  assert.equal(classifyTimesheet({ timesheet_version: 2, work_date: "2026-09-01", hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 }, activity: "x", start_time: "10:00", end_time: "09:00" }).flags.some((f) => f.code === "INVALID_TIMES" && f.severity === "blocking"), true);
  assert.equal(classifyTimesheet({ work_date: "2026-09-01", hours: 8 }).flags[0].code, "LEGACY_NO_BREAKDOWN");
});

test("approved coverage lookup tells a later billing step which worker/dates are already covered", () => {
  const db = makeDb();
  db.worksheet_registers.push({ id: "wks_a", reference: "R", status: "Approved", roster: roster2, lines: [{ roster_key: "t_u_tech1", date: "2026-09-01", normal: 9, ot_15: 0, ot_20: 0 }] });
  db.worksheet_registers.push({ id: "wks_b", reference: "R2", status: "Draft", roster: roster2, lines: [{ roster_key: "t_u_tech1", date: "2026-09-01", normal: 9, ot_15: 0, ot_20: 0 }] });
  assert.equal(findApprovedRegisterCoverage(db, { technician_id: "u_tech1", date: "2026-09-01" }).length, 1);
  assert.deepEqual(findApprovedRegisterCoverage(db, { technician_id: "u_tech2", date: "2026-09-01" }), []);
});
