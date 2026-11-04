import { requirePermission, roles } from "../permissions.js";
import { validateDailyTimesheetEntries, voidStartIndex } from "../dailyTimesheetValidation.js";
import {
  PAPER_SOURCE, isPaperEntry, paperEntryCreateRefusal, stampPaperEntry, paperEntryUpdateRefusal, applyPaperEntryUpdate
} from "../paperEntry.js";
import { isTechnicianRecord, technicianDisplayName } from "../technicianProfiles.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function deny(res, message) {
  return res.status(403).json({ success: false, message });
}

/** Admin/Operations/Supervisor may act on anyone's sheet; a Technician only ever their own; Sales only the paper entries it created. */
function canActOnOwnerRecord(actor, record) {
  if (actor.role === roles.SALES) return isPaperEntry(record) && record.created_by === actor.id;
  if ([roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR, roles.MANAGEMENT].includes(actor.role)) return true;
  return record.technician_id === actor.id;
}

export const createDailyTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createDailyTimesheet");

  const body = req.body;
  // Sales Desk paper entry: Sales enters signed paper under its own account and may only send paper entries.
  const paperError = paperEntryCreateRefusal(actor, body);
  if (paperError) return res.status(400).json({ success: false, code: "PAPER_ENTRY_INVALID", message: paperError });
  // A Technician can only ever file their own sheet; staff roles may file on
  // behalf of a crew member (parallel to how the kiosk batches technician time).
  const technicianId = actor.role === roles.TECHNICIAN ? actor.id : (body.technician_id || null);
  // The technician is either a registered Technician user or a password-less
  // artisan staff profile (see technicianProfiles.js). Inactive ones are refused.
  let technician = null;
  if (technicianId) {
    technician = req.db.users.find((user) => user.id === technicianId && user.is_active && isTechnicianRecord(user));
    if (!technician) return res.status(400).json({ success: false, message: "technician_id must reference an active Technician." });
  }

  const entries = body.entries || [];
  const entryErrors = validateDailyTimesheetEntries(entries);
  if (entryErrors.length) return res.status(400).json({ success: false, message: "Daily time sheet entries are invalid.", errors: entryErrors });

  const now = new Date().toISOString();
  const record = {
    id: req.store.id("dts"),
    technician_id: technicianId,
    name_on_form: body.name_on_form,
    // Snapshot of the artisan's identity at filing time (null when no technician is linked).
    worker_name: technician ? technicianDisplayName(technician) : null,
    technician_trade: technician?.trade ?? null,
    national_id: technician?.national_id ?? null,
    category: String(body.category || "").trim(),
    department_section: String(body.department_section || "").trim(),
    cell_number: String(body.cell_number || "").trim(),
    entries,
    signatures: body.signatures || {},
    signed_copy_image: body.signed_copy_image || null,
    status: body.submit ? "Submitted" : "Draft",
    submitted_by: body.submit ? actor.id : null,
    supervisor_comment: "",
    approved_by: null,
    approved_at: null,
    created_by: actor.id,
    created_at: now,
    submitted_at: body.submit ? now : null,
    updated_at: now
  };

  // created_by stays the real actor; this adds source, capture_method and the paper evidence block.
  if (body.source === PAPER_SOURCE) stampPaperEntry(record, actor, body, now);

  req.db.daily_timesheets.push(record);
  req.store.audit(req.db, actor, "daily_timesheet", record.id, record.status === "Submitted" ? "DAILY_TIMESHEET_SUBMITTED" : "DAILY_TIMESHEET_CREATED", null, record);

  res.json({ success: true, data: record });
};

