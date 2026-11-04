import { hasPermission, requirePermission, roles } from "../permissions.js";
import { dispatchHasActiveInvoice, INVOICED_DISPATCH_MESSAGE } from "../dispatchFreeze.js";
import { applyStockChange, readIdempotencyKey, requestFingerprint, findIdempotentRecord, publicMovement } from "../inventoryLedger.js";
import { dispatchSupervisors, reviewBlockedReason } from "../timesheetReview.js";
import { createHash } from "node:crypto";
import { isEligibleForDb } from "../timesheetEligibility.js";
import {
  TIMESHEET_VERSION, normaliseBreakdown, validateTimes, isTimesheetV2, employeeSignoffMissing, classifyTimesheet, isIsoDate
} from "../timesheetModel.js";
import { v5Enabled } from "../v5CommercialWorkflow.js";
import { v5SupervisorAssignmentRefusal } from "../v5SignatureEvidence.js";
import { calculatePurchaseOrderEvidenceValue } from "../store.js";
import { invoiceReadinessBlock, invoiceReadinessSummary } from "../invoiceReadiness.js";
import { isDispatchInSalesPortfolio } from "./coreController.js";
import {
  PAPER_SOURCE, paperEntryCreateRefusal, stampPaperEntry, salesOwnPaperEntryRefusal, paperEntryUpdateRefusal, applyPaperEntryUpdate
} from "../paperEntry.js";

const STAFF_ROLES = [roles.ADMIN, roles.OPERATIONS, roles.SUPERVISOR];
const normName = (v) => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();

// Same worker identity: a linked Technician id, or (contractors without an
// account) a normalised name.
const sameWorker = (a, b) => (a.technician_id && b.technician_id ? a.technician_id === b.technician_id
  : !a.technician_id && !b.technician_id && normName(a.worker_name) !== "" && normName(a.worker_name) === normName(b.worker_name));

// Content fingerprint for idempotent replay (offline sync): same key + same
// content returns the original record; same key + different content is a 409.
function timesheetFingerprint(dispatchId, technicianId, body) {
  return createHash("sha256").update(JSON.stringify([
    dispatchId, technicianId, body.worker_name || "", body.work_date || "", body.activity, body.hours_breakdown || body.hours, body.quote_line_id || "",
    body.start_time || "", body.end_time || "", body.materials_used || [], body.outcomes || "", body.signatures || {}, body.signed_copy_image ? "img" : "", body.submit === true,
    ...(body.source ? [body.source, body.client_paper_reference || "", body.signatory_name_on_paper || "", body.scan_reference || "", body.scan_hash || ""] : [])
  ])).digest("hex");
}

// Applies the v2 fields (breakdown, times, materials, worker, sign-off) to a
// record. Returns an error string or null. Never trusts a client-sent total.
function applyTimesheetFields(record, body, actor, { creating }) {
  if (body.hours_breakdown !== undefined) {
    const parsed = normaliseBreakdown(body.hours_breakdown);
    if (!parsed.ok) return parsed.error;
    if (body.hours !== undefined && Math.abs(Number(body.hours) - parsed.total) > 0.001) return `Hours (${body.hours}) must equal Normal + 1.5 + 2.0 (${parsed.total}).`;
    record.hours_breakdown = parsed.breakdown;
    record.hours = parsed.total;
    record.timesheet_version = TIMESHEET_VERSION;
  } else if (creating && body.hours !== undefined) {
    // Legacy single-number body: stays a legacy record (no breakdown, not counted in a Worksheet).
    record.hours = body.hours;
  } else if (body.hours !== undefined && !isTimesheetV2(record)) {
    record.hours = body.hours;
  } else if (body.hours !== undefined && isTimesheetV2(record)) {
    return "Send hours_breakdown (Normal, 1.5, 2.0) to change the hours of this Timesheet.";
  }
  for (const key of ["start_time", "end_time"]) if (body[key] !== undefined) record[key] = body[key];
  const timeError = validateTimes(record.start_time, record.end_time);
  if (timeError) return timeError;
  if (body.worker_category !== undefined) record.worker_category = body.worker_category;
  if (body.materials_used !== undefined) record.materials_used = body.materials_used;
  if (body.signed_copy_image !== undefined) record.signed_copy_image = body.signed_copy_image || null;
  if (body.signatures?.employee) {
    const e = body.signatures.employee;
    const prev = record.signatures?.employee || {};
    // The server, not the device, stamps who attested and when.
    const attested = e.attest === true && e.method === "on_device";
    record.signatures = { ...(record.signatures || {}), employee: {
      name: e.name ?? prev.name ?? "", date: e.date ?? prev.date ?? "", method: e.method ?? prev.method,
      ...(attested ? { attested_by: actor.id, attested_at: new Date().toISOString() } : (e.method === "on_device" ? {} : { attested_by: prev.attested_by, attested_at: prev.attested_at }))
    } };
  }
  return null;
}
function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

