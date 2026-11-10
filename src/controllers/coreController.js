import { exportInvoicesCsv } from "../exporter.js";
import { toPublicUser } from "../accountTokens.js";
import { revokeSessions } from "../middleware/auth.js";
import { hasPermission, requirePermission, permissions } from "../permissions.js";
import { roles } from "../permissions.js";
import { isClientViewer, scopeByClient } from "../middleware/clientScope.js";
import {
  enrichClient,
  enrichMineSite,
  enrichPlant,
  enrichPlantSection,
  enrichEquipmentTag
} from "../services/entityHierarchy.js";
import { decorateMovementForDisplay } from "../inventoryLedger.js";
import { awaitsSupervisorReview } from "../timesheetEligibility.js";
import {
  LEAD_CREATE_SCOPE, IDEMPOTENCY_REPLAY_HEADER, canonicalLeadFields, leadRequestHash,
  pruneExpiredKeys, findActiveKey, buildKeyRecord, requestNowMs
} from "../idempotency.js";

export function getActor(req) {
  // GET endpoints might be called by an authenticated user
  if (!req.user) return req.db.users[0]; // fallback for unauthenticated leads
  return req.db.users.find((u) => u.id === req.user.id);
}

// Role guards for every generic collection GET endpoint. Keep this explicit:
// a newly mounted collection must receive a deliberate policy before it can
// return data to any authenticated account.
export const CLIENT_VISIBLE_QUOTE_STATUSES = Object.freeze([
  "Sent",
  "Approved_Pending_PO",
  "PO_Verified",
  "Field_Dispatch",
  "Invoiced"
]);

export const collectionGuards = {
  users: [roles.ADMIN],
  // Master-data and commercial collections must be explicitly guarded. Field
  // roles receive context through their assigned dispatches/worksheets instead.
  clients: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  quotes: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  quote_lines: [roles.ADMIN, roles.MANAGEMENT, roles.SALES, roles.FINANCE, roles.OPERATIONS, roles.CLIENT_VIEWER],
  leads: [roles.ADMIN, roles.MANAGEMENT, roles.SALES],
  dispatch_cards: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  field_worksheets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  // Daily Time Sheet / Contractors Log Sheet (paper-form digitisation).
  // Technician sees only their own daily_timesheets, enforced below in
  // scopeOperationalData. Contractor logs are crew-level and have no
  // individual-technician ownership, so Technician/Client Viewer are
  // excluded from the list entirely rather than scoped to an empty set.
  daily_timesheets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR, roles.TECHNICIAN, roles.SALES],
  contractor_log_sheets: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SUPERVISOR],
  audit_logs: [roles.ADMIN, roles.MANAGEMENT, roles.FINANCE],
  // Client Viewers may read invoices only after the client-scoping step below
  // filters them to their own organisation.
  invoices: [roles.ADMIN, roles.FINANCE, roles.MANAGEMENT, roles.SALES, roles.CLIENT_VIEWER],
  purchase_orders: [roles.ADMIN, roles.FINANCE, roles.OPERATIONS, roles.MANAGEMENT, roles.SALES],
  stock_movements: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SALES],
  mine_sites: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  plants: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  plant_sections: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  equipment_tags: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  // Catalog pricing is commercial master data. Operations receives material
  // context through approved work records, not an unrestricted catalog list.
  catalog_items: [roles.ADMIN, roles.MANAGEMENT],
  suppliers: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS],
  stock_items: [roles.ADMIN, roles.MANAGEMENT, roles.OPERATIONS, roles.SALES],
  // NEW — Phase 6: names/emails of everyone who has ever requested access.
  // Admin-only, same reasoning as `users`.
  access_requests: [...permissions.viewAccessRequests]
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

const sensitiveAuditKeys = new Set([
  "password",
  "password_hash",
  "reset_token",
  "reset_token_hash",
  "reset_token_expires_at",
  "totp"
]);

