import { roles } from "../permissions.js";
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
    res.json({ success: true, data: computeFn(req.db) });
  };
}

export const getPipelineReport = makeReportHandler("pipeline", computePipelineReport);
export const getPoComplianceReport = makeReportHandler("po-compliance", computePoComplianceReport);
export const getDispatchReport = makeReportHandler("dispatch", computeDispatchReport);
export const getWorksheetReport = makeReportHandler("worksheets", computeWorksheetReport);
export const getInvoiceReadyReport = makeReportHandler("invoice-ready", computeInvoiceReadyReport);
export const getVarianceReport = makeReportHandler("variance", computeVarianceReport);