export function isAssignedToDispatch(actor, dispatch, db) {
  if ([roles.ADMIN, roles.OPERATIONS].includes(actor.role)) return true;
  const linkedWorksheets = (db.field_worksheets || []).filter((worksheet) => worksheet.dispatch_card_id === dispatch.id);
  if (actor.role === roles.TECHNICIAN) {
    return dispatch.assigned_technician_id === actor.id ||
      dispatch.technician_id === actor.id ||
      dispatch.assigned_to === actor.id ||
      (dispatch.assigned_technician_ids || []).includes(actor.id) ||
      linkedWorksheets.some((worksheet) => worksheet.technician_id === actor.id);
  }
  if (actor.role === roles.SUPERVISOR) {
    return dispatch.assigned_supervisor_id === actor.id ||
      dispatch.supervisor_id === actor.id ||
      linkedWorksheets.some((worksheet) => worksheet.supervisor_id === actor.id);
  }
  return false;
}

const safePerson = (user) => user ? { id: user.id, name: user.name || null, trade: user.trade || null } : null;

function canReadDispatchJobCard(actor, dispatch, db) {
  if (!hasPermission(actor, "viewDispatchJobCard")) return false;
  if ([roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS].includes(actor.role)) return true;
  return isAssignedToDispatch(actor, dispatch, db);
}

function worksheetSummary(db, dispatchId) {
  const worksheets = (db.field_worksheets || []).filter((item) => item.dispatch_card_id === dispatchId && !item.superseded_by);
  return {
    total: worksheets.length,
    draft: worksheets.filter((item) => item.status === "Draft").length,
    awaiting_client: worksheets.filter((item) => item.status === "Submitted").length,
    awaiting_supervisor: worksheets.filter((item) => item.status === "Client_Acknowledged").length,
    approved: worksheets.filter((item) => isEligibleForDb(db, item)).length,
    returned: worksheets.filter((item) => item.status === "Returned_For_Correction").length,
    attachments: worksheets.reduce((total, item) => total + (Array.isArray(item.evidence_files) ? item.evidence_files.length : 0) + (item.signed_copy_image ? 1 : 0), 0)
  };
}

// A field-safe, read-only projection for the future Job Card screen. It does
// not broaden existing mutation permissions or calculate financial values in
// the UI. Amounts, stock costs, supplier data and audit event bodies stay out
// of this response.
export const getDispatchJobCard = (req, res) => {
  const actor = getActor(req);
  const job = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!canReadDispatchJobCard(actor, job, req.db)) {
    return res.status(403).json({ success: false, message: "This role may view only an authorized dispatch job card." });
  }

  const quote = (req.db.quotes || []).find((item) => item.id === job.quotation_id) || null;
  const po = (req.db.purchase_orders || []).find((item) => item.id === job.purchase_order_id) ||
    (req.db.purchase_orders || []).find((item) => item.quotation_id === job.quotation_id) || null;
  const client = quote ? (req.db.clients || []).find((item) => item.id === quote.client_id) || null : null;
  const materials = (req.db.material_usage || []).filter((item) => item.dispatch_card_id === job.id);
  const trackedMaterialIds = new Set(materials.map((item) => item.catalog_item_id).filter(Boolean));
  const trackedItems = (req.db.stock_items || []).filter((item) => trackedMaterialIds.has(item.catalog_item_id));
  const auditAllowed = hasPermission(actor, "viewAudit");
  const assignedTechnicianIds = new Set([job.assigned_technician_id, ...(job.assigned_technician_ids || [])].filter(Boolean));
  const roster = (req.db.users || []).filter((item) => assignedTechnicianIds.has(item.id) && item.role === roles.TECHNICIAN && item.is_active !== false);
  const invoiceBlock = invoiceReadinessBlock(req.db, job);

  res.json({
    success: true,
    data: {
      identity: {
        id: job.id,
        dispatch_number: job.dispatch_number || null,
        status: job.status || null,
        scheduled_start: job.scheduled_start || null,
        site_id: job.site_id || null,
        client: client ? { id: client.id, name: client.name || null } : null
      },
      workflow: {
        quotation: quote ? { id: quote.id, quote_number: quote.quote_number || null, status: quote.status || null } : null,
        purchase_order: po ? { id: po.id, po_reference: po.po_reference || null, status: po.status || null } : null
      },
      assignment: {
        assigned_supervisor: safePerson((req.db.users || []).find((item) => item.id === job.assigned_supervisor_id)),
        roster_count: roster.length,
        roster: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR].includes(actor.role) ? roster.map(safePerson) : []
      },
      evidence_summary: {
        timesheets: worksheetSummary(req.db, job.id),
        material_usage: {
          count: materials.length,
          tracked_item_count: trackedItems.length,
          low_stock_count: trackedItems.filter((item) => Number(item.quantity_on_hand) <= Number(item.reorder_level ?? 0)).length
        },
        audit: auditAllowed ? { available: true, event_count: (req.db.audit_logs || []).filter((item) => item.entity_type === "dispatch_card" && item.entity_id === job.id).length } : { available: false }
      },
      exceptions: {
        started_before_po: Boolean(job.started_before_po || po?.started_before_po),
        invoice_readiness: invoiceBlock ? { code: invoiceBlock.code, message: invoiceBlock.message } : null
      },
      capabilities: {
        can_create_timesheet: hasPermission(actor, "createWorksheet"),
        can_log_material_usage: hasPermission(actor, "addMaterials"),
        can_manage_roster: hasPermission(actor, "dispatch"),
        can_assign_supervisor: hasPermission(actor, "assignDispatchSupervisor")
      }
    }
  });
};