function redactSensitiveFields(value, extraKeys = new Set()) {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, extraKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveAuditKeys.has(key) && !extraKeys.has(key))
      .map(([key, entry]) => [key, redactSensitiveFields(entry, extraKeys)])
  );
}

// National ID is payroll PII: Admin may manage it on the user record, but it is
// never copied into the audit-log view (which Management and Finance can open).
const auditOnlyRedactedKeys = new Set(["national_id"]);

// Master-data collections in the Client -> Mine Site -> Plant -> Plant
// Section -> Equipment Tag hierarchy get their readable-name/breadcrumb
// enrichment applied here, once, for every consumer of `/${collection}`
// (the Admin entities screen, and anywhere else that lists this data)
// instead of each screen re-deriving parent names from raw foreign keys.
const hierarchyEnrichers = {
  clients: enrichClient,
  mine_sites: enrichMineSite,
  plants: enrichPlant,
  plant_sections: enrichPlantSection,
  equipment_tags: enrichEquipmentTag
};

function collectionResponseData(collectionName, data, db) {
  if (collectionName === "audit_logs") return redactSensitiveFields(data, auditOnlyRedactedKeys);
  if (collectionName === "users") return data.map(toPublicUser);
  if (collectionName === "stock_movements") {
    return data.map((movement) => decorateMovementForDisplay(db, movement));
  }
  const enrich = hierarchyEnrichers[collectionName];
  if (enrich) {
    return data.map((item) => enrich(db, item));
  }
  return data;
}

function isTechnicianAssignedToDispatch(dispatch, actor, db) {
  return dispatch.assigned_technician_id === actor.id ||
    dispatch.technician_id === actor.id ||
    dispatch.assigned_to === actor.id ||
    (dispatch.assigned_technician_ids || []).includes(actor.id) ||
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

export function isQuoteInSalesPortfolio(quote, actor, db) {
  if (!quote || !actor || actor.role !== roles.SALES) return false;
  if (quote.sales_owner_id === actor.id) return true;
  if (Array.isArray(quote.account_team_user_ids) && quote.account_team_user_ids.includes(actor.id)) return true;
  if (quote.client_id && db?.clients) {
    const client = db.clients.find((c) => c.id === quote.client_id);
    if (client) {
      if (client.primary_sales_owner_id === actor.id) return true;
      if (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id)) return true;
    }
  }
  return false;
}

export function isDispatchInSalesPortfolio(dispatch, actor, db) {
  if (!dispatch || !actor || actor.role !== roles.SALES) return false;
  if (dispatch.quotation_id && db?.quotes) {
    const quote = db.quotes.find((q) => q.id === dispatch.quotation_id);
    if (quote && isQuoteInSalesPortfolio(quote, actor, db)) return true;
  }
  if (dispatch.client_id && db?.clients) {
    const client = db.clients.find((c) => c.id === dispatch.client_id);
    if (client) {
      if (client.primary_sales_owner_id === actor.id) return true;
      if (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id)) return true;
    }
  }
  return false;
}

export function isInvoiceInSalesPortfolio(invoice, actor, db) {
  if (!invoice || !actor || actor.role !== roles.SALES) return false;
  if (invoice.quotation_id && db?.quotes) {
    const quote = db.quotes.find((q) => q.id === invoice.quotation_id);
    if (quote && isQuoteInSalesPortfolio(quote, actor, db)) return true;
  }
  if (invoice.dispatch_card_id && db?.dispatch_cards) {
    const dispatch = db.dispatch_cards.find((d) => d.id === invoice.dispatch_card_id);
    if (dispatch && isDispatchInSalesPortfolio(dispatch, actor, db)) return true;
  }
  if (invoice.client_id && db?.clients) {
    const client = db.clients.find((c) => c.id === invoice.client_id);
    if (client) {
      if (client.primary_sales_owner_id === actor.id) return true;
      if (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id)) return true;
    }
  }
  return false;
}

