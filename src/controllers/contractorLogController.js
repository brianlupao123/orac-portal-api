import { requirePermission, roles } from "../permissions.js";
import { validateContractorLogRows, computeLogTotals, voidStartIndex } from "../contractorLogValidation.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function deny(res, message) {
  return res.status(403).json({ success: false, message });
}

export const createContractorLog = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createContractorLog");

  const body = req.body;
  const rows = body.rows || [];
  const rowErrors = validateContractorLogRows(rows);
  if (rowErrors.length) return res.status(400).json({ success: false, message: "Contractor log rows are invalid.", errors: rowErrors });

  const now = new Date().toISOString();
  const record = {
    id: req.store.id("cls"),
    contractor_name: body.contractor_name,
    department_section: String(body.department_section || "").trim(),
    section: String(body.section || "").trim(),
    order_no: String(body.order_no || "").trim(),
    log_date: body.log_date || null,
    work_description: String(body.work_description || "").trim(),
    rows,
    signatures: body.signatures || {},
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

  req.db.contractor_log_sheets.push(record);
  req.store.audit(req.db, actor, "contractor_log_sheet", record.id, record.status === "Submitted" ? "CONTRACTOR_LOG_SUBMITTED" : "CONTRACTOR_LOG_CREATED", null, record);

  res.json({ success: true, data: record });
};

export const updateContractorLog = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createContractorLog");

  const record = req.db.contractor_log_sheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Contractor log not found." });
  if (!["Draft", "Returned_For_Correction"].includes(record.status)) {
    return res.status(400).json({ success: false, message: `Contractor log cannot be edited in ${record.status} status.` });
  }

  const body = req.body;
  if (body.rows !== undefined) {
    const rowErrors = validateContractorLogRows(body.rows);
    if (rowErrors.length) return res.status(400).json({ success: false, message: "Contractor log rows are invalid.", errors: rowErrors });
  }

  const before = { ...record };
  if (body.contractor_name !== undefined) record.contractor_name = body.contractor_name;
  if (body.department_section !== undefined) record.department_section = String(body.department_section || "").trim();
  if (body.section !== undefined) record.section = String(body.section || "").trim();
  if (body.order_no !== undefined) record.order_no = String(body.order_no || "").trim();
  if (body.log_date !== undefined) record.log_date = body.log_date;
  if (body.work_description !== undefined) record.work_description = String(body.work_description || "").trim();
  if (body.rows !== undefined) record.rows = body.rows;
  if (body.signatures !== undefined) record.signatures = { ...record.signatures, ...body.signatures };
  record.updated_at = new Date().toISOString();

  req.store.audit(req.db, actor, "contractor_log_sheet", record.id, "CONTRACTOR_LOG_UPDATED", before, record);
  res.json({ success: true, data: record });
};

export const submitContractorLog = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitContractorLog");

  const record = req.db.contractor_log_sheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Contractor log not found." });
  if (!["Draft", "Returned_For_Correction"].includes(record.status)) {
    return res.status(400).json({ success: false, message: `Contractor log cannot be submitted from ${record.status}.` });
  }

  const rowErrors = validateContractorLogRows(record.rows);
  if (rowErrors.length) return res.status(400).json({ success: false, message: "Contractor log rows are invalid.", errors: rowErrors });
  if (!record.rows || record.rows.filter((row) => String(row.worker_name || "").trim()).length === 0) {
    return res.status(400).json({ success: false, message: "At least one worker row is required before submitting." });
  }

  const before = { ...record };
  record.status = "Submitted";
  record.submitted_by = actor.id;
  record.submitted_at = new Date().toISOString();
  record.updated_at = record.submitted_at;
  req.store.audit(req.db, actor, "contractor_log_sheet", record.id, "CONTRACTOR_LOG_SUBMITTED", before, record);

  res.json({ success: true, data: record });
};

export const reviewContractorLog = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reviewContractorLog");

  const record = req.db.contractor_log_sheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Contractor log not found." });
  if (record.status !== "Submitted") {
    return res.status(400).json({ success: false, message: `Contractor log review requires Submitted status, not ${record.status}.` });
  }

  const { decision, comment } = req.body;
  if (decision === "return" && !String(comment || "").trim()) {
    return res.status(400).json({ success: false, message: "Returning a contractor log requires a supervisor comment." });
  }
  if (decision === "approve" && record.submitted_by === actor.id) {
    return res.status(403).json({ success: false, message: "The user who submitted this contractor log cannot approve it. Assign an independent reviewer." });
  }

  const before = { ...record };
  record.status = decision === "approve" ? "Supervisor_Approved" : "Returned_For_Correction";
  record.supervisor_comment = comment || "";
  record.approved_by = decision === "approve" ? actor.id : null;
  record.approved_at = decision === "approve" ? new Date().toISOString() : null;
  record.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "contractor_log_sheet", record.id, decision === "approve" ? "CONTRACTOR_LOG_APPROVED" : "CONTRACTOR_LOG_RETURNED", before, record);

  res.json({ success: true, data: record });
};

// Document-data endpoint backing the print view: returns the stored record
// plus server-computed per-row and grand totals, so the frontend never has
// to re-implement (and risk drifting from) the totals formula.
export const getContractorLogDocument = (req, res) => {
  const actor = getActor(req);
  const allowed = [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR];
  if (!actor?.is_active || !allowed.includes(actor.role)) return deny(res, "Role cannot view contractor log documents.");

  const record = req.db.contractor_log_sheets.find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, message: "Contractor log not found." });

  res.json({
    success: true,
    data: {
      record,
      totals: computeLogTotals(record.rows),
      void_start_index: voidStartIndex(record.rows),
      company_profile: req.db.company_profile
    }
  });
};