// Commercial read model: it explains the server's existing invoice gate but
// never creates, amends, or issues an invoice.
export const getDispatchInvoiceReadiness = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewInvoiceReadiness");
  const job = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  return res.json({ success: true, data: invoiceReadinessSummary(req.db, job) });
};

// Roster assignment (Chat D continuation). Source-proven gap: nothing in the
// runtime code path ever wrote assigned_technician_id/assigned_technician_ids
// — it was only ever populated in curated demo data. Every real technician
// only gained dispatch access retroactively, once an Admin/Operations user
// created a worksheet naming them, which is also the only way the kiosk
// roster (kioskController.rosterIds) could ever see them. There was no way
// for Operations to roster a technician to a dispatch before any worksheet
// existed. This endpoint is the single, explicit, server-controlled place
// that does that; it does not change who may create/submit/approve a
// worksheet, and it does not touch stock, invoicing, or client
// acknowledgement.
export const assignRosterTechnician = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "dispatch");

  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;

  const technicianId = req.body.technician_id;
  const technician = req.db.users.find((user) => user.id === technicianId && user.role === roles.TECHNICIAN);
  if (!technician) return res.status(400).json({ success: false, message: "A valid, active Technician is required." });
  if (!technician.is_active) return res.status(400).json({ success: false, message: "Cannot roster an inactive Technician." });

  if (!Array.isArray(job.assigned_technician_ids)) job.assigned_technician_ids = [];
  if (job.assigned_technician_ids.includes(technicianId)) {
    return res.json({ success: true, data: job, message: "Technician is already on this dispatch's roster." });
  }

  const before = { ...job, assigned_technician_ids: [...job.assigned_technician_ids] };
  job.assigned_technician_ids.push(technicianId);
  req.store.audit(req.db, actor, "dispatch_card", job.id, "ROSTER_TECHNICIAN_ASSIGNED", before, job);

  res.json({ success: true, data: job });
};

export const assignDispatchSupervisor = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "assignDispatchSupervisor");

  const job = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  if (dispatchHasActiveInvoice(req.db, job)) {
    return res.status(409).json({ success: false, message: INVOICED_DISPATCH_MESSAGE });
  }

  const supervisor = req.db.users.find((user) => user.id === req.body.supervisor_id && user.role === roles.SUPERVISOR);
  if (!supervisor) return res.status(400).json({ success: false, message: "A valid Supervisor is required." });
  if (supervisor.is_active === false) return res.status(400).json({ success: false, message: "Cannot assign an inactive Supervisor." });
  const separationRefusal = v5SupervisorAssignmentRefusal(req.db, job, supervisor); // dark: null unless V5 is enabled for this quotation
  if (separationRefusal) return res.status(409).json({ success: false, code: "V5_SUPERVISOR_SEPARATION", message: separationRefusal });
  if (job.assigned_supervisor_id === supervisor.id) {
    return res.json({ success: true, data: job, message: "This Supervisor is already assigned to the dispatch." });
  }

  const before = { ...job };
  job.assigned_supervisor_id = supervisor.id;
  req.store.audit(req.db, actor, "dispatch_card", job.id, "DISPATCH_SUPERVISOR_ASSIGNED", before, job);
  res.json({ success: true, data: job });
};

export const getDispatchRoster = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "viewDispatchRoster");
  const job = req.db.dispatch_cards.find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  const onRoster = new Set([...(job.assigned_technician_ids || []), job.assigned_technician_id].filter(Boolean));
  for (const worksheet of req.db.field_worksheets || []) {
    if (worksheet.dispatch_card_id === job.id && worksheet.technician_id) onRoster.add(worksheet.technician_id);
  }
  const technicians = req.db.users
    .filter((user) => user.role === roles.TECHNICIAN && user.is_active)
    .map(({ id, name, trade }) => ({ id, name, trade: trade || null, on_roster: onRoster.has(id) }));
  const assignedSupervisorIds = new Set(dispatchSupervisors(req.db, job).map((user) => user.id));
  const supervisors = [roles.ADMIN, roles.OPERATIONS].includes(actor.role)
    ? req.db.users.filter((user) => user.role === roles.SUPERVISOR && user.is_active !== false)
      .map((user) => ({ id: user.id, name: user.name || null, assigned: assignedSupervisorIds.has(user.id) }))
    : undefined;
  res.json({
    success: true,
    data: {
      dispatch: { id: job.id, dispatch_number: job.dispatch_number || null, review_blocked_reason: reviewBlockedReason(req.db, job) },
      technicians,
      ...(supervisors ? { supervisors } : {})
    }
  });
};

function requireAssignedDispatch(actor, dispatch, db, res) {
  if (isAssignedToDispatch(actor, dispatch, db)) return true;
  res.status(403).json({ success: false, message: "This role may work only on an assigned dispatch." });
  return false;
}

// Timesheet create/update/submit only. The Sales Desk keys in signed paper for dispatches in its own
// commercial portfolio; every other role keeps the unchanged assigned-dispatch rule.
function requireWorksheetDispatchAccess(actor, dispatch, db, res) {
  if (actor.role === roles.SALES) {
    if (isDispatchInSalesPortfolio(dispatch, actor, db)) return true;
    res.status(403).json({ success: false, message: "Sales may enter paper timesheets only for dispatches in their own portfolio." });
    return false;
  }
  return requireAssignedDispatch(actor, dispatch, db, res);
}

