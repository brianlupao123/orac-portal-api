import { exportInvoicesCsv } from "../exporter.js";
import { requirePermission } from "../permissions.js";
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
  audit_logs: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  invoices: [roles.ADMIN, roles.FINANCE, roles.MANAGEMENT],
  purchase_orders: [roles.ADMIN, roles.FINANCE, roles.OPERATIONS, roles.MANAGEMENT],
  // NEW — Phase 6: names/emails of everyone who has ever requested access.
  // Admin-only, same reasoning as `users`.
  access_requests: [roles.ADMIN]
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

export const getSummary = (req, res) => {
  const actor = getActor(req);

  let quotesData = req.db.quotes;
  let dispatchData = req.db.dispatch_cards;
  let invoicesData = req.db.invoices;
  let purchaseOrdersData = req.db.purchase_orders;
  let clientsCount = req.db.clients.length;

  if (isClientViewer(actor)) {
    quotesData = scopeByClient(quotesData, actor, clientScopedResolvers.quotes);
    dispatchData = scopeByClient(dispatchData, actor, (item) => clientScopedResolvers.dispatch_cards(item, req.db));
    invoicesData = scopeByClient(invoicesData, actor, (item) => clientScopedResolvers.invoices(item, req.db));
    purchaseOrdersData = scopeByClient(purchaseOrdersData, actor, (item) => clientScopedResolvers.purchase_orders(item, req.db));
    clientsCount = actor.client_id ? 1 : 0;
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
    res.json({ success: true, data });
  };
};

/**
 * Generic soft-delete: sets is_active = false on any entity in any collection.
 * For invoices, also sets status = "voided".
 */
export const deactivateEntity = (collectionName) => {
  return (req, res) => {
    const actor = getActor(req);
    if (!actor || !["Admin", "Management", "Finance"].includes(actor.role)) {
      return res.status(403).json({ success: false, message: "Only Admin, Management, or Finance can deactivate records." });
    }

    const collection = req.db[collectionName];
    if (!collection) return res.status(404).json({ success: false, message: "Collection not found." });

    const item = collection.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, message: `${collectionName} record not found.` });

    const before = { ...item };
    item.is_active = false;
    if (collectionName === "invoices") item.status = "voided";
    item.deactivated_by = actor.id;
    item.deactivated_at = new Date().toISOString();

    req.store.audit(req.db, actor, collectionName, item.id, `${collectionName.toUpperCase()}_DEACTIVATED`, before, item);
    res.json({ success: true, data: item });
  };
};

/**
 * Reactivate a soft-deleted entity.
 */
export const reactivateEntity = (collectionName) => {
  return (req, res) => {
    const actor = getActor(req);
    if (!actor || !["Admin"].includes(actor.role)) {
      return res.status(403).json({ success: false, message: "Only Admin can reactivate records." });
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
