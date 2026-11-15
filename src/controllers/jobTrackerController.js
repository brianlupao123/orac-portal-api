import { roles } from "../permissions.js";
import { getActor, isQuoteInSalesPortfolio } from "./coreController.js";
import { jobActuals } from "../jobActuals.js";
import { invoiceReadinessBlock } from "../invoiceReadiness.js";

const ALLOWED_ROLES = new Set([
  roles.ADMIN,
  roles.MANAGEMENT,
  roles.SALES,
  roles.OPERATIONS,
  roles.FINANCE
]);

/**
 * GET /api/job-tracker
 * Read-only Job Tracker endpoint.
 *
 * Authorization:
 * - Admin, Management, Sales, Operations, Finance only.
 * - 403 for Supervisor, Technician, Client Viewer.
 * - Sales is strictly portfolio-scoped.
 *
 * Statuses:
 * - Excludes Draft and Cancelled quotes.
 * - Waiting for Client PO: Approved_Pending_PO with no PO or PO pending verification.
 * - WIP: verified-PO dispatch only.
 * - Ready to prepare invoice: existing invoice readiness logic.
 * - Invoiced: issued invoice.
 * - Completed: settled invoice.
 *
 * Payload:
 * - Canonical fields only (no money, no rates/prices/amounts/VAT, no unmigrated PR/Pastel fields).
 */
export function getJobTracker(req, res) {
  const actor = getActor(req);
  if (!actor || !actor.is_active || !ALLOWED_ROLES.has(actor.role)) {
    return res.status(403).json({
      success: false,
      message: `Role ${actor?.role || "Unknown"} cannot access Jobs Tracker.`
    });
  }

  const db = req.db || {};
  const quotes = db.quotes || [];
  const dispatches = db.dispatch_cards || [];
  const purchaseOrders = db.purchase_orders || [];
  const invoices = db.invoices || [];
  const clients = db.clients || [];
  const mineSites = db.mine_sites || [];
  const users = db.users || [];

  const clientMap = new Map(clients.map((c) => [c.id, c.name]));
  const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));
  const siteMap = new Map(mineSites.map((s) => [s.id, s.name]));

  // Quotes to process: exclude Draft and Cancelled
  const activeQuotes = quotes.filter((q) => {
    const s = String(q.status || "").toLowerCase();
    return s !== "draft" && s !== "cancelled";
  });

  // Sales portfolio filtering
  const accessibleQuotes = actor.role === roles.SALES
    ? activeQuotes.filter((q) => isQuoteInSalesPortfolio(q, actor, db))
    : activeQuotes;

  const jobs = [];

  for (const quote of accessibleQuotes) {
    const po = purchaseOrders.find((p) => p.quotation_id === quote.id || p.id === quote.purchase_order_id) || null;
    const isPoVerified = Boolean(
      po && (
        po.status === "Verified" ||
        po.status === "PO_Verified" ||
        po.verified_at ||
        quote.status === "PO_Verified" ||
        quote.status === "Field_Dispatch"
      )
    );

    const quoteDispatches = dispatches.filter((d) => d.quotation_id === quote.id);
    const quoteInvoices = invoices.filter((inv) =>
      inv.quotation_id === quote.id ||
      (quoteDispatches.length > 0 && quoteDispatches.some((d) => d.id === inv.dispatch_card_id))
    );

    const dispatchList = quoteDispatches.length > 0 ? quoteDispatches : [null];

    for (const dispatch of dispatchList) {
      let status = "Waiting_For_PO";
      let stage = "Waiting for Client PO";

      const dispatchInvoices = dispatch
        ? quoteInvoices.filter((inv) => inv.dispatch_card_id === dispatch.id || !inv.dispatch_card_id)
        : quoteInvoices;

      const nonVoidInvoices = dispatchInvoices.filter((inv) => String(inv.status || "").toLowerCase() !== "voided");

      if (nonVoidInvoices.length > 0) {
        const allSettled = nonVoidInvoices.every((inv) => {
          const s = String(inv.status || "").toLowerCase();
          return s === "settled" || s === "paid";
        });
        if (allSettled) {
          status = "Completed";
          stage = "Completed";
        } else {
          status = "Invoiced";
          stage = "Invoiced";
        }
      } else if (dispatch && isPoVerified) {
        const isReadyForInvoice = invoiceReadinessBlock(db, dispatch) === null;
        if (isReadyForInvoice) {
          status = "Ready_For_Invoice";
          stage = "Ready to prepare invoice";
        } else {
          status = "WIP";
          stage = "Work in Progress (WIP)";
        }
      } else if (quote.status === "Approved_Pending_PO") {
        status = "Approved_Pending_PO";
        stage = "Waiting for Client PO";
      } else if (quote.status === "Sent") {
        status = "Sent";
        stage = "Sent (Awaiting Client Approval)";
      } else {
        status = quote.status || "Pending";
        stage = quote.status || "Pending";
      }

      const actuals = dispatch ? jobActuals(db, dispatch.id) : { total: 0, normal: 0, ot_15: 0, ot_20: 0 };

      const commercialOwner = quote.sales_owner_id
        ? (userMap.get(quote.sales_owner_id) || quote.sales_owner_id)
        : "Unassigned";

      const siteName = quote.mine_site_id ? (siteMap.get(quote.mine_site_id) || "") : "";

      jobs.push({
        id: dispatch ? dispatch.id : `quote_${quote.id}`,
        quote_id: quote.id,
        quote_number: quote.quote_number,
        client_id: quote.client_id,
        client_name: clientMap.get(quote.client_id) || quote.client_id || "",
        site_id: quote.mine_site_id || null,
        site_name: siteName,
        status,
        stage,
        po_number: po?.po_number || null,
        po_status: po ? (isPoVerified ? "Verified" : "Pending_Verification") : "No_PO",
        dispatch_id: dispatch?.id || null,
        dispatch_number: dispatch?.dispatch_number || null,
        actual_hours: actuals.total,
        actual_hours_breakdown: {
          normal: actuals.normal,
          ot_15: actuals.ot_15,
          ot_20: actuals.ot_20
        },
        commercial_owner: commercialOwner,
        sales_owner_id: quote.sales_owner_id || null,
        created_at: dispatch?.created_at || quote.created_at,
        updated_at: quote.updated_at || quote.created_at
      });
    }
  }

  // Stable order: descending by created_at
  jobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json({
    success: true,
    data: jobs
  });
}
