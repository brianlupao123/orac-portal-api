import { createHash } from "node:crypto";
import { isAssignedToDispatch } from "./controllers/dispatchController.js";
import { evaluateForDb } from "./timesheetEligibility.js";
import { isKioskEntry, kioskReviewStatus, timesheetCountsAsApproved } from "./timesheetReview.js";
import { isTimesheetV2, timesheetSignoff } from "./timesheetModel.js";
import { findApprovedRegisterCoverage, REGISTER_STATUS, SOURCE_TYPES } from "./worksheetRegisterLogic.js";
import { SERVICE_REQUEST_STATUS } from "./serviceRequestRules.js";
import { buildReconciliation } from "./inventoryLedger.js";
import { validateDailyTimesheetEntries } from "./dailyTimesheetValidation.js";
import { signoffStatus } from "./worksheetRegisterLogic.js";
import { validateContractorLogRows } from "./contractorLogValidation.js";
import { settlementSummary } from "./invoiceSettlement.js";

export const TRAIL_FLAG = "ORAC_RECORD_TRAIL_V1";
export const recordTrailEnabled = () => process.env[TRAIL_FLAG] === "enabled";

// Keep these role lists aligned with the collection guards. The dispatch
// builder delegates assignment checks to the existing dispatch controller;
// this module does not widen any existing record permission.
const internalQuoteRoles = new Set(["Admin", "Management", "Sales", "Finance", "Operations"]);
const leadRoles = new Set(["Admin", "Management", "Sales"]);
const poRoles = new Set(["Admin", "Finance", "Operations", "Management"]);
const dispatchRoles = new Set(["Admin", "Management", "Operations", "Supervisor", "Technician"]);
const auditRoles = new Set(["Admin", "Management", "Finance"]);
const invoiceRoles = new Set(["Admin", "Management", "Finance", "Client Viewer"]);
const purchaseOrderRoles = poRoles;
const inventoryRoles = new Set(["Admin", "Management", "Operations"]);
const catalogRoles = new Set(["Admin", "Management"]);
const maintenanceScheduleRoles = new Set(["Admin", "Management", "Operations", "Client Viewer"]);
const equipmentTagRoles = new Set(["Admin", "Management", "Operations"]);
const materialUsageRoles = new Set(["Admin", "Operations", "Supervisor", "Technician"]);
const worksheetRegisterRoles = new Set(["Admin", "Management", "Operations", "Supervisor"]);
const fieldWorksheetRoles = new Set(["Admin", "Management", "Operations", "Supervisor", "Technician"]);
const serviceRequestTriageRoles = new Set(["Sales", "Operations"]);
const dailyTimesheetRoles = new Set(["Admin", "Management", "Operations", "Supervisor", "Technician"]);
const contractorLogRoles = new Set(["Admin", "Management", "Operations", "Supervisor"]);
const MAX_EVENTS = 200;
const MAX_REGISTER_ANALYSIS_ROWS = 500;
const REGISTER_SOURCE_TYPES = new Set(Object.values(SOURCE_TYPES));

function auditEventKey({ row, index }) {
  return {
    at: String(row.created_at || ""),
    id: String(row.id || ""),
    index
  };
}

function compareAuditEventKeys(left, right) {
  return left.at.localeCompare(right.at) || left.id.localeCompare(right.id) || left.index - right.index;
}

function encodeEventCursor(key) {
  return Buffer.from(JSON.stringify({ v: 1, at: key.at, id: key.id, index: key.index })).toString("base64url");
}

