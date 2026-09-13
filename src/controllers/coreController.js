import { exportInvoicesCsv } from "../exporter.js";
import { hasPermission, requirePermission } from "../permissions.js";
import { roles } from "../permissions.js";
import { isClientViewer, scopeByClient } from "../middleware/clientScope.js";

function getActor(req) {
  // GET endpoints might be called by an authenticated user
  if (!req.user) return req.db.users[0]; // fallback for unauthenticated leads
  return req.db.users.find((u) => u.id === req.user.id);
}

// Role guards for generic collection GET endpoints.
// Collections not listed here remain open to any authenticated user.
const collectionGuards = {
  users: [roles.ADMIN],
  // Master-data and commercial collections must be explicitly guarded. Field
  // roles receive context through their assigned dispatches/worksheets instead.
  clients: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  quotes: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  quote_lines: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  leads: [roles.ADMIN, roles.MANAGEMENT, roles.SALES],
  dispatch_cards: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN],
  field_worksheets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN],
  audit_logs: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  // Client Viewers may read invoices only after the client-scoping step below
  // filters them to their own organisation.
  invoices: [roles.ADMIN, roles.FINANCE, roles.MANAGEMENT, roles.CLIENT_VIEWER],
  purchase_orders: [roles.ADMIN, roles.FINANCE, roles.OPERATIONS, roles.MANAGEMENT],
  stock_movements: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  // NEW — Phase 6: names/emails of everyone who has ever requested access.
  // Admin-only, same reasoning as `users`.
  access_requests: [roles.ADMIN]
};

const archivePermissions = {
  users: "manageUsers",
  clients: "manageClients",
  mine_sites: "manageAssets",
  plants: "manageAssets",
  plant_sections: "manageAssets",
  equipment_tags: "manageAssets",
  catalog_items: "manageCatalog",
  suppliers: "manageInventory",
  stock_items: "manageInventory"
};

// Client Viewer isolation (Phase 06). Each resolver returns the owning
// client_id for one item so scopeByClient() can filter it to the caller's
// own client. Collections not listed here are unaffected (either no
// client owner, e.g. catalog_items, or already blocked above, e.g. users).
const clientScopedResolvers = {
  clients: (item) => item.id,
  quotes: (item) => item.client_id,
  quote_lines: (item, db) => db.quotes.find((q) => q.id === item.quotation_id)?.client_id || null,
  purchase_orders: (item, db) => db.quotes.find((q) => q.id === item.quotation_id)?.client_id || null,
  dispatch_cards: (item, db) => db.quotes.find((q) => q.id === item.quotation_id)?.client_id || null,
  field_worksheets: (item, db) => {
    const job = db.dispatch_cards.find((d) => d.id === item.dispatch_card_id);
    return job ? (db.quotes.find((q) => q.id === job.quotation_id)?.client_id || null) : null;
  },
  invoices: (item, db) => {
    const job = db.dispatch_cards.find((d) => d.id === item.dispatch_card_id);
    return job ? (db.quotes.find((q) => q.id === job.quotation_id)?.client_id || null) : null;
  }
};

function isTechnicianAssignedToDispatch(dispatch, actor, db) {
  return dispatch.assigned_technician_id === actor.id ||
    dispatch.technician_id === actor.id ||
    dispatch.assigned_to === actor.id ||
    db.field_worksheets.some((worksheet) =>
      worksheet.dispatch_card_id === dispatch.id && worksheet.technician_id === actor.id
    );
}

function isSupervisorAssignedToDispatch(dispatch, actor, db) {
  return dispatch.assigned_supervisor_id === actor.id ||
    dispatch.supervisor_id === actor.id ||
    db.field_worksheets.some((worksheet) =>
      worksheet.dispatch_card_id === dispatch.id && worksheet.supervisor_id === actor.id
    );
}