export function isPurchaseOrderInSalesPortfolio(po, actor, db) {
  if (!po || !actor || actor.role !== roles.SALES) return false;
  if (po.quotation_id && db?.quotes) {
    const quote = db.quotes.find((q) => q.id === po.quotation_id);
    if (quote && isQuoteInSalesPortfolio(quote, actor, db)) return true;
  }
  if (po.client_id && db?.clients) {
    const client = db.clients.find((c) => c.id === po.client_id);
    if (client) {
      if (client.primary_sales_owner_id === actor.id) return true;
      if (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id)) return true;
    }
  }
  return false;
}

export function scopeOperationalData(data, collectionName, actor, db) {
  if (actor?.role === roles.SALES) {
    if (collectionName === "quotes") {
      return data.filter((quote) => isQuoteInSalesPortfolio(quote, actor, db));
    }
    if (collectionName === "quote_lines") {
      return data.filter((line) => {
        const quote = (db?.quotes || []).find((q) => q.id === line.quotation_id);
        return quote && isQuoteInSalesPortfolio(quote, actor, db);
      });
    }
    if (collectionName === "clients") {
      return data.filter((client) =>
        client.primary_sales_owner_id === actor.id ||
        (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id))
      );
    }
    if (collectionName === "purchase_orders") {
      return data.filter((po) => isPurchaseOrderInSalesPortfolio(po, actor, db));
    }
    if (collectionName === "invoices") {
      return data.filter((invoice) => isInvoiceInSalesPortfolio(invoice, actor, db));
    }
    // Sales sees only dispatch_cards, field_worksheets, and daily_timesheets
    // that belong to quotes in their commercial portfolio (read-only browse).
    if (collectionName === "dispatch_cards") {
      return data.filter((dispatch) => isDispatchInSalesPortfolio(dispatch, actor, db));
    }
    if (collectionName === "field_worksheets") {
      return data.filter((worksheet) => {
        const dispatch = (db?.dispatch_cards || []).find((d) => d.id === worksheet.dispatch_card_id);
        return dispatch && isDispatchInSalesPortfolio(dispatch, actor, db);
      });
    }
    if (collectionName === "daily_timesheets") {
      return data.filter((sheet) => {
        // Daily Time Sheets carry no dispatch link, so Sales also sees the paper entries it keyed in itself.
        if (sheet.source === "paper_entry" && sheet.created_by === actor.id) return true;
        const dispatch = (db?.dispatch_cards || []).find((d) => d.id === sheet.dispatch_card_id);
        return dispatch && isDispatchInSalesPortfolio(dispatch, actor, db);
      });
    }
  }
  if (actor?.role === roles.TECHNICIAN) {
    if (collectionName === "dispatch_cards") {
      return data.filter((dispatch) => isTechnicianAssignedToDispatch(dispatch, actor, db));
    }
    if (collectionName === "field_worksheets") {
      return data.filter((worksheet) => worksheet.technician_id === actor.id);
    }
    if (collectionName === "daily_timesheets") {
      return data.filter((sheet) => sheet.technician_id === actor.id);
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

export function buildScopedSummary(db, actor) {
  let quotesData = db.quotes;
  let dispatchData = db.dispatch_cards;
  let invoicesData = db.invoices;
  let purchaseOrdersData = db.purchase_orders;
  let clientsCount = db.clients.length;
  let worksheetsData = db.field_worksheets;

  if (isClientViewer(actor)) {
    quotesData = scopeByClient(quotesData, actor, clientScopedResolvers.quotes)
      .filter((quote) => CLIENT_VISIBLE_QUOTE_STATUSES.includes(quote.status));
    dispatchData = scopeByClient(dispatchData, actor, (item) => clientScopedResolvers.dispatch_cards(item, db));
    invoicesData = scopeByClient(invoicesData, actor, (item) => clientScopedResolvers.invoices(item, db));
    purchaseOrdersData = [];
    worksheetsData = scopeByClient(worksheetsData, actor, (item) => clientScopedResolvers.field_worksheets(item, db));
    clientsCount = actor.client_id ? 1 : 0;
  }

  if (actor?.role === roles.TECHNICIAN || actor?.role === roles.SUPERVISOR) {
    dispatchData = scopeOperationalData(dispatchData, "dispatch_cards", actor, db);
    worksheetsData = scopeOperationalData(worksheetsData, "field_worksheets", actor, db);
    quotesData = [];
    invoicesData = [];
    purchaseOrdersData = [];
    clientsCount = 0;
  }

  // Sales may work with client and quote information, but must not receive
  // dashboard aggregates derived from dispatch, worksheet, invoice, or PO data.
  if (actor?.role === roles.SALES) {
    quotesData = quotesData.filter((quote) => isQuoteInSalesPortfolio(quote, actor, db));
    clientsCount = db.clients.filter((client) =>
      client.primary_sales_owner_id === actor.id ||
      (Array.isArray(client.account_team_user_ids) && client.account_team_user_ids.includes(actor.id))
    ).length;
    dispatchData = [];
    worksheetsData = [];
    invoicesData = invoicesData.filter((inv) => isInvoiceInSalesPortfolio(inv, actor, db));
    purchaseOrdersData = purchaseOrdersData.filter((po) => isPurchaseOrderInSalesPortfolio(po, actor, db));
  }

  // Finance works with commercial, PO, and invoice evidence. It must not
  // receive aggregates derived from operational dispatch or worksheet records.
  if (actor?.role === roles.FINANCE) {
    dispatchData = [];
    worksheetsData = [];
  }

  if (actor?.role === roles.OPERATIONS) {
    invoicesData = [];
  }

  const statusCounts = quotesData.reduce((acc, quote) => {
    acc[quote.status] = (acc[quote.status] || 0) + 1;
    return acc;
  }, {});

  return {
    clients: clientsCount,
    quotes: quotesData.length,
    dispatches: dispatchData.length,
    invoices: invoicesData.length,
    worksheets: worksheetsData.length,
    // Superset for backward compatibility (see computeWorksheetReport in
    // reports.js): Chat B split this single stage into client
    // acknowledgement then Supervisor review.
    pending_review: worksheetsData.filter((worksheet) => ["Submitted", "Client_Acknowledged"].includes(worksheet.status)).length,
    pending_client_acknowledgement: worksheetsData.filter((worksheet) => worksheet.status === "Submitted").length,
    pending_supervisor_review: worksheetsData.filter((worksheet) => awaitsSupervisorReview(db, worksheet)).length,
    returned_for_correction: worksheetsData.filter((worksheet) => worksheet.status === "Returned_For_Correction").length,
    pending_po: quotesData.filter((quote) => quote.status === "Approved_Pending_PO").length,
    blocked_amendments: purchaseOrdersData.filter((po) => po.requires_amendment).length,
    status_counts: statusCounts
  };
}

export const getSummary = (req, res) => {
  res.json({ success: true, data: buildScopedSummary(req.db, getActor(req)) });
};

export const exportPastel = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "exportPastel");
  const csv = exportInvoicesCsv(req.db);
  req.store.audit(req.db, actor, "pastel_export", "invoices", "PASTEL_EXPORT_GENERATED", null, {
    export_type: "invoices",
    accounting_posted: false,
    row_count: Math.max(0, csv.split("\n").length - 1)
  });
  res.header("Content-Type", "text/csv; charset=utf-8");
  res.header("Content-Disposition", "attachment; filename=orac-pastel-export.csv");
  res.send(csv);
};

