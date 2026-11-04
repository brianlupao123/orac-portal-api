import test from "node:test";
import assert from "node:assert/strict";

import { computeTechnicianPayroll, buildPastelPayrollCsv, PASTEL_HEADERS, isPayrollMonth } from "../src/payroll.js";
import { computeTotals, buildGridView } from "../src/worksheetRegisterLogic.js";
import { getTechnicianPayrollReport, exportTechnicianPayrollPastel } from "../src/controllers/reportsController.js";
import { makeRes, makeReq } from "./_http.js";

const r2 = (n) => Math.round(n * 100) / 100;

const line = (roster_key, date, normal, ot_15 = 0, ot_20 = 0, extra = {}) => ({
  roster_key, date, carry_over: false, normal, ot_15, ot_20,
  sources: [{ source_type: "timesheet", record_id: "ws1", row_index: 0 }], ...extra
});

function makeDb() {
  return {
    users: [
      { id: "u_fin", name: "Fin", role: "Finance", is_active: true },
      { id: "u_mgmt", name: "Mgmt", role: "Management", is_active: true },
      { id: "u_ops", name: "Ops", role: "Operations", is_active: true },
      { id: "u_admin", name: "Admin", role: "Admin", is_active: true },
      { id: "t1", name: "Tendai Moyo", role: "Technician", is_active: true, trade: "Fitter", national_id: "63-123456 K 42", employee_code: "E001" },
      { id: "t2", name: "Blessing Ncube", role: "Technician", is_active: true, trade: "Electrician", national_id: "08-765432 Z 19" }
    ],
    dispatch_cards: [{ id: "d1", dispatch_number: "DSP-001" }, { id: "d2", dispatch_number: "DSP-002" }],
    field_worksheets: [{ id: "ws1", dispatch_card_id: "d1" }, { id: "ws2", dispatch_card_id: "d2" }],
    worksheet_registers: [
      {
        id: "r1", reference: "WS-2026-10", status: "Approved",
        period: { start: "2026-10-01", end: "2026-10-31" },
        roster: [
          { key: "t_t1", technician_id: "t1", display_name: "Tendai Moyo" },
          { key: "t_t2", technician_id: "t2", display_name: "Blessing Ncube" }
        ],
        lines: [
          line("t_t1", "2026-10-05", 8, 1),         // Mon
          line("t_t1", "2026-10-06", 8),
          line("t_t1", "2026-10-10", 4, 4),         // Sat
          line("t_t1", "2026-10-11", 0, 0, 6),      // Sun
          line("t_t2", "2026-10-05", 8.5, 0.5),
          line("t_t2", "2026-10-12", 7.25),
          // carry-over from September: belongs to September payroll, not October
          line("t_t1", "2026-09-30", 8, 0, 0, { carry_over: true })
        ]
      },
      { id: "r_draft", reference: "WS-DRAFT", status: "Draft", period: { start: "2026-10-01", end: "2026-10-31" },
        roster: [{ key: "t_t1", technician_id: "t1", display_name: "Tendai Moyo" }], lines: [line("t_t1", "2026-10-20", 99)] },
      { id: "r_cancel", reference: "WS-CANCEL", status: "Cancelled", period: { start: "2026-10-01", end: "2026-10-31" },
        roster: [{ key: "t_t1", technician_id: "t1", display_name: "Tendai Moyo" }], lines: [line("t_t1", "2026-10-21", 99)] }
    ]
  };
}

test("isPayrollMonth accepts only YYYY-MM", () => {
  assert.equal(isPayrollMonth("2026-10"), true);
  for (const bad of ["2026-13", "2026-00", "2026-1", "2026-10-01", "", undefined, "abcd-ef"]) assert.equal(isPayrollMonth(bad), false);
});

test("payroll per employee equals the Worksheet register's own totals for that month", () => {
  const db = makeDb();
  const reg = db.worksheet_registers[0];
  const payroll = computeTechnicianPayroll(db, "2026-10");

  // Independent reference: the register's own computeTotals() over October lines only.
  const octLines = reg.lines.filter((l) => l.date.startsWith("2026-10"));
  const ref = computeTotals(octLines, reg.roster);
  for (const emp of payroll.employees) {
    const key = `t_${emp.technician_id}`;
    assert.equal(emp.normal_hours, ref.by_employee[key].normal, `${emp.full_name} normal`);
    assert.equal(emp.overtime_15_hours, ref.by_employee[key].ot_15, `${emp.full_name} 1.5`);
    assert.equal(emp.overtime_20_hours, ref.by_employee[key].ot_20, `${emp.full_name} 2.0`);
    assert.equal(emp.total_hours, ref.by_employee[key].total_hours, `${emp.full_name} total`);
  }
  assert.equal(payroll.totals.total_hours, ref.grand.total_hours);
  assert.equal(payroll.totals.normal_hours, ref.grand.normal);

  // Hand-computed values (guards against the reference and the code sharing a bug).
  const tendai = payroll.employees.find((e) => e.technician_id === "t1");
  assert.deepEqual(
    [tendai.normal_hours, tendai.overtime_15_hours, tendai.overtime_20_hours, tendai.total_hours, tendai.days_worked],
    [20, 5, 6, 31, 4]
  );
  const blessing = payroll.employees.find((e) => e.technician_id === "t2");
  assert.deepEqual(
    [blessing.normal_hours, blessing.overtime_15_hours, blessing.overtime_20_hours, blessing.total_hours, blessing.days_worked],
    [15.75, 0.5, 0, 16.25, 2]
  );
});

