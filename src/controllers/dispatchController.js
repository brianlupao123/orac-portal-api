import { requirePermission } from "../permissions.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

export const addTimesheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "addTimesheet");
  
  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });

  const body = req.body;
  const entry = {
    id: req.store.id("ts"),
    dispatch_card_id: dispatchId,
    user_id: actor.id,
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

  const body = req.body;
  const usage = {
    id: req.store.id("mu"),
    dispatch_card_id: dispatchId,
    catalog_item_id: body.catalog_item_id || null,
    description: body.description,
    quantity_used: body.quantity_used,
    unit_cost: body.unit_cost,
    total_cost: body.quantity_used * body.unit_cost
  };
  
  req.db.material_usage.push(usage);
  req.store.recalculateVariance(req.db, job.purchase_order_id);
  req.store.audit(req.db, actor, "material_usage", usage.id, "MATERIAL_USAGE_ADDED", null, usage);

  // Optional stock deduction (Phase 07). Only fires when caller passes deduct_stock:true
  // AND a catalog_item_id that resolves to a tracked stock_item. Non-breaking for existing worksheets.
  if (body.deduct_stock && body.catalog_item_id) {
    const stockItem = req.db.stock_items ? req.db.stock_items.find((s) => s.catalog_item_id === body.catalog_item_id) : null;
    if (stockItem) {
      const qty = -Math.abs(Number(body.quantity_used));
      const projected = stockItem.quantity_on_hand + qty;
      if (projected < 0 && !body.override_negative) {
        return res.json({ success: true, data: usage, stock_warning: `Insufficient stock for ${stockItem.item_code} (on hand: ${stockItem.quantity_on_hand}). Pass override_negative:true to force.` });
      }
      if (projected < 0 && !["Admin", "Operations"].includes(actor.role)) {
        return res.json({ success: true, data: usage, stock_warning: `Stock deduction skipped: only Admin or Operations may override negative-stock for ${stockItem.item_code}.` });
      }
      const beforeStock = { ...stockItem };
      stockItem.quantity_on_hand = stockItem.quantity_on_hand + qty;
      const movement = {
        id: req.store.id("smv"),
        stock_item_id: stockItem.id,
        movement_type: "out",
        quantity: qty,
        quantity_after: stockItem.quantity_on_hand,
        reason: `Worksheet material usage — dispatch ${job.dispatch_number}`,
        reference_id: usage.id,
        override_negative: body.override_negative || false,
        actor_id: actor.id,
        created_at: new Date().toISOString()
      };
      if (!req.db.stock_movements) req.db.stock_movements = [];
      req.db.stock_movements.push(movement);
      req.store.audit(req.db, actor, "stock_movement", movement.id, "STOCK_DEDUCTED_VIA_WORKSHEET", beforeStock, { ...stockItem, movement });
      return res.json({ success: true, data: usage, stock_deducted: { item: stockItem.item_code, quantity: qty, remaining: stockItem.quantity_on_hand } });
    }
  }

  res.json({ success: true, data: usage });
};

export const createWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createWorksheet");
  
  const dispatchId = req.params.id;
  const job = req.db.dispatch_cards.find((item) => item.id === dispatchId);
  if (!job) return res.status(404).json({ success: false, message: "Dispatch card not found." });

  const body = req.body;
  const worksheet = {
    id: req.store.id("ws"),
    dispatch_card_id: dispatchId,
    technician_id: body.technician_id || actor.id,
    work_date: body.work_date || new Date().toISOString().slice(0, 10),
    activity: body.activity,
    hours: body.hours,
    tools_used: String(body.tools_used || "").trim(),
    materials_used: body.materials_used || [],
    outcomes: String(body.outcomes || "").trim(),
    challenges: String(body.challenges || "").trim(),
    evidence_files: body.evidence_files || [],
    status: body.submit ? "Submitted" : "Draft",
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

export const submitWorksheet = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitWorksheet");
  
  const worksheetId = req.params.id;
  const worksheet = req.db.field_worksheets.find((item) => item.id === worksheetId);
  if (!worksheet) return res.status(404).json({ success: false, message: "Worksheet not found." });
  
  if (!["Draft", "Returned_For_Correction"].includes(worksheet.status)) {
    return res.status(400).json({ success: false, message: `Worksheet cannot be submitted from ${worksheet.status}.` });
  }

  const before = { ...worksheet };
  worksheet.status = "Submitted";
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
  
  if (worksheet.status !== "Submitted") {
    return res.status(400).json({ success: false, message: `Worksheet review requires Submitted status, not ${worksheet.status}.` });
  }

  const { decision, comment } = req.body;
  if (decision === "return" && !String(comment || "").trim()) {
    return res.status(400).json({ success: false, message: "Returning a worksheet requires a supervisor comment." });
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