export const updateDailyTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createDailyTimesheet");

  const record = req.db.daily_timesheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Daily time sheet not found." });
  if (!canActOnOwnerRecord(actor, record)) return deny(res, "A Technician may edit only their own daily time sheet.");
  if (!["Draft", "Returned_For_Correction"].includes(record.status)) {
    return res.status(400).json({ success: false, message: `Daily time sheet cannot be edited in ${record.status} status.` });
  }

  const body = req.body;
  if (body.entries !== undefined) {
    const entryErrors = validateDailyTimesheetEntries(body.entries);
    if (entryErrors.length) return res.status(400).json({ success: false, message: "Daily time sheet entries are invalid.", errors: entryErrors });
  }
  const paperUpdateError = paperEntryUpdateRefusal(record, body);
  if (paperUpdateError) return res.status(400).json({ success: false, code: "PAPER_ENTRY_INVALID", message: paperUpdateError });

  const before = { ...record };
  if (body.name_on_form !== undefined) record.name_on_form = body.name_on_form;
  if (body.category !== undefined) record.category = String(body.category || "").trim();
  if (body.department_section !== undefined) record.department_section = String(body.department_section || "").trim();
  if (body.cell_number !== undefined) record.cell_number = String(body.cell_number || "").trim();
  if (body.entries !== undefined) record.entries = body.entries;
  if (body.signatures !== undefined) record.signatures = { ...record.signatures, ...body.signatures };
  if (body.signed_copy_image !== undefined) record.signed_copy_image = body.signed_copy_image;
  applyPaperEntryUpdate(record, body);
  record.updated_at = new Date().toISOString();

  req.store.audit(req.db, actor, "daily_timesheet", record.id, "DAILY_TIMESHEET_UPDATED", before, record);
  res.json({ success: true, data: record });
};

export const submitDailyTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitDailyTimesheet");

  const record = req.db.daily_timesheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Daily time sheet not found." });
  if (!canActOnOwnerRecord(actor, record)) return deny(res, "A Technician may submit only their own daily time sheet.");
  if (!["Draft", "Returned_For_Correction"].includes(record.status)) {
    return res.status(400).json({ success: false, message: `Daily time sheet cannot be submitted from ${record.status}.` });
  }

  const entryErrors = validateDailyTimesheetEntries(record.entries);
  if (entryErrors.length) return res.status(400).json({ success: false, message: "Daily time sheet entries are invalid.", errors: entryErrors });
  if (!record.entries || record.entries.filter((row) => row.kind !== "separator").length === 0) {
    return res.status(400).json({ success: false, message: "At least one row of time is required before submitting." });
  }

  const before = { ...record };
  record.status = "Submitted";
  record.submitted_by = actor.id;
  record.submitted_at = new Date().toISOString();
  record.updated_at = record.submitted_at;
  req.store.audit(req.db, actor, "daily_timesheet", record.id, "DAILY_TIMESHEET_SUBMITTED", before, record);

  res.json({ success: true, data: record });
};

// Mirrors dispatchController.js's reviewWorksheet: the submitter cannot
// approve their own submission (independent-reviewer rule).
export const reviewDailyTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reviewDailyTimesheet");

  const record = req.db.daily_timesheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Daily time sheet not found." });
  if (record.status !== "Submitted") {
    return res.status(400).json({ success: false, message: `Daily time sheet review requires Submitted status, not ${record.status}.` });
  }

  const { decision, comment } = req.body;
  if (decision === "return" && !String(comment || "").trim()) {
    return res.status(400).json({ success: false, message: "Returning a daily time sheet requires a supervisor comment." });
  }
  if (decision === "approve" && record.submitted_by === actor.id) {
    return res.status(403).json({ success: false, message: "The user who submitted this daily time sheet cannot approve it. Assign an independent reviewer." });
  }

  const before = { ...record };
  record.status = decision === "approve" ? "Supervisor_Approved" : "Returned_For_Correction";
  record.supervisor_comment = comment || "";
  record.approved_by = decision === "approve" ? actor.id : null;
  record.approved_at = decision === "approve" ? new Date().toISOString() : null;
  record.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "daily_timesheet", record.id, decision === "approve" ? "DAILY_TIMESHEET_APPROVED" : "DAILY_TIMESHEET_RETURNED", before, record);

  res.json({ success: true, data: record });
};

// Document-data endpoint backing the print view (see frontend
// DailyTimesheetPrintPage.jsx). Returns the stored record plus derived,
// print-only fields (which row to start voiding from) rather than making
// the frontend re-implement that logic a third time.
export const getDailyTimesheetDocument = (req, res) => {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN];
  if (!actor?.is_active || !allowed.includes(actor.role)) return deny(res, "Role cannot view daily time sheet documents.");

  const record = req.db.daily_timesheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Daily time sheet not found." });
  if (!canActOnOwnerRecord(actor, record)) return deny(res, "A Technician may view only their own daily time sheet.");

  const technician = record.technician_id ? req.db.users.find((user) => user.id === record.technician_id) : null;
  const approvedByUser = record.approved_by ? req.db.users.find((user) => user.id === record.approved_by) : null;

  res.json({
    success: true,
    data: {
      record,
      technician,
      approved_by_user: approvedByUser,
      void_start_index: voidStartIndex(record.entries),
      company_profile: req.db.company_profile
    }
  });
};