function scopeOperationalData(data, collectionName, actor, db) {
  if (actor?.role === roles.TECHNICIAN) {
    if (collectionName === "dispatch_cards") {
      return data.filter((dispatch) => isTechnicianAssignedToDispatch(dispatch, actor, db));
    }
    if (collectionName === "field_worksheets") {
      return data.filter((worksheet) => worksheet.technician_id === actor.id);
    }
  }

  if (actor?.role === roles.SUPERVISOR) {
    if (collectionName === "dispatch_cards") {
      return data.filter((dispatch) => isSupervisorAssignedToDispatch(dispatch, actor, db));
    }
    if (collectionName === "field_worksheets") {
      return data.filter((worksheet) => {
        const dispatch = db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id);
        return worksheet.supervisor_id === actor.id ||
          (dispatch && isSupervisorAssignedToDispatch(dispatch, actor, db));
      });
    }
  }

  return data;
}

export const getSummary = (req, res) => {
  const actor = getActor(req);

  let quotesData = req.db.quotes;
  let dispatchData = req.db.dispatch_cards;
  let invoicesData = req.db.invoices;
  let purchaseOrdersData = req.db.purchase_orders;
  let clientsCount = req.db.clients.length;
  let worksheetsData = req.db.field_worksheets;

  if (isClientViewer(actor)) {
    quotesData = scopeByClient(quotesData, actor, clientScopedResolvers.quotes);
    dispatchData = scopeByClient(dispatchData, actor, (item) => clientScopedResolvers.dispatch_cards(item, req.db));
    invoicesData = scopeByClient(invoicesData, actor, (item) => clientScopedResolvers.invoices(item, req.db));
    purchaseOrdersData = scopeByClient(purchaseOrdersData, actor, (item) => clientScopedResolvers.purchase_orders(item, req.db));
    clientsCount = actor.client_id ? 1 : 0;
  }

  if (actor?.role === roles.TECHNICIAN || actor?.role === roles.SUPERVISOR) {
    dispatchData = scopeOperationalData(dispatchData, "dispatch_cards", actor, req.db);
    worksheetsData = scopeOperationalData(worksheetsData, "field_worksheets", actor, req.db);
    quotesData = [];
    invoicesData = [];
    purchaseOrdersData = [];
    clientsCount = 0;
  }

  const statusCounts = quotesData.reduce((acc, quote) => {
    acc[quote.status] = (acc[quote.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    data: {
      clients: clientsCount,
      quotes: quotesData.length,
      dispatches: dispatchData.length,
      invoices: invoicesData.length,
      worksheets: worksheetsData.length,
      pending_review: worksheetsData.filter((worksheet) => worksheet.status === "Submitted").length,
      returned_for_correction: worksheetsData.filter((worksheet) => worksheet.status === "Returned_For_Correction").length,
      pending_po: quotesData.filter((quote) => quote.status === "Approved_Pending_PO").length,
      blocked_amendments: purchaseOrdersData.filter((po) => po.requires_amendment).length,
      status_counts: statusCounts
    }
  });
};

export const exportPastel = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "exportPastel");
  const csv = exportInvoicesCsv(req.db);
  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Content-Disposition", "attachment; filename=orac-pastel-export.csv");
  res.send(csv);
};

export const createLead = (req, res) => {
  const actor = getActor(req); // Lead is typically public, so we might not have a strong actor context. We fallback to first user.

  const body = req.body;
  const lead = {
    id: req.store.id("lead"),
    company_name: body.company_name,
    contact_name: body.contact_name,
    email: body.email,
    phone: String(body.phone || "").trim(),
    mine_site: String(body.mine_site || "").trim(),
    service_need: body.service_need,
    urgency: String(body.urgency || "standard").trim(),
    status: "New",
    created_at: new Date().toISOString()
  };

  req.db.leads.push(lead);
  req.store.audit(req.db, actor, "lead", lead.id, "LEAD_CREATED", null, lead);

  res.json({ success: true, data: lead });
};

