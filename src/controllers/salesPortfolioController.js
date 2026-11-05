/**
 * src/controllers/salesPortfolioController.js
 * Dedicated endpoints for portfolio-scoped, redacted Sales summaries.
 * Prevents exposing raw operational and financial collections to Sales.
 */

import { roles } from "../permissions.js";
import {
  isQuoteInSalesPortfolio,
  isDispatchInSalesPortfolio,
  isInvoiceInSalesPortfolio
} from "./coreController.js";

function getActor(req) {
  return (req.db.users || []).find((u) => u.id === req.user?.id) || null;
}

function canAccessDispatch(actor, dispatch, db) {
  if (!actor || !actor.is_active) return false;
  if ([roles.ADMIN, roles.MANAGEMENT].includes(actor.role)) return true;
  if (actor.role === roles.SALES) {
    return isDispatchInSalesPortfolio(dispatch, actor, db);
  }
  return false;
}

export function getSalesPortfolioDispatches(req, res) {
  const actor = getActor(req);
  if (!actor || ![roles.ADMIN, roles.MANAGEMENT, roles.SALES].includes(actor.role)) {
    return res.status(403).json({ success: false, message: "Unauthorized." });
  }

  const dispatches = (req.db.dispatch_cards || []).filter((dispatch) =>
    canAccessDispatch(actor, dispatch, req.db)
  );

  const redacted = dispatches.map((d) => ({
    id: d.id,
    dispatch_number: d.dispatch_number,
    quotation_id: d.quotation_id,
    purchase_order_id: d.purchase_order_id || null,
    client_id: d.client_id || null,
    status: d.status,
    scheduled_start: d.scheduled_start || null,
    scheduled_end: d.scheduled_end || null,
    site_contact: d.site_contact || null,
    created_at: d.created_at || null
  }));

  res.json({ success: true, data: redacted });
}

export function getSalesDispatchProgress(req, res) {
  const actor = getActor(req);
  const dispatch = (req.db.dispatch_cards || []).find((d) => d.id === req.params.id);
  if (!dispatch) {
    return res.status(404).json({ success: false, message: "Dispatch card not found." });
  }

  if (!canAccessDispatch(actor, dispatch, req.db)) {
    return res.status(403).json({ success: false, message: "You are not authorized to view this dispatch." });
  }

  const worksheets = (req.db.field_worksheets || []).filter((w) => w.dispatch_card_id === dispatch.id);
  const approvedWorksheets = worksheets.filter((w) =>
    ["Approved", "Supervisor_Approved"].includes(w.status)
  );

  res.json({
    success: true,
    data: {
      dispatch_id: dispatch.id,
      dispatch_number: dispatch.dispatch_number,
      status: dispatch.status,
      worksheets_total: worksheets.length,
      worksheets_approved: approvedWorksheets.length,
      is_completed: dispatch.status === "Completed"
    }
  });
}

export function getSalesApprovedWorkSummary(req, res) {
  const actor = getActor(req);
  const dispatch = (req.db.dispatch_cards || []).find((d) => d.id === req.params.id);
  if (!dispatch) {
    return res.status(404).json({ success: false, message: "Dispatch card not found." });
  }

  if (!canAccessDispatch(actor, dispatch, req.db)) {
    return res.status(403).json({ success: false, message: "You are not authorized to view this dispatch." });
  }

  // Rate-free summary: hours and tasks only, zero technician pay rates or labour cost
  const approvedWorksheets = (req.db.field_worksheets || [])
    .filter((w) => w.dispatch_card_id === dispatch.id && ["Approved", "Supervisor_Approved"].includes(w.status))
    .map((w) => ({
      worksheet_id: w.id,
      status: w.status,
      hours: Number(w.hours) || 0,
      supervisor_approved_at: w.supervisor_approved_at || null,
      evidence_files_count: (w.evidence_files || []).length
    }));

  res.json({
    success: true,
    data: {
      dispatch_id: dispatch.id,
      approved_worksheets: approvedWorksheets,
      total_approved_hours: approvedWorksheets.reduce((sum, item) => sum + item.hours, 0)
    }
  });
}

export function getSalesMaterialsSummary(req, res) {
  const actor = getActor(req);
  const dispatch = (req.db.dispatch_cards || []).find((d) => d.id === req.params.id);
  if (!dispatch) {
    return res.status(404).json({ success: false, message: "Dispatch card not found." });
  }

  if (!canAccessDispatch(actor, dispatch, req.db)) {
    return res.status(403).json({ success: false, message: "You are not authorized to view this dispatch." });
  }

  // Description, quantity, and fulfilment status ONLY.
  // Suppress unit cost, total cost, supplier details, and stock value.
  const materials = (req.db.material_usage || [])
    .filter((m) => m.dispatch_card_id === dispatch.id)
    .map((m) => ({
      id: m.id,
      description: m.description || m.item_description || "Material",
      quantity: m.quantity || 1,
      fulfilment_status: m.fulfilment_status || m.status || "Fulfilled"
    }));

  res.json({
    success: true,
    data: {
      dispatch_id: dispatch.id,
      materials
    }
  });
}

export function getSalesPortfolioInvoices(req, res) {
  const actor = getActor(req);
  if (!actor || ![roles.ADMIN, roles.MANAGEMENT, roles.SALES].includes(actor.role)) {
    return res.status(403).json({ success: false, message: "Unauthorized." });
  }

  const invoices = (req.db.invoices || []).filter((inv) => {
    if ([roles.ADMIN, roles.MANAGEMENT].includes(actor.role)) return true;
    return isInvoiceInSalesPortfolio(inv, actor, req.db);
  });

  const redacted = invoices.map((inv) => ({
    id: inv.id,
    invoice_number: inv.invoice_number,
    quotation_id: inv.quotation_id || null,
    dispatch_card_id: inv.dispatch_card_id || null,
    total_amount: inv.total_amount || 0,
    currency: "USD",
    status: inv.status,
    created_at: inv.created_at || inv.generated_at || null
  }));

  res.json({ success: true, data: redacted });
}

export function getSalesPortfolioPurchaseOrders(req, res) {
  const actor = getActor(req);
  if (!actor || ![roles.ADMIN, roles.MANAGEMENT, roles.SALES].includes(actor.role)) {
    return res.status(403).json({ success: false, message: "Unauthorized." });
  }

  const pos = (req.db.purchase_orders || []).filter((po) => {
    if ([roles.ADMIN, roles.MANAGEMENT].includes(actor.role)) return true;
    return isPurchaseOrderInSalesPortfolio(po, actor, req.db);
  });

  const redacted = pos.map((po) => ({
    id: po.id,
    po_reference: po.po_reference,
    quotation_id: po.quotation_id || null,
    client_id: po.client_id || null,
    po_amount: po.po_amount || 0,
    status: po.status,
    requires_amendment: Boolean(po.requires_amendment),
    created_at: po.created_at || null
  }));

  res.json({ success: true, data: redacted });
}