// V5 never stores a rate on a Timesheet. Instead, its daily source record
// points to one priced quotation line on the same dispatch. The invoice layer
// can later price verified hours from that controlled commercial record.
function v5QuoteLineForWorksheet(db, dispatch, quoteLineId) {
  const quote = (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  if (!v5Enabled() || !quote?.v5_commercial_workflow) return { required: false, line: null };
  if (!quoteLineId) return { required: true, error: "A V5 Timesheet must select a quotation labour line." };
  const line = (db.quote_lines || []).find((item) => item.id === quoteLineId && item.quotation_id === quote.id);
  if (!line) return { required: true, error: "The selected quotation line does not belong to this dispatch's quotation." };
  return { required: true, line };
}

export const addTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "addTimesheet");
  
  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  if (dispatchHasActiveInvoice(req.db, job)) return res.status(409).json({ success: false, message: INVOICED_DISPATCH_MESSAGE });

  const body = req.body;

  // Timesheet-evidence traceability (Chat D continuation). Source-proven gap:
  // this endpoint feeds db.timesheets, which is what createInvoice's
  // laborTotal actually bills (see stateMachine.js) — but nothing here ever
  // checked that a Technician's billed hours corresponded to the
  // Technician -> Supervisor field_worksheet evidence chain that the rest of
  // this system already builds and enforces (createWorksheet ->
  // submitWorksheet -> reviewWorksheet). A Technician logging their own time
  // must reference a Supervisor-approved worksheet for this same dispatch;
  // billable hours can no longer exist with zero trace back to reviewed
  // field evidence. This does not change the rate/amount formula, and it
  // does not invent a client-acknowledgement mechanism — see
  // CONTINUATION_NOTE.md for why non-Technician roles and the separate
  // kiosk batch path are deliberately left as owner decisions rather than
  // guessed at here.
  if (actor.role === roles.TECHNICIAN) {
    const worksheetId = body.source_worksheet_id;
    if (!worksheetId) {
      return res.status(400).json({
        success: false,
        message: "A Technician's timesheet entry must reference a Supervisor-approved timesheet (source_worksheet_id)."
      });
    }
    const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
    if (!worksheet || worksheet.dispatch_card_id !== dispatchId || worksheet.technician_id !== actor.id) {
      return res.status(400).json({
        success: false,
        message: "source_worksheet_id must reference the Technician's own timesheet on this dispatch."
      });
    }
    if (!isEligibleForDb(req.db, worksheet)) {
      return res.status(409).json({
        success: false,
        message: `Timesheet entry blocked: timesheet ${worksheetId} is '${worksheet.status}', not Supervisor-approved yet.`
      });
    }
    const alreadyLogged = (req.db.timesheets || [])
      .filter((item) => item.source_worksheet_id === worksheetId)
      .reduce((sum, item) => sum + Number(item.hours_logged || 0), 0);
    if (alreadyLogged + Number(body.hours_logged) > Number(worksheet.hours || 0)) {
      return res.status(409).json({
        success: false,
        message: `Timesheet entry blocked: ${alreadyLogged + Number(body.hours_logged)} hours would exceed the ${Number(worksheet.hours || 0)} hours the Supervisor approved on timesheet ${worksheetId}.`
      });
    }
  }

  const entry = {
    id: req.store.id("ts"),
    dispatch_card_id: dispatchId,
    user_id: actor.id,
    source_worksheet_id: body.source_worksheet_id || null,
    work_date: body.work_date || new Date().toISOString().slice(0, 10),
    hours_logged: body.hours_logged,
    hourly_rate: body.hourly_rate,
    notes: String(body.notes || "").trim()
  };
  
  req.db.timesheets.push(entry);
  req.store.recalculateVariance(req.db, job.purchase_order_id);
  req.store.audit(req.db, actor, "timesheet", entry.id, "TIMESHEET_ADDED", null, entry);
  
  res.json({ success: true, data: entry });
};