export const getCollection = (collectionName) => {
  return (req, res) => {
    if (!req.db[collectionName]) {
      return res.status(404).json({ success: false, message: "Collection not found" });
    }
    const actor = getActor(req);
    const allowedRoles = collectionGuards[collectionName];
    if (allowedRoles) {
      if (!actor?.is_active || !allowedRoles.includes(actor.role)) {
        return res.status(403).json({
          success: false,
          message: `Role ${actor?.role || "Unknown"} cannot view ${collectionName}.`
        });
      }
    }
    let data = req.db[collectionName];
    const resolveClientId = clientScopedResolvers[collectionName];
    if (resolveClientId && isClientViewer(actor)) {
      data = scopeByClient(data, actor, (item) => resolveClientId(item, req.db));
    }
    data = scopeOperationalData(data, collectionName, actor, req.db);
    res.json({ success: true, data });
  };
};

/** Generic archive control for master data only. */
export const deactivateEntity = (collectionName) => {
  return (req, res) => {
    const actor = getActor(req);
    const requiredPermission = archivePermissions[collectionName];
    if (!requiredPermission) {
      return res.status(405).json({
        success: false,
        message: `${collectionName} records are immutable and cannot be archived through the generic route.`
      });
    }
    if (!hasPermission(actor, requiredPermission)) {
      return res.status(403).json({ success: false, message: `Role ${actor?.role || "Unknown"} cannot archive ${collectionName}.` });
    }

    const collection = req.db[collectionName];
    if (!collection) return res.status(404).json({ success: false, message: "Collection not found." });

    const item = collection.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: `${collectionName} record not found.` });

    const before = { ...item };
    item.is_active = false;
    item.deactivated_by = actor.id;
    item.deactivated_at = new Date().toISOString();

    req.store.audit(req.db, actor, collectionName, item.id, `${collectionName.toUpperCase()}_DEACTIVATED`, before, item);
    res.json({ success: true, data: item });
  };
};

/** Reactivate archived master data using the same domain permission. */
export const reactivateEntity = (collectionName) => {
  return (req, res) => {
    const actor = getActor(req);
    const requiredPermission = archivePermissions[collectionName];
    if (!requiredPermission) {
      return res.status(405).json({
        success: false,
        message: `${collectionName} records are immutable and cannot be reactivated through the generic route.`
      });
    }
    if (!hasPermission(actor, requiredPermission)) {
      return res.status(403).json({ success: false, message: `Role ${actor?.role || "Unknown"} cannot reactivate ${collectionName}.` });
    }

    const collection = req.db[collectionName];
    if (!collection) return res.status(404).json({ success: false, message: "Collection not found." });

    const item = collection.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: `${collectionName} record not found.` });

    const before = { ...item };
    item.is_active = true;
    delete item.deactivated_by;
    delete item.deactivated_at;

    req.store.audit(req.db, actor, collectionName, item.id, `${collectionName.toUpperCase()}_REACTIVATED`, before, item);
    res.json({ success: true, data: item });
  };
};

export const voidInvoice = (req, res) => {
  const actor = getActor(req);
  if (!actor || ![roles.ADMIN, roles.FINANCE].includes(actor.role)) {
    return res.status(403).json({ success: false, message: "Only Admin or Finance can void invoices." });
  }

  const reason = String(req.body?.reason || "").trim();
  if (!reason) {
    return res.status(400).json({ success: false, message: "A void reason is required." });
  }

  const invoice = req.db.invoices.find((item) => item.id === req.params.id);
  if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found." });

  const currentStatus = String(invoice.status || "").toLowerCase();
  if (currentStatus === "paid") {
    return res.status(409).json({ success: false, message: "Paid invoices cannot be voided. Issue a separate credit note or reversal instead." });
  }
  if (currentStatus === "voided") {
    return res.status(409).json({ success: false, message: "Invoice is already voided." });
  }

  const before = { ...invoice };
  invoice.status = "voided";
  invoice.void_reason = reason;
  invoice.voided_by = actor.id;
  invoice.voided_at = new Date().toISOString();

  req.store.audit(req.db, actor, "invoice", invoice.id, "INVOICE_VOIDED", before, invoice);
  res.json({ success: true, data: invoice });
};
