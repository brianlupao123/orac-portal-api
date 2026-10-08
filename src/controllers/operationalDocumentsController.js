import { roles } from "../permissions.js";
import { scopeOperationalData } from "./coreController.js";
import { computeInvoiceReadyReport } from "../reports.js";
import { isEligibleForDb } from "../timesheetEligibility.js";

function deny(res, message) { return res.status(403).json({ success: false, message }); }
function getActor(req) { return req.user?.id ? req.db.users.find((user) => user.id === req.user.id) : null; }

export function getDailyTaskReport(req, res) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN];
  if (!actor?.is_active || !allowed.includes(actor.role)) return deny(res, "Role cannot view daily task reports.");
  const dispatches = scopeOperationalData(req.db.dispatch_cards, "dispatch_cards", actor, req.db);
  const worksheets = scopeOperationalData(req.db.field_worksheets, "field_worksheets", actor, req.db);
  return res.json({ success: true, data: { generated_for: actor.id, dispatches, worksheets } });
}

export function getInvoiceReadySummary(req, res) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE];
  if (!actor?.is_active || !allowed.includes(actor.role)) return deny(res, "Role cannot view invoice-ready summaries.");
  return res.json({ success: true, data: { items: computeInvoiceReadyReport(req.db) } });
}

export function getClientCompletionRecord(req, res) {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.CLIENT_VIEWER];
  if (!actor?.is_active || !allowed.includes(actor.role)) return deny(res, "Role cannot view completion records.");
  if (actor.role === roles.CLIENT_VIEWER && !actor.client_id) return deny(res, "Client Viewer is not linked to a client account.");
  const worksheet = req.db.field_worksheets.find((item) => item.id === req.params.id);
  if (!worksheet) return res.status(404).json({ success: false, message: "Timesheet not found." });
  const dispatch = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  const quote = dispatch && req.db.quotes.find((item) => item.id === dispatch.quotation_id);
  const clientId = quote?.client_id;
  if (actor.role === roles.CLIENT_VIEWER && actor.client_id !== clientId) return deny(res, "Client Viewer cannot access another client's completion record.");
  if (actor.role === roles.TECHNICIAN && worksheet.technician_id !== actor.id) return deny(res, "Technician can only view assigned completion records.");
  if (actor.role === roles.SUPERVISOR && dispatch?.assigned_supervisor_id !== actor.id && worksheet.supervisor_id !== actor.id) return deny(res, "Supervisor can only view assigned completion records.");
  if (!isEligibleForDb(req.db, worksheet)) return res.status(409).json({ success: false, message: "Completion record requires a supervisor-approved worksheet." });
  return res.json({ success: true, data: { worksheet, dispatch, quote, client: req.db.clients.find((item) => item.id === clientId) || null } });
}
