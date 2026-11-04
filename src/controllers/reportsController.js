import { roles, requirePermission } from "../permissions.js";
import { computeTechnicianPayroll, buildPastelPayrollCsv, isPayrollMonth } from "../payroll.js";
import { scopeOperationalData } from "./coreController.js";
import {
  computePipelineReport,
  computePoComplianceReport,
  computeDispatchReport,
  computeWorksheetReport,
  computeInvoiceReadyReport,
  computeVarianceReport
} from "../reports.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

const reportGuards = {
  pipeline: [roles.ADMIN, roles.MANAGEMENT, roles.SALES],
  "po-compliance": [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS],
  dispatch: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR],
  worksheets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR],
  "invoice-ready": [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  variance: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE, roles.OPERATIONS]
};

export function scopeDbForReport(db, actor) {
  if (actor?.role !== roles.SUPERVISOR) return db;

  return {
    ...db,
    dispatch_cards: scopeOperationalData(db.dispatch_cards, "dispatch_cards", actor, db),
    field_worksheets: scopeOperationalData(db.field_worksheets, "field_worksheets", actor, db)
  };
}

function makeReportHandler(reportKey, computeFn) {
  return (req, res) => {
    const actor = getActor(req);
    const allowedRoles = reportGuards[reportKey];
    if (!actor?.is_active || !allowedRoles.includes(actor.role)) {
      return res.status(403).json({
        success: false,
        message: `Role ${actor?.role || "Unknown"} cannot view the ${reportKey} report.`
      });
    }
    res.json({ success: true, data: computeFn(scopeDbForReport(req.db, actor)) });
  };
}

export const getPipelineReport = makeReportHandler("pipeline", computePipelineReport);
export const getPoComplianceReport = makeReportHandler("po-compliance", computePoComplianceReport);
export const getDispatchReport = makeReportHandler("dispatch", computeDispatchReport);
export const getWorksheetReport = makeReportHandler("worksheets", computeWorksheetReport);
export const getInvoiceReadyReport = makeReportHandler("invoice-ready", computeInvoiceReadyReport);
export const getVarianceReport = makeReportHandler("variance", computeVarianceReport);

// ---- Technician payroll (Finance) ----
const monthProblem = (req) => (isPayrollMonth(req.query?.month) ? null : "month is required in YYYY-MM format.");

export function getTechnicianPayrollReport(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "viewTechnicianPayroll");
  const problem = monthProblem(req);
  if (problem) return res.status(400).json({ success: false, message: problem });
  const payroll = computeTechnicianPayroll(req.db, req.query.month);
  // National ID is Finance/Admin/Management payroll data; the per-day lines are export detail only.
  const employees = payroll.employees.map(({ daily, ...row }) => row);
  res.json({ success: true, data: { ...payroll, employees } });
}

export function exportTechnicianPayrollPastel(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "exportPastel");
  const problem = monthProblem(req);
  if (problem) return res.status(400).json({ success: false, message: problem });
  const month = req.query.month;
  const payroll = computeTechnicianPayroll(req.db, month);
  if (payroll.employees.length === 0) {
    return res.status(404).json({ success: false, message: `No approved Worksheet hours found for ${month}.` });
  }
  const blocked = payroll.employees.filter((e) => !e.export_ready);
  if (blocked.length) {
    return res.status(422).json({
      success: false,
      message: "Some employees cannot be exported to Pastel. Fix them first so nobody has to be re-typed.",
      blocked: blocked.map((e) => ({ full_name: e.full_name, reasons: e.export_blockers }))
    });
  }
  const csv = buildPastelPayrollCsv(payroll, { header: req.query.header !== "0" });
  req.store.audit(req.db, actor, "pastel_export", "technician_payroll", "PASTEL_PAYROLL_EXPORT_GENERATED", null, {
    export_type: "technician_payroll",
    month,
    accounting_posted: false,
    employee_count: payroll.employees.length,
    row_count: Math.max(0, csv.split("\r\n").filter(Boolean).length - (req.query.header === "0" ? 0 : 1)),
    totals: payroll.totals,
    source_registers: payroll.source_registers
  });
  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Content-Disposition", `attachment; filename=orac-pastel-payroll-${month}.csv`);
  res.send(csv);
}