test("payroll matches the register grid view row totals (what the supervisor signed)", () => {
  const db = makeDb();
  const reg = db.worksheet_registers[0];
  const grid = buildGridView({ ...reg, lines: reg.lines.filter((l) => !l.carry_over) });
  const payroll = computeTechnicianPayroll(db, "2026-10");
  for (const row of grid.rows) {
    const emp = payroll.employees.find((e) => e.technician_id === row.technician_id);
    assert.equal(emp.normal_hours, row.totals.normal);
    assert.equal(emp.overtime_15_hours, row.totals.ot_15);
    assert.equal(emp.overtime_20_hours, row.totals.ot_20);
  }
});

test("only Approved registers count and the month is taken from the work date", () => {
  const db = makeDb();
  const oct = computeTechnicianPayroll(db, "2026-10");
  assert.equal(oct.totals.total_hours, 47.25); // draft 99h and cancelled 99h excluded, 30 Sep excluded
  assert.deepEqual(oct.source_registers, ["WS-2026-10"]);

  const sep = computeTechnicianPayroll(db, "2026-09");
  assert.equal(sep.employees.length, 1);
  assert.equal(sep.employees[0].normal_hours, 8);

  assert.equal(computeTechnicianPayroll(db, "2026-08").employees.length, 0);
});

test("same worker and date in two Approved registers is counted once with a warning", () => {
  const db = makeDb();
  db.worksheet_registers.push({
    id: "r2", reference: "WS-OVERLAP", status: "Approved", period: { start: "2026-10-05", end: "2026-10-06" },
    roster: [{ key: "t_t1", technician_id: "t1", display_name: "Tendai Moyo" }],
    lines: [line("t_t1", "2026-10-05", 8, 1), line("t_t1", "2026-10-07", 8)]
  });
  const payroll = computeTechnicianPayroll(db, "2026-10");
  const tendai = payroll.employees.find((e) => e.technician_id === "t1");
  assert.equal(tendai.normal_hours, 28); // 20 + only the new 7 Oct day
  assert.equal(tendai.days_worked, 5);
  assert.equal(payroll.warnings.length, 1);
  assert.equal(payroll.warnings[0].code, "DUPLICATE_WORKER_DATE");
});

test("floating point sums are rounded like the register (no 0.1 + 0.2 drift)", () => {
  const db = makeDb();
  db.worksheet_registers[0].lines = [line("t_t1", "2026-10-01", 0.1), line("t_t1", "2026-10-02", 0.2), line("t_t1", "2026-10-03", 0.7)];
  const emp = computeTechnicianPayroll(db, "2026-10").employees[0];
  assert.equal(emp.normal_hours, 1);
  assert.equal(emp.total_hours, r2(0.1 + 0.2 + 0.7));
});

test("employees without a payroll code are flagged and unlinked workers cannot be exported", () => {
  const db = makeDb();
  db.users.find((u) => u.id === "t2").national_id = null;
  db.worksheet_registers[0].roster.push({ key: "n_sam", technician_id: null, display_name: "Sam Contractor" });
  db.worksheet_registers[0].lines.push(line("n_sam", "2026-10-08", 8));
  const payroll = computeTechnicianPayroll(db, "2026-10");
  assert.equal(payroll.employees.find((e) => e.technician_id === "t1").export_ready, true);
  const blessing = payroll.employees.find((e) => e.technician_id === "t2");
  assert.equal(blessing.export_ready, false);
  const sam = payroll.employees.find((e) => e.full_name === "Sam Contractor");
  assert.equal(sam.export_ready, false);
  assert.equal(sam.export_blockers.length, 2);
});