function decodeEventCursor(value) {
  if (typeof value !== "string" || !value || value.length > 512) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.v !== 1 || typeof decoded.at !== "string" || typeof decoded.id !== "string" || !Number.isInteger(decoded.index) || decoded.index < 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

export function recordAnalysisTypesForRole(role) {
  const types = [];
  if (internalQuoteRoles.has(role)) types.push("quote");
  if (dispatchRoles.has(role)) types.push("dispatch");
  if (invoiceRoles.has(role)) types.push("invoice");
  if (purchaseOrderRoles.has(role)) types.push("purchase_order");
  if (inventoryRoles.has(role)) types.push("supplier");
  if (maintenanceScheduleRoles.has(role)) types.push("maintenance_schedule");
  if (equipmentTagRoles.has(role)) types.push("equipment_tag");
  if (materialUsageRoles.has(role)) types.push("material_usage");
  if (fieldWorksheetRoles.has(role)) types.push("field_worksheet");
  if (catalogRoles.has(role)) types.push("catalog_item");
  if (inventoryRoles.has(role)) types.push("stock_item");
  if (worksheetRegisterRoles.has(role)) types.push("worksheet_register");
  if (serviceRequestTriageRoles.has(role) || role === "Client Viewer") types.push("service_request");
  if (dailyTimesheetRoles.has(role)) types.push("daily_timesheet");
  if (contractorLogRoles.has(role)) types.push("contractor_log_sheet");
  return types;
}

export function buildDailyTimesheetAnalysis(db, sheetId, actor, { now = new Date() } = {}) {
  const sheet = (db.daily_timesheets || []).find((item) => item.id === sheetId);
  const role = actor?.role;
  if (!sheet || actor?.is_active === false || !dailyTimesheetRoles.has(role) || (role === "Technician" && sheet.technician_id !== actor.id)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const entries = Array.isArray(sheet.entries) ? sheet.entries : [];
  const validationErrors = validateDailyTimesheetEntries(entries);
  const signoff = signoffStatus(sheet);
  const coverage = [];
  if (sheet.technician_id) {
    for (const row of entries) {
      if (row?.kind === "separator" || !row?.date) continue;
      const approved = findApprovedRegisterCoverage(db, { technician_id: sheet.technician_id, date: row.date });
      if (approved.length) coverage.push(row.date);
    }
  }

  const findings = [];
  if (!entries.some((row) => row?.kind !== "separator")) findings.push({ kind: "gap", code: "DAILY_TIMESHEET_NO_TIME_ROWS", message: "No time-entry rows are recorded." });
  if (validationErrors.length) findings.push({ kind: "exception", code: "DAILY_TIMESHEET_ENTRIES_INVALID", message: "One or more time-entry rows fail the current server validation rules." });
  if (!signoff.complete) findings.push({ kind: "gap", code: "DAILY_TIMESHEET_SIGNOFF_INCOMPLETE", message: "One or more required sign-offs are incomplete." });
  if (sheet.status !== "Supervisor_Approved") findings.push({ kind: "gap", code: "DAILY_TIMESHEET_NOT_APPROVED", message: "The record is not currently supervisor-approved." });
  if (coverage.length) findings.push({ kind: "exception", code: "DAILY_TIMESHEET_ALREADY_COVERED", message: "At least one recorded work date is already present in an approved Worksheet register; investigate before any later billing action." });

  return { ok: true, data: {
    version: "daily-timesheet-analysis-v1",
    generated_at: now.toISOString(),
    daily_timesheet: {
      id: sheet.id,
      status: sheet.status || null,
      created_at: sheet.created_at || null,
      submitted_at: sheet.submitted_at || null,
      approved_at: sheet.approved_at || null,
      entry_row_count: entries.filter((row) => row?.kind !== "separator").length,
      distinct_work_dates: [...new Set(entries.filter((row) => row?.kind !== "separator" && row?.date).map((row) => row.date))].sort(),
      validation: validationErrors.length ? "invalid" : "valid",
      signoff: {
        employee_recorded: !signoff.missing.some((item) => item.party === "employee"),
        foreman_recorded: !signoff.missing.some((item) => item.party === "site_foreman"),
        customer_required: sheet.customer_signoff_required === true,
        customer_recorded: !sheet.customer_signoff_required || !signoff.missing.some((item) => item.party === "customer_representative"),
        complete: signoff.complete
      },
      approved_register_overlap: coverage.length > 0
    },
    findings,
    evidenceRefs: [{ stage: "daily_timesheet", targetType: "daily_timesheet", targetId: sheet.id }],
    limitations: [
      "Uses the current Daily Time Sheet row-validation and sign-off rules. It does not expose worker identity, phone number, entry descriptions, signature names/images, comments or raw validation text.",
      "Approved-register overlap is a duplicate-work warning only. It does not calculate payable hours, establish billing eligibility, authorize an invoice or prove payment.",
      "Access follows the daily_timesheets collection scope; a Technician may analyze only their own record. This read-only analysis does not change workflow state."
    ]
  } };
}

export function buildContractorLogAnalysis(db, logId, actor, { now = new Date() } = {}) {
  const log = (db.contractor_log_sheets || []).find((item) => item.id === logId);
  if (!log || actor?.is_active === false || !contractorLogRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const rows = Array.isArray(log.rows) ? log.rows : [];
  const validationErrors = validateContractorLogRows(rows);
  const validDate = isCalendarDate(log.log_date);
  const signed = ["foreman", "supervisor"].some((party) =>
    String(log.signatures?.[party]?.name || "").trim() && isCalendarDate(log.signatures?.[party]?.date)
  );
  const inUseRows = rows.filter((row) => String(row?.worker_name || "").trim() || ["normal", "ot_15", "ot_20"].some((key) => row?.[key] !== undefined && row[key] !== null && row[key] !== ""));
  const recordedHours = validationErrors.length ? null : Math.round(inUseRows.reduce((sum, row) =>
    sum + ["normal", "ot_15", "ot_20"].reduce((rowSum, key) => rowSum + (row?.[key] === undefined || row[key] === null || row[key] === "" ? 0 : Number(row[key])), 0), 0) * 100) / 100;

  const findings = [];
  if (!validDate) findings.push({ kind: "gap", code: "CONTRACTOR_LOG_DATE_INVALID", message: "The stored log date is missing or is not a valid calendar date." });
  if (!inUseRows.length) findings.push({ kind: "gap", code: "CONTRACTOR_LOG_NO_WORKER_ROWS", message: "No worker or hour rows are recorded." });
  if (validationErrors.length) findings.push({ kind: "exception", code: "CONTRACTOR_LOG_ROWS_INVALID", message: "One or more rows fail the current server validation rules." });
  if (!signed) findings.push({ kind: "gap", code: "CONTRACTOR_LOG_SIGNOFF_MISSING", message: "The existing foreman/supervisor sign-off check is not satisfied." });
  if (log.status !== "Supervisor_Approved") findings.push({ kind: "gap", code: "CONTRACTOR_LOG_NOT_APPROVED", message: "The record is not currently supervisor-approved." });

  return { ok: true, data: {
    version: "contractor-log-analysis-v1",
    generated_at: now.toISOString(),
    contractor_log_sheet: {
      id: log.id,
      status: log.status || null,
      log_date: validDate ? log.log_date : null,
      created_at: log.created_at || null,
      submitted_at: log.submitted_at || null,
      approved_at: log.approved_at || null,
      worker_row_count: inUseRows.length,
      validation: validationErrors.length ? "invalid" : "valid",
      foreman_or_supervisor_signoff_recorded: signed,
      recorded_hours_total: recordedHours
    },
    findings,
    evidenceRefs: [{ stage: "contractor_log_sheet", targetType: "contractor_log_sheet", targetId: log.id }],
    limitations: [
      "This uses current row validation and the monthly Worksheet's existing name/date sign-off test. It excludes contractor and worker names, grades, descriptions, order references, signature content, comments and raw validation messages.",
      "Recorded hours are the unweighted sum of Normal, 1.5 and 2.0 cells. No weighted/payable-hours estimate is made because that calculation remains an unconfirmed business assumption; this is not billing or invoice authorization.",
      "Access follows the contractor_log_sheets collection scope: Admin, Management, Operations and Supervisor. This read-only analysis does not change workflow state."
    ]
  } };
}

export function buildServiceRequestAnalysis(db, requestId, actor, { now = new Date() } = {}) {
  const request = (db.service_requests || []).find((item) => item.id === requestId);
  const clientViewer = actor?.role === "Client Viewer";
  const canTriage = serviceRequestTriageRoles.has(actor?.role);
  if (!request || actor?.is_active === false || (!clientViewer && !canTriage) || (clientViewer && (!actor.client_id || actor.client_id !== request.client_id))) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const evidenceRefs = [{ stage: "service_request", targetType: "service_request", targetId: request.id }];
  const findings = [];
  const site = request.mine_site_id
    ? (db.mine_sites || []).find((item) => item.id === request.mine_site_id && item.client_id === request.client_id)
    : null;
  const equipment = request.equipment_tag_id
    ? (db.equipment_tags || []).find((item) => item.id === request.equipment_tag_id && item.client_id === request.client_id)
    : null;
  if (site) evidenceRefs.push({ stage: "mine_site", targetType: "mine_site", targetId: site.id });
  if (equipment) evidenceRefs.push({ stage: "equipment", targetType: "equipment_tag", targetId: equipment.id });

  let conversion = { status: "not_applicable" };
  if (canTriage && request.converted_lead_id) {
    const lead = (db.leads || []).find((item) => item.id === request.converted_lead_id);
    if (lead?.service_request_id === request.id) {
      conversion = { status: "linked", lead_ref: { id: lead.id, human_ref: lead.lead_number || lead.reference || null } };
      evidenceRefs.push({ stage: "converted_lead", targetType: "lead", targetId: lead.id });
    } else {
      conversion = { status: "link_inconsistent" };
      findings.push({ kind: "exception", code: "SERVICE_REQUEST_LEAD_LINK_INCONSISTENT", message: "The stored conversion link does not resolve to a Lead linked back to this service request." });
    }
  } else if (canTriage && request.status === SERVICE_REQUEST_STATUS.ACCEPTED) {
    conversion = { status: "not_converted" };
    findings.push({ kind: "next_step", code: "ACCEPTED_REQUEST_NOT_CONVERTED", message: "This request is accepted for follow-up but has not been converted to a Lead." });
  }

  if (request.requested_date) findings.push({
    kind: "limitation",
    code: "REQUESTED_DATE_IS_NOT_A_BOOKING",
    message: "The requested date is a client preference. No appointment, capacity check or confirmed booking is recorded by this workflow."
  });
  if (request.status === SERVICE_REQUEST_STATUS.ACCEPTED) findings.push({
    kind: "limitation",
    code: "ACCEPTED_MEANS_FOLLOW_UP",
    message: "Accepted means accepted for follow-up; it does not mean that a visit is booked."
  });

  const nextStepByStatus = {
    [SERVICE_REQUEST_STATUS.SUBMITTED]: "Awaiting Sales or Operations acknowledgement.",
    [SERVICE_REQUEST_STATUS.ACKNOWLEDGED]: "Awaiting an accept or decline decision from Sales or Operations.",
    [SERVICE_REQUEST_STATUS.ACCEPTED]: conversion.status === "not_converted" ? "Convert the accepted request to a Lead when ready; confirm any visit separately." : "Accepted for follow-up; confirm any visit separately.",
    [SERVICE_REQUEST_STATUS.DECLINED]: "No further triage action is recorded.",
    [SERVICE_REQUEST_STATUS.CONVERTED]: "The request is marked converted; verify the linked Lead before continuing its workflow."
  };

  return { ok: true, data: {
    version: "service-request-analysis-v1",
    generated_at: now.toISOString(),
    service_request: {
      id: request.id,
      state: request.status || null,
      urgency: request.urgency || null,
      requested_date: request.requested_date || null,
      mine_site_id: site?.id || null,
      equipment_tag_id: equipment?.id || null,
      created_at: request.created_at || null,
      updated_at: request.updated_at || null
    },
    ...(canTriage ? { conversion } : {}),
    next_step: nextStepByStatus[request.status] || "Check the recorded request state with an authorized operator.",
    action_history: { status: "not_returned", reason: "This endpoint does not grant access to audit-event history." },
    findings,
    evidenceRefs,
    limitations: [
      "The service-need text, client/staff names, triage notes, contact data and audit snapshots are not returned.",
      "A requested date is not a confirmed appointment; this workflow has no capacity-controlled booking record.",
      "Analysis is read-only and does not acknowledge, accept, decline, convert, schedule or otherwise change the request."
    ]
  } };
}

export function buildWorksheetRegisterAnalysis(db, registerId, actor, { now = new Date() } = {}) {
  const register = (db.worksheet_registers || []).find((item) => item.id === registerId);
  if (!register || actor?.is_active === false || !worksheetRegisterRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const evidenceRefs = [{ stage: "worksheet_register", targetType: "worksheet_register", targetId: register.id }];
  const findings = [];
  const approved = register.status === REGISTER_STATUS.APPROVED;
  const covered = [];
  const seenSources = new Set();
  const seenTargets = new Set([register.id]);
  let truncated = (register.lines || []).length > MAX_REGISTER_ANALYSIS_ROWS;

  if (!approved) findings.push({
    kind: "gap",
    code: "WORKSHEET_REGISTER_NOT_APPROVED",
    message: "This register is not in approved status, so it is not treated as confirmed worker/date coverage."
  });

  if (approved) {
    const roster = new Map((register.roster || []).map((item) => [item.key, item]));
    const byWorker = new Map();
    for (const line of (register.lines || []).slice(0, MAX_REGISTER_ANALYSIS_ROWS)) {
      if (!line?.roster_key || !line?.date) continue;
      const worker = roster.get(line.roster_key);
      if (!worker) continue;
      const workerRef = worker.technician_id || `roster:${createHash("sha256").update(String(worker.key)).digest("hex").slice(0, 16)}`;
      const entry = byWorker.get(worker.key) || { worker_ref: workerRef, dates: new Set() };
      entry.dates.add(line.date);
      byWorker.set(worker.key, entry);
      for (const source of line.sources || []) {
        if (!source?.record_id || !REGISTER_SOURCE_TYPES.has(source?.source_type)) continue;
        const key = `${source.source_type}:${source.record_id}`;
        if (seenSources.has(key)) continue;
        seenSources.add(key);
        if (evidenceRefs.length >= MAX_REGISTER_ANALYSIS_ROWS) { truncated = true; continue; }
        evidenceRefs.push({ stage: "timesheet_source", targetType: source.source_type, targetId: source.record_id });
      }
    }

    for (const [rosterKey, entry] of byWorker) {
      const dates = [...entry.dates].sort();
      for (const date of dates) {
        const overlaps = entry.worker_ref && roster.get(rosterKey)?.technician_id
          ? findApprovedRegisterCoverage(db, { technician_id: entry.worker_ref, date })
            .filter((item) => item.register_id !== register.id)
          : [];
        if (overlaps.length) {
          const related = [];
          for (const overlap of overlaps) {
            if (!overlap.register_id) continue;
            related.push(overlap.register_id);
            if (seenTargets.has(overlap.register_id)) continue;
            seenTargets.add(overlap.register_id);
            if (evidenceRefs.length >= MAX_REGISTER_ANALYSIS_ROWS) { truncated = true; continue; }
            evidenceRefs.push({ stage: "overlapping_worksheet_register", targetType: "worksheet_register", targetId: overlap.register_id });
          }
          findings.push({
            kind: "exception",
            code: "APPROVED_WORKER_DATE_COVERAGE_OVERLAP",
            register_ids: [...new Set(related)],
            message: `Approved registers already cover worker/date ${entry.worker_ref} / ${date} in another register. Check the cited records before any billing step.`
          });
        }
      }
      for (const date of dates) {
        if (covered.length >= MAX_REGISTER_ANALYSIS_ROWS) { truncated = true; break; }
        covered.push({ worker_ref: entry.worker_ref, date });
      }
      if (truncated && covered.length >= MAX_REGISTER_ANALYSIS_ROWS) break;
    }
  }

  if (approved && !covered.length) findings.push({ kind: "gap", code: "APPROVED_COVERAGE_NOT_FOUND", message: "The register is approved, but no worker/date coverage rows were found in its recorded lines." });
  if (truncated) findings.push({ kind: "limit", code: "EVIDENCE_LIST_TRUNCATED", message: "Source evidence references are capped; open the worksheet register for the complete source list." });

  return { ok: true, data: {
    version: "worksheet-register-analysis-v1",
    generated_at: now.toISOString(),
    worksheet_register: { id: register.id, human_ref: register.reference || null, state: register.status || null },
    coverage_status: approved ? "approved_recorded_coverage" : "not_confirmed",
    covered_worker_dates: covered,
    findings,
    evidenceRefs,
    evidence_truncated: truncated,
    limitations: [
      "This analysis summarizes recorded approved worker/date coverage and source links only; it does not create a billable entry or authorize invoicing.",
      "Hours, amounts, rates, costs, worker names, comments and source document contents are not included; billing and payment state are not inferred."
    ]
  } };
}

export function buildInvoiceAnalysis(db, invoiceId, actor, { now = new Date() } = {}) {
  const invoice = (db.invoices || []).find((item) => item.id === invoiceId);
  if (!invoice || actor?.is_active === false || !invoiceRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const dispatch = invoice.dispatch_card_id
    ? (db.dispatch_cards || []).find((item) => item.id === invoice.dispatch_card_id) || null
    : null;
  const quote = dispatch?.quotation_id
    ? (db.quotes || []).find((item) => item.id === dispatch.quotation_id) || null
    : null;
  if (actor.role === "Client Viewer" && (!actor.client_id || !quote || quote.client_id !== actor.client_id)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const canReadPo = ["Admin", "Management", "Finance"].includes(actor.role);
  const canReadSettlement = ["Admin", "Management", "Finance"].includes(actor.role);
  const purchaseOrder = canReadPo && invoice.purchase_order_id
    ? (db.purchase_orders || []).find((item) => item.id === invoice.purchase_order_id) || null
    : null;
  const evidenceRefs = [{ stage: "invoice", targetType: "invoice", targetId: invoice.id }];
  if (canReadPo && purchaseOrder) evidenceRefs.push({ stage: "purchase_order", targetType: "purchase_order", targetId: purchaseOrder.id });
  if (["Admin", "Management"].includes(actor.role) && dispatch) {
    evidenceRefs.push({ stage: "dispatch", targetType: "dispatch_card", targetId: dispatch.id });
    if (quote) evidenceRefs.push({ stage: "quote", targetType: "quote", targetId: quote.id });
  }

  const findings = [];
  if (!invoice.dispatch_card_id) findings.push({ kind: "gap", code: "INVOICE_DISPATCH_LINK_MISSING", message: "The invoice has no recorded dispatch reference." });
  else if (!dispatch) findings.push({ kind: "gap", code: "INVOICE_DISPATCH_NOT_FOUND", message: "The recorded dispatch reference does not resolve to a dispatch record." });
  if (canReadPo && !invoice.purchase_order_id) findings.push({ kind: "gap", code: "INVOICE_PO_LINK_MISSING", message: "The invoice has no recorded purchase-order reference." });
  else if (canReadPo && invoice.purchase_order_id && !purchaseOrder) findings.push({ kind: "gap", code: "INVOICE_PO_NOT_FOUND", message: "The recorded purchase-order reference does not resolve to a purchase-order record." });
  if (invoice.status && String(invoice.status).toLowerCase() === "voided") findings.push({ kind: "exception", code: "INVOICE_RECORDED_VOIDED", message: "The invoice record is marked voided; this analysis does not assess accounting treatment." });

  return { ok: true, data: {
    version: "invoice-analysis-v1",
    generated_at: now.toISOString(),
    invoice: { id: invoice.id, human_ref: invoice.invoice_number || null, state: invoice.status || null, generated_at: invoice.generated_at || null },
    purchase_order: canReadPo ? (purchaseOrder ? { id: purchaseOrder.id, status: purchaseOrder.status || null } : null) : { status: "not_available_to_role" },
    payment_assessment: "not_determined",
    settlement: canReadSettlement
      ? { status: "recorded_manual_ledger", ...settlementSummary(db, invoice) }
      : { status: "not_available_to_role" },
    findings,
    evidenceRefs,
    limitations: [
      "This read-only analysis reports recorded invoice fields and permitted record links. For Admin, Management and Finance it includes only the current server-calculated manual settlement summary; it does not verify bank clearance, invoice arithmetic, tax or fiscal compliance, allocation, dispute or accounting settlement.",
      "Amounts, invoice lines, rates, costs, free-text reasons, client contact details, attachments and audit snapshots are not included."
    ]
  } };
}

export function buildPurchaseOrderAnalysis(db, purchaseOrderId, actor, { now = new Date() } = {}) {
  const purchaseOrder = (db.purchase_orders || []).find((item) => item.id === purchaseOrderId);
  if (!purchaseOrder || actor?.is_active === false || !purchaseOrderRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const quote = purchaseOrder.quotation_id
    ? (db.quotes || []).find((item) => item.id === purchaseOrder.quotation_id) || null
    : null;
  const evidenceRefs = [{ stage: "purchase_order", targetType: "purchase_order", targetId: purchaseOrder.id }];
  if (quote) evidenceRefs.push({ stage: "quote", targetType: "quote", targetId: quote.id });

  const findings = [];
  if (!purchaseOrder.quotation_id) findings.push({ kind: "gap", code: "PO_QUOTE_LINK_MISSING", message: "The purchase order has no recorded quotation reference." });
  else if (!quote) findings.push({ kind: "gap", code: "PO_QUOTE_NOT_FOUND", message: "The recorded quotation reference does not resolve to a quotation." });
  if (purchaseOrder.status !== "verified") findings.push({ kind: "exception", code: "PO_NOT_VERIFIED", message: "The purchase order is not recorded as verified. This analysis does not authorize dispatch." });
  if (!String(purchaseOrder.po_reference || "").trim()) findings.push({ kind: "gap", code: "PO_REFERENCE_MISSING", message: "No client purchase-order reference is recorded." });
  if (purchaseOrder.status === "verified" && !purchaseOrder.verified_at) findings.push({ kind: "gap", code: "PO_VERIFICATION_TIME_MISSING", message: "The order is marked verified but has no verification timestamp." });
  if (purchaseOrder.requires_amendment) findings.push({ kind: "next_step", code: "PO_AMENDMENT_REQUIRED", message: "Additional work or materials are marked as requiring a purchase-order amendment; this analysis does not approve the amendment." });

  return { ok: true, data: {
    version: "purchase-order-analysis-v1",
    generated_at: now.toISOString(),
    purchase_order: {
      id: purchaseOrder.id,
      state: purchaseOrder.status || null,
      has_reference: Boolean(String(purchaseOrder.po_reference || "").trim()),
      verified_at: purchaseOrder.verified_at || null,
      amendment_required: Boolean(purchaseOrder.requires_amendment)
    },
    quotation: quote ? { id: quote.id, human_ref: quote.quote_number || null, state: quote.status || null } : null,
    findings,
    evidenceRefs,
    limitations: [
      "This read-only analysis reports stored purchase-order and quotation linkage only; it does not authorize dispatch or approve an amendment.",
      "Purchase-order references, amounts, client details, audit history and attachment contents are not returned. No client PO document is stored by this workflow."
    ]
  } };
}

export function buildStockItemAnalysis(db, stockItemId, actor, { now = new Date() } = {}) {
  const stockItem = (db.stock_items || []).find((item) => item.id === stockItemId);
  if (!stockItem || actor?.is_active === false || !inventoryRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const reconciliation = buildReconciliation(db, { stockItemId });
  const item = reconciliation.items.find((entry) => entry.stock_item_id === stockItem.id);
  if (!item) return { ok: false, status: 404, message: "Record not found." };

  const allMovements = (db.stock_movements || []).filter((movement) => movement.stock_item_id === stockItem.id);
  const sourceUsages = reconciliation.system_exceptions.filter((exception) => exception.stock_item_id === stockItem.id);
  const evidenceRefs = [
    { stage: "stock_item", targetType: "stock_item", targetId: stockItem.id },
    ...allMovements.filter((movement) => movement.id).map((movement) => ({ stage: "stock_movement", targetType: "stock_movement", targetId: movement.id })),
    ...sourceUsages.map((usage) => ({ stage: "material_usage", targetType: "material_usage", targetId: usage.material_usage_id }))
  ];
  const evidenceTruncated = evidenceRefs.length > 200;
  const boundedEvidenceRefs = evidenceRefs.slice(0, 200);
  const exceptions = [
    ...item.exceptions.map((exception) => ({ ...exception, kind: "ledger_exception" })),
    ...sourceUsages.map((exception) => ({ ...exception, kind: "source_gap" }))
  ];
  const visibleExceptions = exceptions.slice(0, 200);
  const findings = visibleExceptions.map((exception) => ({
    kind: exception.kind,
    code: exception.code,
    message: exception.message,
    ...(exception.movement_id ? { evidence_id: exception.movement_id } : {}),
    ...(exception.material_usage_id ? { evidence_id: exception.material_usage_id } : {})
  }));
  if (evidenceTruncated || exceptions.length > visibleExceptions.length) {
    findings.push({ kind: "limit", code: "INVENTORY_EVIDENCE_TRUNCATED", message: "The reconciliation used the full ledger, but the returned evidence list is capped at 200 entries." });
  }

  return { ok: true, data: {
    version: "stock-item-analysis-v1",
    generated_at: now.toISOString(),
    stock_item: {
      id: item.stock_item_id,
      item_code: item.item_code,
      item_name: item.item_name,
      unit_of_measure: item.unit_of_measure,
      quantity_on_hand: item.quantity_on_hand,
      ledger_balance: item.ledger_balance,
      movement_count: item.movement_count,
      movement_sum: item.movement_sum,
      by_category: item.by_category,
      by_unit: item.by_unit,
      reconciliation_status: item.status
    },
    findings,
    evidenceRefs: boundedEvidenceRefs,
    evidence_truncated: evidenceTruncated || exceptions.length > visibleExceptions.length,
    limitations: [
      "This analysis applies the existing stock-ledger reconciliation; it does not repair records or verify physical stock by count.",
      "A reconciled ledger is arithmetic consistency only, not proof of supplier delivery, physical quantity, valuation or accounting accuracy. Movement history is referenced by ID, not returned as an action timeline."
    ]
  } };
}

export function buildCatalogItemAnalysis(db, catalogItemId, actor, { now = new Date() } = {}) {
  const catalogItem = (db.catalog_items || []).find((item) => item.id === catalogItemId);
  if (!catalogItem || actor?.is_active === false || !catalogRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const linkedStockItems = (db.stock_items || []).filter((item) => item.catalog_item_id === catalogItem.id);
  const storedPrice = catalogItem.unit_price;
  const unitPrice = Number(storedPrice);
  const validPrice = storedPrice !== null && storedPrice !== undefined && storedPrice !== "" && Number.isFinite(unitPrice) && unitPrice >= 0;
  const evidenceRefs = [
    { stage: "catalog_item", targetType: "catalog_item", targetId: catalogItem.id },
    ...linkedStockItems.filter((item) => item.id).map((item) => ({ stage: "stock_item", targetType: "stock_item", targetId: item.id }))
  ];
  const findings = [];
  if (!String(catalogItem.item_code || "").trim()) findings.push({ kind: "gap", code: "CATALOG_ITEM_CODE_MISSING", message: "No item code is recorded." });
  if (!String(catalogItem.item_name || "").trim()) findings.push({ kind: "gap", code: "CATALOG_ITEM_NAME_MISSING", message: "No item name is recorded." });
  if (!String(catalogItem.unit_of_measure || "").trim()) findings.push({ kind: "gap", code: "CATALOG_ITEM_UNIT_MISSING", message: "No unit of measure is recorded." });
  if (!validPrice) findings.push({ kind: "exception", code: "CATALOG_ITEM_PRICE_INVALID", message: "The stored catalog unit price is missing or invalid." });
  if (!linkedStockItems.length) findings.push({ kind: "gap", code: "CATALOG_ITEM_NOT_LINKED_TO_STOCK", message: "No stock item is linked to this catalog item." });
  if (catalogItem.is_active === false) findings.push({ kind: "status", code: "CATALOG_ITEM_INACTIVE", message: "The catalog item is marked inactive." });

  return { ok: true, data: {
    version: "catalog-item-analysis-v1",
    generated_at: now.toISOString(),
    catalog_item: {
      id: catalogItem.id,
      item_code: catalogItem.item_code || null,
      item_name: catalogItem.item_name || null,
      category: catalogItem.category || null,
      unit_of_measure: catalogItem.unit_of_measure || null,
      unit_price: validPrice ? unitPrice : null,
      material_grade: catalogItem.material_grade || null,
      dimensions: catalogItem.dimensions || null,
      status: catalogItem.is_active === false ? "inactive" : "not_statused"
    },
    linked_stock_items: linkedStockItems.map((item) => ({ id: item.id, item_code: item.item_code || null })),
    findings,
    evidenceRefs,
    limitations: [
      "Catalog pricing is the stored master-data value; this analysis does not establish an accepted quotation price, supplier cost, tax treatment or authority to purchase.",
      "A catalog-to-stock link is a recorded relationship only. Stock quantities and movement history require the separate Stock Item analysis."
    ]
  } };
}

export function buildSupplierAnalysis(db, supplierId, actor, { now = new Date() } = {}) {
  const supplier = (db.suppliers || []).find((item) => item.id === supplierId);
  if (!supplier || actor?.is_active === false || !inventoryRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const stockItems = (db.stock_items || []).filter((item) => item.supplier_id === supplier.id);
  const stockIds = new Set(stockItems.map((item) => item.id));
  const supplierMovements = (db.stock_movements || []).filter((movement) =>
    movement.reference_type === "supplier" && movement.reference_id === supplier.id && stockIds.has(movement.stock_item_id)
  );
  const receipts = supplierMovements.filter((movement) => movement.movement_type === "in" && Number(movement.quantity) > 0);
  const byStockItem = new Map();
  for (const receipt of receipts) {
    const entry = byStockItem.get(receipt.stock_item_id) || {
      receipt_count: 0,
      quantities_by_unit: {},
      receipts_with_source_reference: 0
    };
    entry.receipt_count += 1;
    const unit = String(receipt.unit_of_measure || "unspecified").slice(0, 40);
    const quantity = Number(receipt.quantity);
    if (Number.isFinite(quantity)) entry.quantities_by_unit[unit] = (entry.quantities_by_unit[unit] || 0) + quantity;
    if (String(receipt.source_document_ref || "").trim()) entry.receipts_with_source_reference += 1;
    byStockItem.set(receipt.stock_item_id, entry);
  }

  const reconciliation = buildReconciliation(db);
  const reconciliationByStock = new Map(reconciliation.items
    .filter((item) => stockIds.has(item.stock_item_id))
    .map((item) => [item.stock_item_id, item]));

  const findings = [];
  if (!String(supplier.name || "").trim()) findings.push({ kind: "gap", code: "SUPPLIER_NAME_MISSING", message: "No supplier name is recorded." });
  if (!stockItems.length) findings.push({ kind: "gap", code: "SUPPLIER_NOT_LINKED_TO_STOCK", message: "No stock items are linked to this supplier." });
  if (!receipts.length) findings.push({ kind: "gap", code: "SUPPLIER_RECEIPTS_NOT_RECORDED", message: "No supplier receipt movements linked to this supplier and its stock items were found." });
  for (const movement of supplierMovements) {
    if (movement.movement_type !== "in" || !(Number(movement.quantity) > 0)) {
      findings.push({ kind: "exception", code: "SUPPLIER_MOVEMENT_NOT_A_RECEIPT", message: "A supplier-linked movement does not have the expected positive receipt shape.", evidence_id: movement.id });
    }
    if (!String(movement.source_document_ref || "").trim()) {
      findings.push({ kind: "gap", code: "SUPPLIER_RECEIPT_REFERENCE_MISSING", message: "A supplier-linked movement has no source-document reference.", evidence_id: movement.id });
    }
  }
  for (const item of stockItems) {
    const reconciliation = reconciliationByStock.get(item.id);
    if (reconciliation && reconciliation.status !== "reconciled") {
      findings.push({ kind: "ledger_exception", code: "SUPPLIER_LINKED_STOCK_NOT_RECONCILED", message: "A linked stock item's ledger is not reconciled.", evidence_id: item.id });
    }
  }

  const allEvidenceRefs = [
    { stage: "supplier", targetType: "supplier", targetId: supplier.id },
    ...stockItems.filter((item) => item.id).map((item) => ({ stage: "stock_item", targetType: "stock_item", targetId: item.id })),
    ...supplierMovements.filter((item) => item.id).map((item) => ({ stage: "supplier_movement", targetType: "stock_movement", targetId: item.id }))
  ];
  const evidenceTruncated = allEvidenceRefs.length > 200;
  if (evidenceTruncated) findings.push({ kind: "limit", code: "SUPPLIER_EVIDENCE_TRUNCATED", message: "Supplier evidence references are capped at 200 entries." });

  return { ok: true, data: {
    version: "supplier-analysis-v1",
    generated_at: now.toISOString(),
    supplier: { id: supplier.id, name: supplier.name || null, lead_time_days: supplier.lead_time_days ?? null },
    linked_stock_items: stockItems.slice(0, 200).map((item) => {
      const reconciliation = reconciliationByStock.get(item.id);
      return {
        id: item.id,
        item_code: item.item_code || null,
        item_name: item.item_name || null,
        unit_of_measure: item.unit_of_measure || null,
        reconciliation_status: reconciliation?.status || "not_available",
        receipt_summary: byStockItem.get(item.id) || { receipt_count: 0, quantities_by_unit: {}, receipts_with_source_reference: 0 }
      };
    }),
    findings: findings.slice(0, 200),
    evidenceRefs: allEvidenceRefs.slice(0, 200),
    evidence_truncated: evidenceTruncated,
    limitations: [
      "A source-document reference only indicates that text was recorded; it does not verify document authenticity, delivery quality, contract compliance or supplier performance.",
      "Receipt quantities are summed by recorded unit and are not proof of current physical stock. Ledger reconciliation is arithmetic consistency only.",
      "Contact details, raw document references, notes, costs, actor identities and audit history are not returned. This read-only analysis does not modify supplier or inventory records."
    ]
  } };
}

export function buildMaintenanceScheduleAnalysis(db, scheduleId, actor, { now = new Date() } = {}) {
  const schedule = (db.maintenance_schedules || []).find((item) => item.id === scheduleId);
  if (!schedule || actor?.is_active === false || !maintenanceScheduleRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const contract = (db.contracts || []).find((item) => item.id === schedule.contract_id);
  if (actor.role === "Client Viewer" && (!actor.client_id || contract?.client_id !== actor.client_id)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const findings = [];
  if (!contract) findings.push({ kind: "gap", code: "SCHEDULE_CONTRACT_LINK_MISSING", message: "The maintenance schedule does not resolve to a contract." });
  else {
    if (!String(contract.contract_number || "").trim()) findings.push({ kind: "gap", code: "SCHEDULE_CONTRACT_REFERENCE_MISSING", message: "The linked contract has no recorded contract number." });
    if (!contract.start_date || !contract.end_date) findings.push({ kind: "gap", code: "SCHEDULE_CONTRACT_DATES_MISSING", message: "The linked contract is missing a start or end date." });
    else if (!isCalendarDate(contract.start_date) || !isCalendarDate(contract.end_date)) findings.push({ kind: "exception", code: "SCHEDULE_CONTRACT_DATES_INVALID", message: "The linked contract has an invalid start or end date." });
    else if (isCalendarDate(schedule.next_due_date) && (schedule.next_due_date < contract.start_date || schedule.next_due_date > contract.end_date)) {
      findings.push({ kind: "exception", code: "SCHEDULE_OUTSIDE_CONTRACT_PERIOD", message: "The recorded next-due date falls outside the linked contract period." });
    }
    if (!["Draft", "Active"].includes(contract.status)) findings.push({ kind: "status", code: "SCHEDULE_CONTRACT_NOT_OPEN", message: "The linked contract is not in Draft or Active status." });
  }
  if (!String(schedule.next_due_date || "").trim()) findings.push({ kind: "gap", code: "SCHEDULE_DUE_DATE_MISSING", message: "No next-due date is recorded." });
  else if (!isCalendarDate(schedule.next_due_date)) findings.push({ kind: "exception", code: "SCHEDULE_DUE_DATE_INVALID", message: "The recorded next-due date is not a valid calendar date." });
  if (!String(schedule.frequency || "").trim()) findings.push({ kind: "gap", code: "SCHEDULE_FREQUENCY_MISSING", message: "No maintenance frequency is recorded." });

  let equipment = null;
  if (schedule.equipment_tag_id) {
    const tag = (db.equipment_tags || []).find((item) => item.id === schedule.equipment_tag_id);
    const section = tag && (db.plant_sections || []).find((item) => item.id === tag.plant_section_id);
    const plant = section && (db.plants || []).find((item) => item.id === section.plant_id);
    const site = plant && (db.mine_sites || []).find((item) => item.id === plant.mine_site_id);
    if (tag && contract && site?.client_id === contract.client_id) {
      equipment = { id: tag.id, tag_code: tag.tag_code || null, status: tag.is_active === false ? "inactive" : "not_statused" };
      if (tag.is_active === false) findings.push({ kind: "status", code: "SCHEDULE_EQUIPMENT_INACTIVE", message: "The linked equipment tag is marked inactive." });
    } else {
      findings.push({ kind: "exception", code: "SCHEDULE_EQUIPMENT_LINK_UNRESOLVED", message: "The equipment tag is missing or does not resolve to the linked contract's client." });
    }
  }

  const evidenceRefs = [{ stage: "maintenance_schedule", targetType: "maintenance_schedule", targetId: schedule.id }];
  if (contract) evidenceRefs.push({ stage: "contract", targetType: "contract", targetId: contract.id });
  if (equipment) evidenceRefs.push({ stage: "equipment", targetType: "equipment_tag", targetId: equipment.id });

  return { ok: true, data: {
    version: "maintenance-schedule-analysis-v1",
    generated_at: now.toISOString(),
    maintenance_schedule: {
      id: schedule.id,
      frequency: schedule.frequency || null,
      next_due_date: schedule.next_due_date || null,
      created_at: schedule.created_at || null,
      updated_at: schedule.updated_at || null
    },
    contract: contract ? { id: contract.id, contract_number: contract.contract_number || null, status: contract.status || null, start_date: contract.start_date || null, end_date: contract.end_date || null } : null,
    equipment,
    findings,
    evidenceRefs,
    limitations: [
      "This record describes planned maintenance only. It does not prove that inspection or maintenance was performed, completed or signed off.",
      "Schedule notes, contract values, client/staff personal data, creator identity and audit snapshots are not returned. No audit action history is exposed by this endpoint.",
      "Due dates are reported as stored; this analysis does not calculate overdue status, send reminders, book a technician or change any record."
    ]
  } };
}

export function buildEquipmentTagAnalysis(db, equipmentTagId, actor, { now = new Date() } = {}) {
  const tag = (db.equipment_tags || []).find((item) => item.id === equipmentTagId);
  if (!tag || actor?.is_active === false || !equipmentTagRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const section = (db.plant_sections || []).find((item) => item.id === tag.plant_section_id) || null;
  const plant = section && (db.plants || []).find((item) => item.id === section.plant_id) || null;
  const site = plant && (db.mine_sites || []).find((item) => item.id === plant.mine_site_id) || null;
  const hierarchy = [
    { type: "mine_site", record: site, parentId: plant?.mine_site_id || null },
    { type: "plant", record: plant, parentId: section?.plant_id || null },
    { type: "plant_section", record: section, parentId: tag.plant_section_id || null }
  ];
  const findings = [];
  if (!tag.plant_section_id) findings.push({ kind: "gap", code: "EQUIPMENT_SECTION_LINK_MISSING", message: "No plant section is recorded for this equipment tag." });
  else if (!section) findings.push({ kind: "exception", code: "EQUIPMENT_SECTION_LINK_UNRESOLVED", message: "The recorded plant section does not resolve to an existing record." });
  for (const { type, record, parentId } of hierarchy) {
    if (parentId && !record) findings.push({ kind: "exception", code: `EQUIPMENT_${type.toUpperCase()}_LINK_UNRESOLVED`, message: `The equipment hierarchy does not resolve to a ${type.replaceAll("_", " ")} record.` });
    else if (record?.is_active === false) findings.push({ kind: "status", code: `EQUIPMENT_${type.toUpperCase()}_INACTIVE`, message: `The linked ${type.replaceAll("_", " ")} is marked inactive.` });
  }
  if (tag.is_active === false) findings.push({ kind: "status", code: "EQUIPMENT_TAG_INACTIVE", message: "The equipment tag is marked inactive." });
  const tagCode = String(tag.tag_code || "").trim();
  if (!tagCode) findings.push({ kind: "gap", code: "EQUIPMENT_TAG_CODE_MISSING", message: "No equipment tag code is recorded." });
  else if ((db.equipment_tags || []).filter((item) => String(item.tag_code || "").trim().toLowerCase() === tagCode.toLowerCase()).length > 1) {
    findings.push({ kind: "exception", code: "EQUIPMENT_TAG_CODE_DUPLICATE", message: "More than one equipment record uses this tag code; confirm the physical label and master record." });
  }
  if (!String(tag.equipment_name || "").trim()) findings.push({ kind: "gap", code: "EQUIPMENT_NAME_MISSING", message: "No equipment name is recorded." });
  if (!String(tag.criticality || "").trim()) findings.push({ kind: "gap", code: "EQUIPMENT_CRITICALITY_MISSING", message: "No criticality is recorded." });
  if (!String(tag.status || "").trim()) findings.push({ kind: "gap", code: "EQUIPMENT_STATUS_MISSING", message: "No equipment status is recorded." });

  const evidenceRefs = [{ stage: "equipment", targetType: "equipment_tag", targetId: tag.id }];
  for (const { type, record } of hierarchy) if (record) evidenceRefs.push({ stage: type, targetType: type, targetId: record.id });
  return { ok: true, data: {
    version: "equipment-tag-analysis-v1",
    generated_at: now.toISOString(),
    equipment_tag: {
      id: tag.id,
      tag_code: tag.tag_code || null,
      equipment_name: tag.equipment_name || null,
      criticality: tag.criticality || null,
      status: tag.status || null,
      is_active: tag.is_active !== false
    },
    hierarchy: hierarchy.filter(({ record }) => record).map(({ type, record }) => ({ type, id: record.id, name: record.name || record.plant_code || record.section_code || null, is_active: record.is_active !== false })),
    findings,
    evidenceRefs,
    limitations: [
      "This analysis checks recorded master-data links only. It does not identify a physical asset, validate a QR label or prove that records describe the same equipment on site.",
      "An equipment tag and linked maintenance schedule are not proof that work was performed, completed or signed off. This analysis does not infer service history, condition or availability.",
      "Notes, audit snapshots, client and staff personal data, and unrelated work records are not returned. This read-only analysis does not change any record."
    ]
  } };
}

export function buildMaterialUsageAnalysis(db, usageId, actor, { now = new Date() } = {}) {
  const usage = (db.material_usage || []).find((item) => item.id === usageId);
  if (!usage || actor?.is_active === false || !materialUsageRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === usage.dispatch_card_id);
  if (!dispatch || !isAssignedToDispatch(actor, dispatch, db)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const stockItem = usage.catalog_item_id
    ? (db.stock_items || []).find((item) => item.catalog_item_id === usage.catalog_item_id) || null
    : null;
  const movements = (db.stock_movements || []).filter((item) => item.reference_type === "material_usage" && item.reference_id === usage.id);
  const findings = [];
  let ledgerStatus = "not_applicable";
  if (stockItem) {
    if (movements.length === 0) {
      ledgerStatus = "missing_movement";
      findings.push({ kind: "exception", code: "MATERIAL_USAGE_MOVEMENT_MISSING", message: "A tracked stock item is linked, but no stock movement references this usage record." });
    } else if (movements.length > 1) {
      ledgerStatus = "multiple_movements";
      findings.push({ kind: "exception", code: "MATERIAL_USAGE_MULTIPLE_MOVEMENTS", message: "More than one stock movement references this usage record; review the ledger before relying on the deduction." });
    } else {
      const movement = movements[0];
      const expectedQuantity = -Number(usage.quantity_used);
      const matches = movement.stock_item_id === stockItem.id
        && movement.movement_type === "out"
        && Number.isFinite(expectedQuantity)
        && Math.abs(Number(movement.quantity) - expectedQuantity) < 0.000001;
      ledgerStatus = matches ? "matched" : "mismatch";
      if (!matches) findings.push({ kind: "exception", code: "MATERIAL_USAGE_MOVEMENT_MISMATCH", message: "The linked stock movement does not match the usage item's stock record, direction or quantity." });
    }
  } else if (movements.length) {
    ledgerStatus = "unexpected_movement";
    findings.push({ kind: "exception", code: "MATERIAL_USAGE_UNEXPECTED_MOVEMENT", message: "A stock movement references this usage, but the usage does not resolve to a tracked stock item." });
  }
  if (!Number.isFinite(Number(usage.quantity_used)) || Number(usage.quantity_used) <= 0) {
    findings.push({ kind: "exception", code: "MATERIAL_USAGE_QUANTITY_INVALID", message: "The recorded material quantity is not a positive finite number." });
  }

  const evidenceRefs = [{ stage: "material_usage", targetType: "material_usage", targetId: usage.id }];
  evidenceRefs.push({ stage: "dispatch", targetType: "dispatch_card", targetId: dispatch.id });
  if (stockItem) evidenceRefs.push({ stage: "stock_item", targetType: "stock_item", targetId: stockItem.id });
  if (movements.length === 1) evidenceRefs.push({ stage: "stock_movement", targetType: "stock_movement", targetId: movements[0].id });

  return { ok: true, data: {
    version: "material-usage-analysis-v1",
    generated_at: now.toISOString(),
    material_usage: {
      id: usage.id,
      dispatch_card_id: dispatch.id,
      catalog_item_id: usage.catalog_item_id || null,
      stock_item_id: stockItem?.id || null,
      quantity_used: Number.isFinite(Number(usage.quantity_used)) ? Number(usage.quantity_used) : null,
      unit_of_measure: usage.unit_of_measure || stockItem?.unit_of_measure || null,
      created_at: usage.created_at || null,
      stock_ledger_status: ledgerStatus
    },
    findings,
    evidenceRefs,
    limitations: [
      "This verifies stored usage-to-stock-ledger linkage only. It does not prove physical consumption, client acceptance, returned materials, or correctness of the recorded description.",
      "Unit cost, total cost, free-text description, actor identity, idempotency data and audit snapshots are not returned. A matched movement is not proof of invoice eligibility or commercial approval.",
      "Access follows the existing add-materials role and dispatch-assignment policy. This read-only analysis does not change stock, usage, dispatch or invoice records."
    ]
  } };
}

export function buildFieldWorksheetAnalysis(db, worksheetId, actor, { now = new Date() } = {}) {
  const worksheet = (db.field_worksheets || []).find((item) => item.id === worksheetId);
  if (!worksheet || actor?.is_active === false || !fieldWorksheetRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const dispatch = (db.dispatch_cards || []).find((item) => item.id === worksheet.dispatch_card_id) || null;
  const canRead = ["Admin", "Management", "Operations"].includes(actor.role)
    || (actor.role === "Technician" && worksheet.technician_id === actor.id)
    || (actor.role === "Supervisor" && (worksheet.supervisor_id === actor.id || (dispatch && isAssignedToDispatch(actor, dispatch, db))));
  if (!canRead) return { ok: false, status: 404, message: "Record not found." };

  const eligibility = evaluateForDb(db, worksheet);
  const signoff = timesheetSignoff(worksheet);
  const findings = [];
  const breakdown = isTimesheetV2(worksheet) ? worksheet.hours_breakdown : null;
  const validBreakdown = breakdown && ["normal", "ot_15", "ot_20"].every((key) => Number.isFinite(Number(breakdown[key])) && Number(breakdown[key]) >= 0 && Number(breakdown[key]) <= 24)
    && Number(breakdown.normal) + Number(breakdown.ot_15) + Number(breakdown.ot_20) > 0
    && Number(breakdown.normal) + Number(breakdown.ot_15) + Number(breakdown.ot_20) <= 24
    ? { normal: Number(breakdown.normal), ot_15: Number(breakdown.ot_15), ot_20: Number(breakdown.ot_20) }
    : null;
  const legacyHours = Number(worksheet.hours);
  const hoursTotal = validBreakdown
    ? Math.round((validBreakdown.normal + validBreakdown.ot_15 + validBreakdown.ot_20) * 100) / 100
    : (!isTimesheetV2(worksheet) && Number.isFinite(legacyHours) && legacyHours >= 0 ? legacyHours : null);
  if (!dispatch) findings.push({ kind: "gap", code: "TIMESHEET_DISPATCH_LINK_UNRESOLVED", message: "The recorded dispatch reference does not resolve to a dispatch record." });
  if (isTimesheetV2(worksheet) && !validBreakdown) findings.push({ kind: "exception", code: "TIMESHEET_HOURS_BREAKDOWN_INVALID", message: "The recorded Normal / 1.5 / 2.0 hours breakdown is missing or invalid." });
  if (validBreakdown && Number.isFinite(Number(worksheet.hours)) && Math.abs(Number(worksheet.hours) - (validBreakdown.normal + validBreakdown.ot_15 + validBreakdown.ot_20)) > 0.001) {
    findings.push({ kind: "exception", code: "TIMESHEET_HOURS_TOTAL_MISMATCH", message: "The stored total differs from the sum of the recorded Normal / 1.5 / 2.0 breakdown." });
  }
  if (!signoff.complete) {
    for (const party of signoff.missing) {
      findings.push({ kind: "gap", code: `TIMESHEET_${party.party.toUpperCase()}_SIGNOFF_MISSING`, message: `Recorded ${party.label.toLowerCase()} evidence is incomplete.` });
    }
  }
  if (!eligibility.eligible) {
    findings.push({ kind: "gap", code: eligibility.reason || "TIMESHEET_NOT_ELIGIBLE", message: `This Timesheet is not currently eligible as a daily source (${eligibility.reason || "unknown reason"}).` });
  }
  if (worksheet.superseded_by) findings.push({ kind: "exception", code: "TIMESHEET_SUPERSEDED", message: "This Timesheet has a recorded successor and is not the current revision." });

  const evidenceRefs = [{ stage: "field_worksheet", targetType: "field_worksheet", targetId: worksheet.id }];
  if (dispatch) evidenceRefs.push({ stage: "dispatch", targetType: "dispatch_card", targetId: dispatch.id });
  if (worksheet.revises_worksheet_id) evidenceRefs.push({ stage: "prior_revision", targetType: "field_worksheet", targetId: worksheet.revises_worksheet_id });
  if (worksheet.superseded_by) evidenceRefs.push({ stage: "successor_revision", targetType: "field_worksheet", targetId: worksheet.superseded_by });

  return { ok: true, data: {
    version: "field-worksheet-analysis-v1",
    generated_at: now.toISOString(),
    field_worksheet: {
      id: worksheet.id,
      dispatch_card_id: worksheet.dispatch_card_id || null,
      state: worksheet.status || null,
      work_date: worksheet.work_date || null,
      hours_total: hoursTotal,
      hours_breakdown: validBreakdown,
      revised_from_id: worksheet.revises_worksheet_id || null,
      superseded_by_id: worksheet.superseded_by || null,
      signoff: {
        employee_recorded: signoff.parties.find((item) => item.party === "employee")?.done === true,
        client_acknowledgement_recorded: signoff.parties.find((item) => item.party === "customer_representative")?.done === true,
        supervisor_approval_recorded: signoff.parties.find((item) => item.party === "supervisor")?.done === true,
        complete: signoff.complete
      },
      daily_source_eligibility: eligibility.eligible ? "eligible_under_current_rules" : "not_eligible_under_current_rules",
      eligibility_reason: eligibility.reason || null
    },
    findings,
    evidenceRefs,
    limitations: [
      "This summarizes recorded hours, Timesheet state, sign-off completeness, revision links and the existing daily-source eligibility predicate; it does not establish invoice eligibility, payment, or commercial authorization.",
      "Sign-off indicators report stored evidence presence only. Names, comments, attachments, signature images, rates, audit history and other workers' records are excluded.",
      "Access follows the field-worksheet collection scope: Admin, Management and Operations; a Technician's own sheet; or a Supervisor's assigned sheet/dispatch. This read-only analysis does not change workflow state."
    ]
  } };
}

const MAX_DISPATCH_EVIDENCE = 200;

export function buildDispatchAnalysis(db, dispatchId, actor, { now = new Date() } = {}) {
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  if (!dispatch || actor?.is_active === false || !dispatchRoles.has(actor?.role)) {
    return { ok: false, status: 404, message: "Record not found." };
  }
  const canReadDispatch = ["Admin", "Management", "Operations"].includes(actor.role) || isAssignedToDispatch(actor, dispatch, db);
  if (!canReadDispatch) {
    return { ok: false, status: 404, message: "Record not found." };
  }

  const worksheets = (db.field_worksheets || [])
    .filter((item) => item.dispatch_card_id === dispatch.id)
    .filter((item) => actor.role === "Technician" ? item.technician_id === actor.id : true)
    .filter((item) => actor.role !== "Supervisor" || item.supervisor_id === actor.id || isAssignedToDispatch(actor, dispatch, db))
    .slice(0, MAX_DISPATCH_EVIDENCE);
  const timesheets = ["Admin", "Operations", "Supervisor", "Technician"].includes(actor.role) ? (db.timesheets || [])
    .filter((item) => item.dispatch_card_id === dispatch.id)
    .filter((item) => actor.role !== "Technician" || (item.technician_id || item.user_id) === actor.id)
    .slice(0, MAX_DISPATCH_EVIDENCE) : [];
  const canReadPo = poRoles.has(actor.role);
  const quote = dispatch.quotation_id ? (db.quotes || []).find((item) => item.id === dispatch.quotation_id) : null;
  const purchaseOrder = canReadPo && quote
    ? (db.purchase_orders || []).find((item) => item.quotation_id === quote.id) || null
    : null;

  const evidenceRefs = [{ stage: "dispatch", targetType: "dispatch_card", targetId: dispatch.id }];
  if (purchaseOrder) evidenceRefs.push({ stage: "purchase_order", targetType: "purchase_order", targetId: purchaseOrder.id });
  for (const item of worksheets) evidenceRefs.push({ stage: "field_worksheet", targetType: "field_worksheet", targetId: item.id });
  for (const item of timesheets) evidenceRefs.push({ stage: "timesheet", targetType: "timesheet", targetId: item.id });

  const findings = [];
  if (canReadPo && !purchaseOrder) findings.push({
    kind: "gap",
    code: quote ? "NO_PURCHASE_ORDER_RECORDED" : "NO_QUOTE_LINK_RECORDED",
    message: quote ? "No purchase order is recorded against the linked quote." : "No linked quote is recorded, so a purchase order cannot be verified from this record."
  });
  if (purchaseOrder && purchaseOrder.status !== "verified") findings.push({
    kind: "exception",
    code: "PURCHASE_ORDER_NOT_VERIFIED",
    message: "A purchase order is recorded but is not in verified status. This analysis does not authorize dispatch."
  });
  if (!worksheets.length) findings.push({ kind: "gap", code: "NO_FIELD_WORKSHEET_RECORDED", message: "No field worksheet is recorded for this dispatch." });
  for (const item of worksheets) {
    const eligibility = evaluateForDb(db, item);
    if (!eligibility.eligible) findings.push({ kind: "gap", code: eligibility.reason || "TIMESHEET_NOT_ELIGIBLE", message: `Field worksheet ${item.id} is not currently an eligible daily source.` });
  }
  for (const item of timesheets) {
    if (isKioskEntry(item) && !timesheetCountsAsApproved(item)) {
      findings.push({ kind: "gap", code: `KIOSK_${kioskReviewStatus(item).toUpperCase()}`, message: `Kiosk Timesheet ${item.id} does not count as approved hours until an assigned Supervisor approves it.` });
    }
  }
  if (worksheets.length === MAX_DISPATCH_EVIDENCE || timesheets.length === MAX_DISPATCH_EVIDENCE) {
    findings.push({ kind: "limit", code: "EVIDENCE_LIST_TRUNCATED", message: "Evidence references are capped; open the dispatch record for the complete list." });
  }

  const data = {
    version: "dispatch-analysis-v1",
    generated_at: now.toISOString(),
    dispatch: { id: dispatch.id, human_ref: dispatch.dispatch_number || null, state: dispatch.status || null },
    purchase_order: canReadPo ? (purchaseOrder ? { id: purchaseOrder.id, status: purchaseOrder.status || null } : null) : { status: "not_available_to_role" },
    evidence: {
      field_worksheets: worksheets.map((item) => ({ id: item.id, status: item.status || null, work_date: item.work_date || null })),
      timesheets: timesheets.map((item) => ({
        id: item.id,
        work_date: item.work_date || null,
        hours_logged: item.hours_logged ?? null,
        source: isKioskEntry(item) ? "kiosk" : (item.entry_source || "direct"),
        review_status: isKioskEntry(item) ? kioskReviewStatus(item) : "not_required",
        counts_as_approved: timesheetCountsAsApproved(item)
      })),
      truncated: worksheets.length === MAX_DISPATCH_EVIDENCE || timesheets.length === MAX_DISPATCH_EVIDENCE
    },
    findings,
    evidenceRefs,
    limitations: [
      "This read-only analysis reports recorded field evidence and kiosk review state; it does not authorize dispatch, approve work, or confirm invoice readiness.",
      "Rates, costs, free-text notes, personal names, attachments and accounting/payment evidence are not included."
    ]
  };
  return { ok: true, data };
}

const AUDIT_ENTITY_ALIASES = Object.freeze({
  lead: "lead",
  quotation: "quote",
  quote: "quote",
  purchase_order: "po",
  dispatch_card: "dispatch"
});

const OUTSIDE_SLICE = Object.freeze([
  "field execution and Timesheets",
  "materials",
  "invoice and export",
  "payment, allocation and disputes"
]);

export function validateLeadLink(db, { leadId, clientId }) {
  if (leadId === undefined || leadId === null || leadId === "") return { ok: true, leadId: null };
  if (!recordTrailEnabled()) {
    return { ok: false, status: 409, code: "TRAIL_LINK_DISABLED", message: "Linking a quote to a lead is not enabled." };
  }
  const lead = (db.leads || []).find((item) => item.id === leadId);
  if (!lead) return { ok: false, status: 404, code: "LEAD_NOT_FOUND", message: "Lead not found." };
  if (lead.client_id && lead.client_id !== clientId) {
    return { ok: false, status: 409, code: "LEAD_CLIENT_MISMATCH", message: "This lead belongs to a different client." };
  }
  return { ok: true, leadId: lead.id };
}

function rootQuoteOf(db, quote) {
  const rootId = quote.root_quote_id || quote.id;
  return (db.quotes || []).find((item) => item.id === rootId) || quote;
}

function canReadQuote(actor, quote) {
  return Boolean(actor?.is_active !== false && quote && internalQuoteRoles.has(actor.role));
}

function stage(name, status, extra = {}) {
  return { stage: name, status, ...extra };
}

export function buildQuoteTrail(db, quoteId, actor, { now = new Date(), eventCursor } = {}) {
  const quote = (db.quotes || []).find((item) => item.id === quoteId);
  if (!quote || !canReadQuote(actor, quote)) return { ok: false, status: 404, message: "Record not found." };

  const root = rootQuoteOf(db, quote);
  const rootId = root.id;
  const revisions = (db.quotes || [])
    .filter((item) => (item.root_quote_id || item.id) === rootId)
    .sort((a, b) => (a.revision_number || 0) - (b.revision_number || 0));
  const canReadLead = leadRoles.has(actor.role);
  const canReadPo = poRoles.has(actor.role);
  const canReadDispatch = dispatchRoles.has(actor.role);
  const canReadEvents = auditRoles.has(actor.role);
  const linkedLead = canReadLead && root.source_lead_id
    ? (db.leads || []).find((item) => item.id === root.source_lead_id) || null
    : null;
  const po = canReadPo ? (db.purchase_orders || []).find((item) => item.quotation_id === quote.id) || null : null;
  const job = canReadDispatch ? (db.dispatch_cards || []).find((item) => item.quotation_id === quote.id) || null : null;
  const gaps = [];
  const stages = [];

  if (canReadLead) {
    if (linkedLead) {
      stages.push(stage("lead", "recorded", { ref: { type: "lead", id: linkedLead.id }, state: linkedLead.status || null, at: linkedLead.created_at || null }));
    } else {
      stages.push(stage("lead", "not_recorded", { note: "No lead is linked to this quote. No historical link is inferred." }));
      gaps.push({ code: "LEAD_NOT_LINKED", message: "This quote has no recorded link to an enquiry or lead." });
    }
  }

  stages.push(stage("quote", "recorded", {
    ref: { type: "quote", id: quote.id, human_ref: quote.quote_number || null },
    state: quote.status,
    at: quote.created_at || null,
    revisions: revisions.length > 1
      ? revisions.map((item) => ({ id: item.id, human_ref: item.quote_number || null, revision_number: item.revision_number || 0, state: item.status }))
      : []
  }));
  if (["Approved_Pending_PO", "PO_Verified", "Field_Dispatch", "Invoiced"].includes(quote.status)) {
    gaps.push({ code: "CLIENT_ACCEPTANCE_NOT_RECORDED", message: "Quote approval is an internal step; client acceptance evidence is not recorded in this path." });
  }

  if (canReadPo) {
    if (po) {
      stages.push(stage("po", "recorded", {
        ref: { type: "purchase_order", id: po.id },
        state: po.status,
        at: po.verified_at || po.date_received || null,
        has_reference: Boolean(String(po.po_reference || "").trim()),
        evidence: { status: "not_recorded", note: "PO document evidence is not stored; only a typed reference and amount." }
      }));
      gaps.push({ code: "PO_DOCUMENT_EVIDENCE_NOT_STORED", message: "No PO document or attachment reference is held for this order." });
    } else {
      stages.push(stage("po", "not_recorded", { note: "No purchase order is recorded against this quote." }));
    }
  }

  if (canReadDispatch) {
    if (job) {
      const poVerified = Boolean(po && po.status === "verified");
      const exception = job.started_before_po && !poVerified
        ? "URGENT_BEFORE_PO"
        : !poVerified ? "DISPATCHED_WITH_UNVERIFIED_PO" : null;
      const dispatch = {
        ref: { type: "dispatch_card", id: job.id, human_ref: job.dispatch_number || null },
        state: job.status || null,
        at: job.created_at || null,
        scheduled_start: job.scheduled_start || null,
        started_before_po: Boolean(job.started_before_po),
        exception
      };
      dispatch.urgent_reason_recorded = Boolean(String(job.urgent_reason || "").trim());
      dispatch.assigned_supervisor_id = job.assigned_supervisor_id || null;
      dispatch.assigned_technician_count = Array.isArray(job.assigned_technician_ids) ? job.assigned_technician_ids.length : 0;
      stages.push(stage("dispatch", "recorded", dispatch));
      if (exception) {
        gaps.push({
          code: exception,
          message: exception === "URGENT_BEFORE_PO"
            ? "This historical dispatch was recorded as starting before a verified PO."
            : "A historical dispatch exists without a verified PO."
        });
      }
    } else {
      stages.push(stage("dispatch", "not_recorded", { note: "No dispatch card exists for this quote." }));
    }
  }

  const data = {
    version: "trail-v1",
    generated_at: now.toISOString(),
    quote: { id: quote.id, human_ref: quote.quote_number || null },
    stages,
    gaps,
    outside_slice: [...OUTSIDE_SLICE]
  };

  if (canReadEvents) {
    const ids = new Map();
    for (const item of revisions) ids.set(item.id, "quote");
    ids.set(quote.id, "quote");
    if (po) ids.set(po.id, "po");
    if (job) ids.set(job.id, "dispatch");
    if (linkedLead) ids.set(linkedLead.id, "lead");
    const userRole = new Map((db.users || []).map((user) => [user.id, user.role]));
    const rows = (db.audit_logs || [])
      .filter((row) => ids.has(row.entity_id) && AUDIT_ENTITY_ALIASES[row.entity_type] === ids.get(row.entity_id))
      .map((row, index) => ({ row, index }))
      .sort((a, b) => compareAuditEventKeys(auditEventKey(a), auditEventKey(b)));
    const cursor = eventCursor === undefined ? null : decodeEventCursor(eventCursor);
    if (eventCursor !== undefined && !cursor) {
      return { ok: false, status: 400, message: "Invalid event cursor." };
    }
    const eligibleRows = cursor
      ? rows.filter((item) => compareAuditEventKeys(auditEventKey(item), cursor) < 0)
      : rows;
    const visibleRows = eligibleRows.slice(-MAX_EVENTS);
    const hasMore = eligibleRows.length > visibleRows.length;
    data.events = visibleRows.map(({ row }) => ({
      action: row.action,
      entity: AUDIT_ENTITY_ALIASES[row.entity_type],
      entity_id: row.entity_id,
      at: row.created_at || null,
      actor_id: row.actor_id || null,
      actor_kind: row.actor_id ? "user" : "system_or_public",
      actor_role_current: row.actor_id ? (userRole.get(row.actor_id) || null) : null
    }));
    data.events_truncated = hasMore;
    data.events_pagination = {
      returned: visibleRows.length,
      total_matching_events: rows.length,
      has_more: hasMore,
      next_cursor: hasMore ? encodeEventCursor(auditEventKey(visibleRows[0])) : null
    };
  } else {
    data.event_history = { status: "not_available_to_role" };
  }

  return { ok: true, data };
}