export const createLead = (req, res) => {
  // GAP FIX (Chat E, audit trail): this route is public. Falling back to
  // users[0] attributed anonymous web-form leads to a real staff account in
  // the audit log. Unauthenticated submissions are now recorded as "system".
  const actor = req.user ? getActor(req) : null;

  const fields = canonicalLeadFields(req.body);
  const nowMs = requestNowMs(req);
  const idempotencyKey = req.idempotencyKey;
  let requestHash;

  if (idempotencyKey) {
    // Runs inside the store lock: the lookup, the creation and the key record
    // below are one atomic unit that persistenceMiddleware commits BEFORE the
    // response is sent. A replay performs no creation, audit or notification.
    requestHash = leadRequestHash(fields);
    pruneExpiredKeys(req.db, nowMs);
    const existing = findActiveKey(req.db, LEAD_CREATE_SCOPE, idempotencyKey, nowMs);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        return res.status(409).json({
          success: false,
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "This Idempotency-Key was already used for a different submission."
        });
      }
      res.setHeader(IDEMPOTENCY_REPLAY_HEADER, "true");
      return res.status(existing.status_code).json({ ...existing.response, idempotent_replay: true });
    }
  }

  const lead = {
    id: req.store.id("lead"),
    company_name: fields.company_name,
    contact_name: fields.contact_name,
    email: fields.email,
    phone: fields.phone,
    mine_site: fields.mine_site,
    service_need: fields.service_need,
    urgency: fields.urgency,
    status: "New",
    created_at: new Date(nowMs).toISOString()
  };

  req.db.leads.push(lead);
  req.store.audit(req.db, actor, "lead", lead.id, "LEAD_CREATED", null, lead);

  const response = { success: true, data: lead };
  if (idempotencyKey) {
    req.db.idempotency_keys.push(buildKeyRecord({
      scope: LEAD_CREATE_SCOPE, key: idempotencyKey, requestHash, leadId: lead.id,
      statusCode: 200, response, nowMs
    }));
  }
  res.json(response);
};

