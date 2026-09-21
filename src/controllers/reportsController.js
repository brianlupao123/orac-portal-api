import { roles } from "../permissions.js";
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
