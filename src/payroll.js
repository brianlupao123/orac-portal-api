// Technician payroll summary + Sage Pastel batch export - pure logic, no req/res.
//
// Finance pays technicians from the SAME certified hours the Worksheet register
// already holds. Nothing here re-keys, re-classifies or re-weights hours:
//   * Source  = lines of Worksheet registers whose status is Approved
//               (Supervisor-reviewed, all sign-offs, reconciled lineage).
//   * Month   = the calendar month of each line's WORK DATE. A register may span
//               a different period (or carry over dates), so lines are filtered
//               by date, not by register period.
//   * Hours   = the register's own Normal / 1.5 / 2.0 values, summed with the same
//               2-decimal rounding as computeTotals(). No weighting, no rates, no
//               amounts (the weighting formula is still owner decision OD-04).
//   * Same worker + date appearing in two Approved registers is counted ONCE
//               (first register wins) and reported in `warnings`, never doubled.

import { REGISTER_STATUS, normaliseName } from "./worksheetRegisterLogic.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPayrollMonth = (v) => MONTH_PATTERN.test(String(v || ""));

// Pay codes are company-defined in Pastel Payroll; defaults can be overridden
// without a code change (process env), e.g. PASTEL_PAYCODE_OT15=OT1.5.
export function pastelPayCodes(env = process.env) {
  return {
    normal: env.PASTEL_PAYCODE_NORMAL || "NORMAL",
    ot_15: env.PASTEL_PAYCODE_OT15 || "OT15",
    ot_20: env.PASTEL_PAYCODE_OT20 || "OT20"
  };
}

export const PASTEL_HEADERS = ["EmployeeCode/ID", "Date", "PayCode", "Hours", "ProjectCode"];