export const addMaterialUsage = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "addMaterials");
  
  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  if (dispatchHasActiveInvoice(req.db, job)) return res.status(409).json({ success: false, message: INVOICED_DISPATCH_MESSAGE });

  const body = req.body;

  // Stock impact is server-determined, never a caller-supplied toggle. If the
  // usage names a catalog_item_id that resolves to a tracked stock_item, the
  // deduction is mandatory and atomic with the usage record: either both are
  // written or neither is. (Chat D fix — the previous `deduct_stock` boolean
  // let a caller record material usage against a tracked item while choosing
  // not to move stock, so the ledger silently drifted from the truth.)
  let stockItem = null;
  if (body.catalog_item_id && req.db.stock_items) {
    stockItem = req.db.stock_items.find((s) => s.catalog_item_id === body.catalog_item_id) || null;
  }

  // Duplicate-submission protection (double click, retry after a timeout). Same
  // user + same key + same payload returns the usage already recorded and does
  // NOT deduct again; same key with a different payload is refused.
  const keyResult = readIdempotencyKey(req);
  if (keyResult.error) return res.status(400).json({ success: false, message: keyResult.error });
  const fingerprint = requestFingerprint({
    dispatch_card_id: dispatchId,
    catalog_item_id: body.catalog_item_id || null,
    description: body.description,
    quantity_used: Number(body.quantity_used),
    unit_cost: Number(body.unit_cost),
    unit_of_measure: body.unit_of_measure || null,
    override_negative: Boolean(body.override_negative)
  });
  const prior = findIdempotentRecord(req.db.material_usage, actor.id, keyResult.key, fingerprint, "created_by");
  if (prior.kind === "conflict") {
    return res.status(409).json({ success: false, message: "This idempotency key was already used for different material usage." });
  }
  if (prior.kind === "replay") {
    const { idempotency_fingerprint, ...replayed } = prior.record;
    const priorMovement = (req.db.stock_movements || []).find((m) => m.reference_type === "material_usage" && m.reference_id === prior.record.id);
    return res.json({
      success: true,
      idempotent_replay: true,
      data: replayed,
      ...(priorMovement && stockItem ? { stock_deducted: { item: stockItem.item_code, quantity: priorMovement.quantity, remaining: stockItem.quantity_on_hand, is_low_stock: stockItem.quantity_on_hand <= (stockItem.reorder_level ?? 0) } } : {})
    });
  }

  // Unit safety: when the caller states a unit for a tracked item it must be the
  // item's own unit. Quantities are never converted or silently reinterpreted.
  if (stockItem && body.unit_of_measure
      && String(body.unit_of_measure).trim().toLowerCase() !== String(stockItem.unit_of_measure).trim().toLowerCase()) {
    return res.status(409).json({ success: false, message: `Unit mismatch: this item is stocked in ${stockItem.unit_of_measure}, not ${body.unit_of_measure}. Quantities are never converted automatically.` });
  }

  const usage = {
    id: req.store.id("mu"),
    dispatch_card_id: dispatchId,
    catalog_item_id: body.catalog_item_id || null,
    description: body.description,
    quantity_used: body.quantity_used,
    unit_cost: body.unit_cost,
    total_cost: body.quantity_used * body.unit_cost,
    created_by: actor.id,
    idempotency_key: keyResult.key,
    idempotency_fingerprint: keyResult.key ? fingerprint : null
  };

  // Every stock exit uses the shared ledger. Keep Chat D's fail-closed
  // behavior: neither material usage nor stock is recorded when this rejects.
  //
  // The usage record is registered BEFORE the movement is built so the ledger's
  // reference label can resolve it ("Material usage on dispatch JOB-x") instead
  // of reading "(not found)"; it is removed again if the deduction is refused,
  // so the all-or-nothing guarantee is unchanged (handlers are synchronous).
  let stockResult = null;
  if (stockItem) {
    req.db.material_usage.push(usage);
    stockResult = applyStockChange({
      store: req.store,
      db: req.db,
      stockItem,
      movementType: "out",
      requestedQuantity: body.quantity_used,
      reason: `Worksheet material usage - dispatch ${job.dispatch_number}`,
      referenceId: usage.id,
      referenceType: "material_usage",
      overrideNegative: body.override_negative,
      idempotencyKey: keyResult.key,
      idempotencyFingerprint: keyResult.key ? fingerprint : null,
      actor
    });
    if (!stockResult.ok) {
      req.db.material_usage.splice(req.db.material_usage.indexOf(usage), 1);
      return res.status(stockResult.status).json({ success: false, message: stockResult.message });
    }
  } else {
    req.db.material_usage.push(usage);
  }

  req.store.recalculateVariance(req.db, job.purchase_order_id);
  // The payload fingerprint is internal bookkeeping: never audited, never returned.
  const { idempotency_fingerprint: _omitFingerprint, ...usageForResponse } = usage;
  req.store.audit(req.db, actor, "material_usage", usage.id, "MATERIAL_USAGE_ADDED", null, usageForResponse);

  if (!stockResult) {
    return res.json({ success: true, data: usageForResponse });
  }

  req.store.audit(req.db, actor, "stock_movement", stockResult.movement.id, "STOCK_DEDUCTED_VIA_WORKSHEET", stockResult.before, { ...stockResult.stockItem, movement: publicMovement(stockResult.movement) });

  return res.json({
    success: true,
    data: usageForResponse,
    stock_deducted: {
      item: stockResult.stockItem.item_code,
      quantity: stockResult.movement.quantity,
      remaining: stockResult.stockItem.quantity_on_hand,
      is_low_stock: stockResult.stockItem.quantity_on_hand <= (stockResult.stockItem.reorder_level ?? 0)
    }
  });
};