test("Pastel CSV rows add back up to the payroll totals, one row per day and pay code", () => {
  const db = makeDb();
  const payroll = computeTechnicianPayroll(db, "2026-10");
  const csv = buildPastelPayrollCsv(payroll);
  const rows = csv.trim().split("\r\n").map((l) => l.split(","));
  assert.deepEqual(rows[0], PASTEL_HEADERS);
  const data = rows.slice(1);
  assert.ok(data.every((r) => r.length === 5));

  const sum = (code) => r2(data.filter((r) => r[2] === code).reduce((s, r) => s + Number(r[3]), 0));
  assert.equal(sum("NORMAL"), payroll.totals.normal_hours);
  assert.equal(sum("OT15"), payroll.totals.overtime_15_hours);
  assert.equal(sum("OT20"), payroll.totals.overtime_20_hours);

  // Employee code wins over national ID; falls back to national ID when there is no code.
  assert.ok(data.some((r) => r[0] === "E001" && r[1] === "2026-10-05" && r[2] === "NORMAL" && r[3] === "8.00" && r[4] === "DSP-001"));
  assert.ok(data.some((r) => r[0] === "08-765432 Z 19" && r[1] === "2026-10-12" && r[3] === "7.25"));
  // No zero-hour rows.
  assert.ok(data.every((r) => Number(r[3]) > 0));
});

test("Pastel CSV pay codes can be overridden and the header can be dropped", () => {
  const payroll = computeTechnicianPayroll(makeDb(), "2026-10");
  const csv = buildPastelPayrollCsv(payroll, { header: false, codes: { normal: "N", ot_15: "O15", ot_20: "O20" } });
  assert.ok(!csv.startsWith("EmployeeCode"));
  assert.ok(csv.includes(",N,"));
  assert.ok(csv.includes(",O15,"));
});

test("Pastel CSV neutralises spreadsheet formulas in codes", () => {
  const db = makeDb();
  db.users.find((u) => u.id === "t1").employee_code = "=HYPERLINK(\"x\")";
  const csv = buildPastelPayrollCsv(computeTechnicianPayroll(db, "2026-10"));
  assert.ok(!/^=/m.test(csv));
  assert.ok(csv.includes("'=HYPERLINK"));
});

// ---- HTTP handlers ----
function call(handler, { userId, query = {}, db }) {
  const audits = [];
  const store = { audit: (...a) => audits.push(a) };
  const res = makeRes();
  res.header = (k, v) => res.setHeader(k, v);
  res.send = (b) => { res.body = b; return res; };
  const req = { ...makeReq({ method: "GET", db, store, user: { id: userId } }), query };
  handler(req, res);
  return { res, audits };
}

test("report endpoint: Finance, Admin and Management may read; Operations may not", () => {
  for (const id of ["u_fin", "u_admin", "u_mgmt"]) {
    const { res } = call(getTechnicianPayrollReport, { userId: id, query: { month: "2026-10" }, db: makeDb() });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.employees.length, 2);
    assert.equal(res.body.data.employees[0].daily, undefined);
  }
  assert.throws(() => call(getTechnicianPayrollReport, { userId: "u_ops", query: { month: "2026-10" }, db: makeDb() }), (e) => e.status === 403);
});

test("report endpoint rejects a missing or malformed month", () => {
  for (const month of [undefined, "2026-13", "October"]) {
    const { res } = call(getTechnicianPayrollReport, { userId: "u_fin", query: { month }, db: makeDb() });
    assert.equal(res.statusCode, 400);
  }
});

test("export: Finance downloads an audited, non-posting CSV; Management cannot export", () => {
  const db = makeDb();
  db.users.find((u) => u.id === "t2").employee_code = "E002";
  const { res, audits } = call(exportTechnicianPayrollPastel, { userId: "u_fin", query: { month: "2026-10" }, db });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(res.headers["content-disposition"], /orac-pastel-payroll-2026-10\.csv/);
  assert.ok(res.body.startsWith("EmployeeCode/ID,Date,PayCode,Hours,ProjectCode"));
  assert.equal(audits.length, 1);
  assert.equal(audits[0][4], "PASTEL_PAYROLL_EXPORT_GENERATED");
  assert.equal(audits[0][6].accounting_posted, false);
  assert.equal(audits[0][6].totals.total_hours, 47.25);
  assert.ok(!JSON.stringify(audits[0][6]).includes("63-123456"), "national ID must not enter the audit payload");

  assert.throws(() => call(exportTechnicianPayrollPastel, { userId: "u_mgmt", query: { month: "2026-10" }, db: makeDb() }), (e) => e.status === 403);
});

test("export is refused (422) when someone has no payroll code, and 404 when the month is empty", () => {
  const db = makeDb();
  db.users.find((u) => u.id === "t2").national_id = null;
  const blocked = call(exportTechnicianPayrollPastel, { userId: "u_fin", query: { month: "2026-10" }, db });
  assert.equal(blocked.res.statusCode, 422);
  assert.equal(blocked.res.body.blocked[0].full_name, "Blessing Ncube");
  assert.equal(blocked.audits.length, 0);

  const empty = call(exportTechnicianPayrollPastel, { userId: "u_fin", query: { month: "2025-01" }, db: makeDb() });
  assert.equal(empty.res.statusCode, 404);
});