export const getCollection = (collectionName) => {
  return (req, res) => {
    if (!req.db[collectionName]) {
      return res.status(404).json({ success: false, message: "Collection not found" });
    }
    const actor = getActor(req);
    const allowedRoles = collectionGuards[collectionName];
    if (!allowedRoles || !actor?.is_active || !allowedRoles.includes(actor.role)) {
      return res.status(403).json({
        success: false,
        message: `Role ${actor?.role || "Unknown"} cannot view ${collectionName}.`
      });
    }
    let data = req.db[collectionName];
    const resolveClientId = clientScopedResolvers[collectionName];
    if (resolveClientId && isClientViewer(actor)) {
      data = scopeByClient(data, actor, (item) => resolveClientId(item, req.db));
      if (collectionName === "quotes") {
        data = data.filter((quote) => quote.status ? CLIENT_VISIBLE_QUOTE_STATUSES.includes(quote.status) : true);
      }
      if (collectionName === "quote_lines") {
        data = data.filter((line) => {
          const parent = req.db.quotes.find((q) => q.id === line.quotation_id);
          return parent && (!parent.status || CLIENT_VISIBLE_QUOTE_STATUSES.includes(parent.status));
        });
      }
    }
    data = scopeOperationalData(data, collectionName, actor, req.db);
    res.json({ success: true, data: collectionResponseData(collectionName, data, req.db) });
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

    const before = collectionName === "users" ? toPublicUser(item) : { ...item };
    item.is_active = false;
    item.deactivated_by = actor.id;
    item.deactivated_at = new Date().toISOString();
    if (collectionName === "users") {
      revokeSessions(item);
      if (item.totp?.challenge) item.totp.challenge = null;
    }

    const after = collectionName === "users" ? toPublicUser(item) : item;
    req.store.audit(req.db, actor, collectionName, item.id, `${collectionName.toUpperCase()}_DEACTIVATED`, before, after);
    res.json({ success: true, data: after });
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

    const before = collectionName === "users" ? toPublicUser(item) : { ...item };
    item.is_active = true;
    delete item.deactivated_by;
    delete item.deactivated_at;
    if (collectionName === "users") {
      revokeSessions(item);
      if (item.totp?.challenge) item.totp.challenge = null;
    }

    const after = collectionName === "users" ? toPublicUser(item) : item;
    req.store.audit(req.db, actor, collectionName, item.id, `${collectionName.toUpperCase()}_REACTIVATED`, before, after);
    res.json({ success: true, data: after });
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
