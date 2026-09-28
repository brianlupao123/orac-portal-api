import { requirePermission, roles } from "../permissions.js";
import { dispatchHasActiveInvoice, INVOICED_DISPATCH_MESSAGE } from "../dispatchFreeze.js";
import { applyStockChange } from "../inventoryLedger.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function isAssignedToDispatch(actor, dispatch, db) {
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

function requireAssignedDispatch(actor, dispatch, db, res) {
  if (isAssignedToDispatch(actor, dispatch, db)) return true;
  res.status(403).json({ success: false, message: "This role may work only on an assigned dispatch." });
  return false;
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
        message: "A Technician's timesheet entry must reference a Supervisor-approved worksheet (source_worksheet_id)."
      });
    }
    const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
    if (!worksheet || worksheet.dispatch_card_id !== dispatchId || worksheet.technician_id !== actor.id) {
      return res.status(400).json({
        success: false,
        message: "source_worksheet_id must reference the Technician's own worksheet on this dispatch."
      });
    }
    if (worksheet.status !== "Supervisor_Approved") {
      return res.status(409).json({
        success: false,
        message: `Timesheet entry blocked: worksheet ${worksheetId} is '${worksheet.status}', not Supervisor-approved yet.`
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

  const usage = {
    id: req.store.id("mu"),
    dispatch_card_id: dispatchId,
    catalog_item_id: body.catalog_item_id || null,
    description: body.description,
    quantity_used: body.quantity_used,
    unit_cost: body.unit_cost,
    total_cost: body.quantity_used * body.unit_cost
  };

  // Every stock exit uses the shared ledger. Keep Chat D's fail-closed
  // behavior: neither material usage nor stock is recorded when this rejects.
  let stockResult = null;
  if (stockItem) {
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
      actor
    });
    if (!stockResult.ok) {
      return res.status(stockResult.status).json({ success: false, message: stockResult.message });
    }
  }

  req.db.material_usage.push(usage);
  req.store.recalculateVariance(req.db, job.purchase_order_id);
  req.store.audit(req.db, actor, "material_usage", usage.id, "MATERIAL_USAGE_ADDED", null, usage);

  if (!stockResult) {
    return res.json({ success: true, data: usage });
  }

  req.store.audit(req.db, actor, "stock_movement", stockResult.movement.id, "STOCK_DEDUCTED_VIA_WORKSHEET", stockResult.before, { ...stockResult.stockItem, movement: stockResult.movement });

  return res.json({
    success: true,
    data: usage,
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
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;

  const body = req.body;
  const technicianId = [roles.ADMIN, roles.OPERATIONS].includes(actor.role)
    ? (body.technician_id || job.assigned_technician_id || (job.assigned_technician_ids || [])[0])
    : actor.id;
  const technician = req.db.users.find((user) => user.id === technicianId && user.role === roles.TECHNICIAN);
  if (!technician) return res.status(400).json({ success: false, message: "A valid Technician is required for a timesheet." });
  const worksheet = {
    id: req.store.id("ws"),
    dispatch_card_id: dispatchId,
    technician_id: technicianId,
    technician_trade: technician.trade || null,
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
    created_at: new Date().toISOString(),
    submitted_at: body.submit ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  req.db.field_worksheets.push(worksheet);
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, worksheet.status === "Submitted" ? "WORKSHEET_SUBMITTED" : "WORKSHEET_CREATED", null, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const updateWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Worksheet not found." });
  const job = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  if (actor.role === roles.TECHNICIAN && worksheet.technician_id !== actor.id) {
    return res.status(403).json({ success: false, message: "A Technician may edit only their own worksheet." });
  }
  
  if (!["Draft", "Returned_For_Correction"].includes(worksheet.status)) {
    return res.status(400).json({ success: false, message: `Worksheet cannot be edited in ${worksheet.status} status.` });
  }

  const before = { ...worksheet };
  const body = req.body;
  
  if (body.activity !== undefined) worksheet.activity = body.activity;
  if (body.hours !== undefined) worksheet.hours = body.hours;
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
  if (!worksheet) return res.status(404).json({ success: false, message: "Worksheet not found." });
  const job = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, job, req.db, res)) return;
  if (actor.role === roles.TECHNICIAN && worksheet.technician_id !== actor.id) {
    return res.status(403).json({ success: false, message: "A Technician may submit only their own worksheet." });
  }
  
  if (!["Draft", "Returned_For_Correction"].includes(worksheet.status)) {
    return res.status(400).json({ success: false, message: `Worksheet cannot be submitted from ${worksheet.status}.` });
  }

  const before = { ...worksheet };
  worksheet.status = "Submitted";
  worksheet.submitted_by = actor.id;
  worksheet.submitted_at = new Date().toISOString();
  worksheet.updated_at = new Date().toISOString();
  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, "WORKSHEET_SUBMITTED", before, worksheet);
  
  res.json({ success: true, data: worksheet });
};

export const reviewWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "reviewWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Worksheet not found." });
  const assignedDispatch = req.db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
  if (!assignedDispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  if (!requireAssignedDispatch(actor, assignedDispatch, req.db, res)) return;
  
  // Chat B: an independent ORAC Supervisor reviews only after the client
  // representative has acknowledged the work. Submitted-but-not-yet-
  // acknowledged worksheets are not eligible for Supervisor review.
  if (worksheet.status !== "Client_Acknowledged") {
    return res.status(400).json({ success: false, message: `Worksheet review requires Client_Acknowledged status, not ${worksheet.status}.` });
  }

  const { decision, comment } = req.body;
  if (decision === "return" && !String(comment || "").trim()) {
    return res.status(400).json({ success: false, message: "Returning a worksheet requires a supervisor comment." });
  }

  if (decision === "approve") {
    const submissionAudit = (req.db.audit_logs || [])
      .filter((entry) => entry.entity_type === "field_worksheet" && entry.entity_id === worksheet.id && entry.action === "WORKSHEET_SUBMITTED")
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")))[0];
    const submittedBy = worksheet.submitted_by || submissionAudit?.actor_id;
    if (!submittedBy) {
      return res.status(409).json({
        success: false,
        message: "Worksheet approval is blocked because its submission ownership cannot be verified. Return and resubmit the worksheet."
      });
    }
    if (submittedBy === actor.id) {
      return res.status(403).json({
        success: false,
        message: "The user who submitted this worksheet cannot approve it. Assign an independent reviewer."
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
  if (newAmount <= po.po_amount) {
    return res.status(400).json({ success: false, message: "Amended PO amount must be greater than current PO amount." });
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