function csvEscape(value) {
  let text = String(value ?? "");
  // Neutralise spreadsheet formulas in text cells; real numbers are untouched.
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Dispatch number for a worksheet line, only when every counted Timesheet source
// points at the SAME dispatch. Mixed or non-Timesheet sources give "" (a cell's
// hours are a single total, so they cannot be split between jobs honestly).
function projectCodeFor(db, line) {
  const codes = new Set();
  for (const s of line.sources || []) {
    if (s.source_type !== "timesheet") return "";
    const ws = (db.field_worksheets || []).find((w) => w.id === s.record_id);
    const job = ws && (db.dispatch_cards || []).find((d) => d.id === ws.dispatch_card_id);
    if (!job?.dispatch_number) return "";
    codes.add(job.dispatch_number);
  }
  return codes.size === 1 ? [...codes][0] : "";
}

function monthOf(date) {
  return String(date || "").slice(0, 7);
}

// -> { month, basis, employees: [...], totals, warnings, source_registers }
export function computeTechnicianPayroll(db, month) {
  const registers = (db.worksheet_registers || [])
    .filter((r) => r.status === REGISTER_STATUS.APPROVED)
    .slice()
    .sort((a, b) => String(a.period?.start || "").localeCompare(String(b.period?.start || "")) || String(a.id).localeCompare(String(b.id)));

  const warnings = [];
  const seen = new Map(); // identity|date -> register reference
  const byEmployee = new Map();
  const usedRegisters = new Set();

  for (const reg of registers) {
    const rosterByKey = new Map((reg.roster || []).map((r) => [r.key, r]));
    for (const line of reg.lines || []) {
      if (monthOf(line.date) !== month) continue;
      const entry = rosterByKey.get(line.roster_key);
      if (!entry) continue;
      const identity = entry.technician_id ? `t:${entry.technician_id}` : `n:${normaliseName(entry.display_name)}`;
      const cellKey = `${identity}|${line.date}`;
      if (seen.has(cellKey)) {
        warnings.push({
          code: "DUPLICATE_WORKER_DATE",
          message: `${entry.display_name} on ${line.date} is in both ${seen.get(cellKey)} and ${reg.reference || reg.id}. Counted once (${seen.get(cellKey)}).`
        });
        continue;
      }
      seen.set(cellKey, reg.reference || reg.id);
      usedRegisters.add(reg.reference || reg.id);

      let emp = byEmployee.get(identity);
      if (!emp) {
        const user = entry.technician_id ? (db.users || []).find((u) => u.id === entry.technician_id) : null;
        emp = {
          technician_id: entry.technician_id || null,
          full_name: user?.name || entry.display_name,
          national_id: user?.national_id || null,
          employee_code: user?.employee_code || null,
          trade: user?.trade || null,
          normal_hours: 0, overtime_15_hours: 0, overtime_20_hours: 0, total_hours: 0,
          days: new Set(),
          daily: []
        };
        byEmployee.set(identity, emp);
      }
      const n = r2(line.normal || 0); const a = r2(line.ot_15 || 0); const b = r2(line.ot_20 || 0);
      emp.normal_hours = r2(emp.normal_hours + n);
      emp.overtime_15_hours = r2(emp.overtime_15_hours + a);
      emp.overtime_20_hours = r2(emp.overtime_20_hours + b);
      emp.total_hours = r2(emp.normal_hours + emp.overtime_15_hours + emp.overtime_20_hours);
      if (n + a + b > 0) emp.days.add(line.date);
      emp.daily.push({ date: line.date, normal: n, ot_15: a, ot_20: b, project_code: projectCodeFor(db, line) });
    }
  }

  const employees = [...byEmployee.values()]
    .map((e) => {
      const payrollCode = e.employee_code || e.national_id || null;
      const missing = [];
      if (!e.technician_id) missing.push("Not linked to a Technician account");
      if (!payrollCode) missing.push("No employee code or national ID on file");
      return {
        technician_id: e.technician_id,
        full_name: e.full_name,
        national_id: e.national_id,
        employee_code: e.employee_code,
        payroll_code: payrollCode,
        trade: e.trade,
        normal_hours: e.normal_hours,
        overtime_15_hours: e.overtime_15_hours,
        overtime_20_hours: e.overtime_20_hours,
        total_hours: e.total_hours,
        days_worked: e.days.size,
        export_ready: missing.length === 0,
        export_blockers: missing,
        daily: e.daily.sort((x, y) => x.date.localeCompare(y.date))
      };
    })
    .sort((x, y) => x.full_name.localeCompare(y.full_name));

  const totals = employees.reduce((t, e) => ({
    normal_hours: r2(t.normal_hours + e.normal_hours),
    overtime_15_hours: r2(t.overtime_15_hours + e.overtime_15_hours),
    overtime_20_hours: r2(t.overtime_20_hours + e.overtime_20_hours),
    total_hours: r2(t.total_hours + e.total_hours),
    days_worked: t.days_worked + e.days_worked
  }), { normal_hours: 0, overtime_15_hours: 0, overtime_20_hours: 0, total_hours: 0, days_worked: 0 });

  return {
    month,
    basis: "Approved Worksheet registers, by work date",
    hours_only: true,
    employees,
    totals,
    warnings,
    source_registers: [...usedRegisters].sort()
  };
}

// Pastel batch: one row per employee x date x pay code with hours > 0.
export function buildPastelPayrollCsv(payroll, { header = true, codes = pastelPayCodes() } = {}) {
  const rows = header ? [PASTEL_HEADERS] : [];
  for (const emp of payroll.employees) {
    for (const d of emp.daily) {
      for (const [bucket, hours] of [["normal", d.normal], ["ot_15", d.ot_15], ["ot_20", d.ot_20]]) {
        if (!(hours > 0)) continue;
        rows.push([emp.payroll_code, d.date, codes[bucket], hours.toFixed(2), d.project_code || ""]);
      }
    }
  }
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

// Internal labour cost computation (for commercial margin analysis and Finance reconciliation).
// Takes a payroll summary and a rate card (hourly base rate per trade or technician),
// applying standard OT multipliers (1.5x for OT15, 2.0x for OT20).
// Fails closed: missing rates throw an Error rather than silently defaulting.
export function computeLabourCost(payroll, rateCard = {}, { ot_15_multiplier = 1.5, ot_20_multiplier = 2.0 } = {}) {
  const m15 = Number(ot_15_multiplier);
  const m20 = Number(ot_20_multiplier);
  if (!Number.isFinite(m15) || m15 <= 0 || !Number.isFinite(m20) || m20 <= 0) {
    throw new Error("Invalid overtime multipliers: multipliers must be finite numbers greater than zero.");
  }

  let totalCost = 0;
  const byEmployee = [];

  for (const emp of payroll.employees || []) {
    const rawRate = rateCard[emp.technician_id] ?? (emp.trade ? rateCard[emp.trade] : undefined);
    if (rawRate === undefined || rawRate === null || rawRate === "") {
      throw new Error(`Missing wage rate for technician ${emp.full_name || emp.technician_id} (trade: ${emp.trade || "unspecified"}). A configured Finance rate is required.`);
    }
    const numRate = Number(rawRate);
    if (!Number.isFinite(numRate) || numRate <= 0) {
      throw new Error(`Invalid wage rate (${rawRate}) for technician ${emp.full_name || emp.technician_id}: wage rates must be finite numbers greater than zero.`);
    }
    const normalCost = r2(emp.normal_hours * numRate);
    const ot15Cost = r2(emp.overtime_15_hours * (numRate * m15));
    const ot20Cost = r2(emp.overtime_20_hours * (numRate * m20));
    const empTotal = r2(normalCost + ot15Cost + ot20Cost);
    totalCost = r2(totalCost + empTotal);
    byEmployee.push({
      technician_id: emp.technician_id,
      trade: emp.trade,
      base_rate: numRate,
      normal_cost: normalCost,
      ot_15_cost: ot15Cost,
      ot_20_cost: ot20Cost,
      total_cost: empTotal
    });
  }

  return { total_cost: totalCost, employees: byEmployee };
}