// Read-only, dispatch-scoped material availability. Field roles do not get a
// general stock_items/catalog listing (see collectionGuards in
// coreController.js — that is a deliberate separation-of-duties boundary,
// not a bug, and is out of Chat D's scope to widen). This endpoint instead
// answers "what material is linked to THIS dispatch, and is it low/out of
// stock" using only tracked items already used on a dispatch the actor is
// assigned to, trimmed to the fields a field role needs to see what blocks
// completion (no unit_cost, no supplier data).
export const getDispatchMaterialStatus = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "addMaterials");

  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;

  const usageForDispatch = (req.db.material_usage || []).filter((entry) => entry.dispatch_card_id === dispatchId);
  const catalogItemIds = [...new Set(usageForDispatch.map((entry) => entry.catalog_item_id).filter(Boolean))];

  const items = catalogItemIds
    .map((catalogItemId) => {
      const stockItem = (req.db.stock_items || []).find((s) => s.catalog_item_id === catalogItemId);
      if (!stockItem) return null;
      const usedQuantity = usageForDispatch
        .filter((entry) => entry.catalog_item_id === catalogItemId)
        .reduce((sum, entry) => sum + Number(entry.quantity_used || 0), 0);
      return {
        catalog_item_id: catalogItemId,
        item_code: stockItem.item_code,
        item_name: stockItem.item_name,
        unit_of_measure: stockItem.unit_of_measure,
        quantity_on_hand: stockItem.quantity_on_hand,
        is_low_stock: stockItem.quantity_on_hand <= (stockItem.reorder_level ?? 0),
        used_on_this_dispatch: usedQuantity
      };
    })
    .filter(Boolean);

  res.json({ success: true, data: items });
};

export const createWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createWorksheet");
  
  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireWorksheetDispatchAccess(actor, job, req.db, res)) return;

  const body = req.body;
  // Sales Desk paper entry: Sales enters signed paper under its own account, never as a Supervisor.
  const paperError = paperEntryCreateRefusal(actor, body);
  if (paperError) return res.status(400).json({ success: false, code: "PAPER_ENTRY_INVALID", message: paperError });
  const isPaperEntryRequest = body.source === PAPER_SOURCE;
  if (isPaperEntryRequest && body.hours_breakdown === undefined) {
    return res.status(400).json({ success: false, code: "PAPER_ENTRY_INVALID", message: "A paper entry must give Normal, 1.5 and 2.0 hours exactly as written on the paper." });
  }
  const isContractorOnBehalf = body.worker_type === "contractor" && !body.technician_id && (STAFF_ROLES.includes(actor.role) || actor.role === roles.SALES);
  if (isContractorOnBehalf && !String(body.worker_name || "").trim()) {
    return res.status(400).json({ success: false, message: "A contractor name is required when entering a Timesheet for a contractor without an account." });
  }
  // Sales is never the worker: the paper names the Technician (or contractor), so Sales must say who.
  const technicianId = isContractorOnBehalf ? null : (actor.role === roles.SALES
    ? (body.technician_id || null)
    : [roles.ADMIN, roles.OPERATIONS].includes(actor.role)
      ? (body.technician_id || job.assigned_technician_id || (job.assigned_technician_ids || [])[0])
      : actor.id);
  const technician = technicianId ? req.db.users.find((user) => user.id === technicianId && user.role === roles.TECHNICIAN) : null;
  if (!technician && !isContractorOnBehalf) return res.status(400).json({ success: false, message: "A valid Technician is required for a timesheet." });
  const quoteLine = v5QuoteLineForWorksheet(req.db, job, body.quote_line_id);
  if (quoteLine.error) return res.status(400).json({ success: false, message: quoteLine.error });

  // Offline sync: a retried create with the same reference never makes a second record.
  const requestId = body.client_request_id ? String(body.client_request_id) : null;
  const fingerprint = timesheetFingerprint(dispatchId, technicianId, body);
  if (requestId) {
    const prior = (req.db.field_worksheets || []).find((w) => w.created_by === actor.id && w.client_request_id === requestId);
    if (prior) {
      if (prior.client_payload_hash !== fingerprint) return res.status(409).json({ success: false, message: "This submission reference was already used with different content. Start a new Timesheet." });
      return res.json({ success: true, data: prior, replayed: true });
    }
  }
  const worksheet = {
    id: req.store.id("ws"),
    dispatch_card_id: dispatchId,
    technician_id: technicianId,
    technician_trade: technician?.trade || null,
    quote_line_id: quoteLine.line?.id || null,
    worker_type: isContractorOnBehalf ? "contractor" : (body.worker_type || "technician"),
    worker_name: isContractorOnBehalf ? String(body.worker_name).trim() : (technician?.name || null),
    worker_category: body.worker_category || technician?.trade || "",
    work_date: body.work_date || new Date().toISOString().slice(0, 10),
    activity: body.activity,
    hours: body.hours,
    tools_used: String(body.tools_used || "").trim(),
    materials_used: body.materials_used || [],
    outcomes: String(body.outcomes || "").trim(),
    challenges: String(body.challenges || "").trim(),
    evidence_files: body.evidence_files || [],
    status: body.submit ? "Submitted" : "Draft",
    submitted_by: body.submit ? actor.id : null,
    supervisor_comment: "",
    approved_by: null,
    approved_at: null,
    created_by: actor.id,
    created_at: new Date().toISOString(),
    submitted_at: body.submit ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  const fieldError = applyTimesheetFields(worksheet, body, actor, { creating: true });
  if (fieldError) return res.status(400).json({ success: false, message: fieldError });
  // created_by stays the real actor (set above); this adds source, capture_method and the paper evidence block.
  if (isPaperEntryRequest) stampPaperEntry(worksheet, actor, body, worksheet.created_at);
  if (isTimesheetV2(worksheet)) {
    if (!isIsoDate(worksheet.work_date)) return res.status(400).json({ success: false, message: "Work date must be a valid date (YYYY-MM-DD)." });
    // One worker + one date + one dispatch = one Timesheet. A second one is refused, not merged.
    const dup = (req.db.field_worksheets || []).find((w) => isTimesheetV2(w) && !w.superseded_by && w.dispatch_card_id === dispatchId
      && w.work_date === worksheet.work_date && sameWorker(w, worksheet));
    if (dup) return res.status(409).json({ success: false, code: "DUPLICATE_TIMESHEET", message: `A Timesheet for this worker, date and dispatch already exists (${dup.id}, ${dup.status}). Open and edit it, or revise it if it is already acknowledged or approved.`, existing_id: dup.id });
    if (body.submit) {
      const missing = employeeSignoffMissing(worksheet);
      if (missing.length) return res.status(400).json({ success: false, code: "SIGNOFF_INCOMPLETE", message: `The worker's sign-off is incomplete (${missing.join(", ")}).` });
    }
    worksheet.client_request_id = requestId;
    worksheet.client_payload_hash = requestId ? fingerprint : null;
    worksheet.captured_offline_at = body.captured_offline_at || null;
    worksheet.synced_at = body.captured_offline_at ? worksheet.created_at : null;
    worksheet.server_checks = classifyTimesheet(worksheet);
  }

  req.db.field_worksheets.push(worksheet);
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, worksheet.status === "Submitted" ? "WORKSHEET_SUBMITTED" : "WORKSHEET_CREATED", null, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const updateWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Timesheet not found." });
  const job = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireWorksheetDispatchAccess(actor, job, req.db, res)) return;
  if (actor.role === roles.TECHNICIAN && worksheet.technician_id !== actor.id) {
    return res.status(403).json({ success: false, message: "A Technician may edit only their own worksheet." });
  }
  const salesScope = salesOwnPaperEntryRefusal(actor, worksheet);
  if (salesScope) return res.status(403).json({ success: false, message: salesScope });
  
  if (!["Draft", "Returned_For_Correction"].includes(worksheet.status)) {
    return res.status(400).json({ success: false, message: `Timesheet cannot be edited in ${worksheet.status} status.` });
  }

  const before = { ...worksheet };
  const body = req.body;
  const paperUpdateError = paperEntryUpdateRefusal(worksheet, body);
  if (paperUpdateError) return res.status(400).json({ success: false, code: "PAPER_ENTRY_INVALID", message: paperUpdateError });
  
  if (body.activity !== undefined) worksheet.activity = body.activity;
  if (body.quote_line_id !== undefined) {
    const quoteLine = v5QuoteLineForWorksheet(req.db, job, body.quote_line_id);
    if (quoteLine.error) return res.status(400).json({ success: false, message: quoteLine.error });
    worksheet.quote_line_id = quoteLine.line?.id || null;
  }
  const updateError = applyTimesheetFields(worksheet, body, actor, { creating: false });
  if (updateError) return res.status(400).json({ success: false, message: updateError });
  applyPaperEntryUpdate(worksheet, body);
  if (isTimesheetV2(worksheet)) worksheet.server_checks = classifyTimesheet(worksheet);
  if (body.tools_used !== undefined) worksheet.tools_used = String(body.tools_used || "").trim();
  if (body.outcomes !== undefined) worksheet.outcomes = String(body.outcomes || "").trim();
  if (body.challenges !== undefined) worksheet.challenges = String(body.challenges || "").trim();
  
  worksheet.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, "WORKSHEET_UPDATED", before, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const submitWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Timesheet not found." });
  const job = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireWorksheetDispatchAccess(actor, job, req.db, res)) return;
  if (actor.role === roles.TECHNICIAN && worksheet.technician_id !== actor.id) {
    return res.status(403).json({ success: false, message: "A Technician may submit only their own worksheet." });
  }
  const salesScope = salesOwnPaperEntryRefusal(actor, worksheet);
  if (salesScope) return res.status(403).json({ success: false, message: salesScope });
  
  if (!["Draft", "Returned_For_Correction"].includes(worksheet.status)) {
    return res.status(400).json({ success: false, message: `Timesheet cannot be submitted from ${worksheet.status}.` });
  }

  if (isTimesheetV2(worksheet)) {
    const missing = employeeSignoffMissing(worksheet);
    if (missing.length) return res.status(400).json({ success: false, code: "SIGNOFF_INCOMPLETE", message: `The worker's sign-off is incomplete (${missing.join(", ")}). Add it before submitting.` });
  }
  const before = { ...worksheet };
  const nowIso = new Date().toISOString();
  // Auditable resubmission: close the open client-return entry; history is append-only in meaning.
  if (worksheet.status === "Returned_For_Correction" && Array.isArray(worksheet.return_history)) {
    worksheet.return_history = worksheet.return_history.map((h) => (h.resubmitted_at ? h : { ...h, resubmitted_at: nowIso, resubmitted_by: actor.id }));
  }
  worksheet.status = "Submitted";
  worksheet.submitted_by = actor.id;
  worksheet.submitted_at = new Date().toISOString();
  if (isTimesheetV2(worksheet)) worksheet.server_checks = classifyTimesheet(worksheet);
  worksheet.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, "WORKSHEET_SUBMITTED", before, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const reviewWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reviewWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Timesheet not found." });
  const assignedDispatch = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!assignedDispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, assignedDispatch, req.db, res)) return;
  
  // Chat B: an independent ORAC Supervisor reviews only after the client
  // representative has acknowledged the work. Submitted-but-not-yet-
  // acknowledged worksheets are not eligible for Supervisor review.
  if (worksheet.status !== "Client_Acknowledged") {
    return res.status(400).json({ success: false, message: `Timesheet review requires Client_Acknowledged status, not ${worksheet.status}.` });
  }

  const { decision, comment } = req.body;
  if (decision === "return" && !String(comment || "").trim()) {
    return res.status(400).json({ success: false, message: "Returning a timesheet requires a supervisor comment." });
  }

  if (decision === "approve") {
    const submissionAudit = (req.db.audit_logs || [])
      .filter((entry) => entry.entity_type === "field_worksheet" && entry.entity_id === worksheet.id && entry.action === "WORKSHEET_SUBMITTED")
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))[0];
    const submittedBy = worksheet.submitted_by || submissionAudit?.actor_id;
    if (!submittedBy) {
      return res.status(409).json({
        success: false,
        message: "Timesheet approval is blocked because its submission ownership cannot be verified. Return and resubmit the worksheet."
      });
    }
    if (submittedBy === actor.id) {
      return res.status(403).json({
        success: false,
        message: "The user who submitted this timesheet cannot approve it. Assign an independent reviewer."
      });
    }

    const dispatch = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
    const purchaseOrder = dispatch && req.db.purchase_orders.find((item) =>
      item.id === dispatch.purchase_order_id || item.quotation_id === dispatch.quotation_id
    );
    if (purchaseOrder?.verified_by === actor.id) {
      return res.status(403).json({
        success: false,
        message: "The user who verified this purchase order cannot approve its field worksheet. Assign an independent reviewer."
      });
    }
  }

  const before = { ...worksheet };
  if (isTimesheetV2(worksheet)) {
    // Reviewer sees (and the record keeps) the server's own classification at the moment of approval.
    worksheet.server_checks = classifyTimesheet(worksheet);
    if (decision === "approve") {
      if (worksheet.server_checks.flags.some((f) => f.severity === "blocking")) {
        return res.status(409).json({ success: false, code: "BLOCKING_FLAGS", message: `This Timesheet has blocking checks: ${worksheet.server_checks.flags.filter((f) => f.severity === "blocking").map((f) => f.message).join(" ")} Return it for correction.` });
      }
      worksheet.flags_at_approval = worksheet.server_checks.flags.filter((f) => f.severity !== "info");
    }
  }
  worksheet.status = decision === "approve" ? "Supervisor_Approved" : "Returned_For_Correction";
  worksheet.supervisor_comment = comment || "";
  worksheet.approved_by = decision === "approve" ? actor.id : null;
  worksheet.approved_at = decision === "approve" ? new Date().toISOString() : null;
  worksheet.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, decision === "approve" ? "WORKSHEET_APPROVED" : "WORKSHEET_RETURNED", before, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const approveAmendment = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "approveAmendment");
  
  const poId = req.params.id;
  const po = req.db.purchase_orders.find((item) => item.id === poId);
  if (!po) return res.status(404).json({ success: false, message: "Purchase order not found." });

  // GAP FIX (Chat E, separation of duties): same maker-checker rule already
  // applied to worksheet approval (see reviewWorksheet). The user who verified
  // the PO amount must not also approve an increase to that same amount.
  // Admin is not exempt: the rule is about the individual, not the role.
  if (po.verified_by && po.verified_by === actor.id) {
    return res.status(403).json({
      success: false,
      message: "The user who verified this purchase order cannot approve its amendment. Assign an independent approver."
    });
  }

  const newAmount = req.body.new_amount;
  const evidencedValue = calculatePurchaseOrderEvidenceValue(req.db, po.id);
  if (evidencedValue <= Number(po.po_amount)) {
    return res.status(409).json({
      success: false,
      message: "No recorded PO overrun requires an amendment. Record the additional work or materials first, then approve it during monthly reconciliation."
    });
  }
  if (newAmount <= po.po_amount) {
    return res.status(400).json({ success: false, message: "Amended PO amount must be greater than current PO amount." });
  }
  if (newAmount < evidencedValue) {
    return res.status(400).json({
      success: false,
      message: "Amended PO amount must cover the recorded work and materials before invoice readiness can be restored."
    });
  }

  const amendment = {
    id: req.store.id("amend"),
    purchase_order_id: poId,
    reason: String(req.body.reason || "Timesheet/material variance").trim(),
    previous_amount: po.po_amount,
    new_amount: newAmount,
    approved_by: actor.id,
    approved_at: new Date().toISOString()
  };
  
  req.db.po_amendments.push(amendment);
  const before = { ...po };
  po.po_amount = newAmount;
  po.requires_amendment = false;
  req.store.recalculateVariance(req.db, po.id);
  req.store.audit(req.db, actor, "po_amendment", amendment.id, "PO_AMENDMENT_APPROVED", before, { po, amendment });
  
  res.json({ success: true, data: amendment });
};
