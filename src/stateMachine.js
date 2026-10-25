import { requirePermission } from "./permissions.js";
import { invoiceVarianceGate, lockTimesheetsForInvoice } from "./timesheetWorkflow.js";
import { countedTimesheets } from "./timesheetReview.js";
import { calculateLegacyInvoiceAmounts, invoiceReadinessBlock } from "./invoiceReadiness.js";

const allowedTransitions = {
  Draft: ["Sent"],
  Sent: ["Approved_Pending_PO"],
  Approved_Pending_PO: ["PO_Verified"],
  PO_Verified: ["Field_Dispatch"],
  Field_Dispatch: ["Invoiced"],
  Invoiced: []
};

function quoteLines(db, quoteId) {
  return db.quote_lines.filter((line) => line.quotation_id === quoteId);
}

function getPo(db, quoteId) {
  return (db.purchase_orders || []).find((po) => po.quotation_id === quoteId && po.status !== "rejected" && po.status !== "cancelled") ||
    (db.purchase_orders || []).find((po) => po.quotation_id === quoteId);
}

function getDispatch(db, quoteId) {
  return db.dispatch_cards.find((job) => job.quotation_id === quoteId);
}

function validateTransition(db, quote, targetState, payload, actor) {
  if (!allowedTransitions[quote.status]?.includes(targetState)) {
    throw Object.assign(new Error(`Illegal transition: ${quote.status} -> ${targetState}.`), { status: 400 });
  }

  if (targetState === "Sent") {
    requirePermission(actor, "sendQuote");
    if (!quote.client_id || quoteLines(db, quote.id).length === 0) {
      throw Object.assign(new Error("Quote needs a client and at least one line before it can be sent."), { status: 400 });
    }
    if (quote.tax_status === "unconfigured") {
      throw Object.assign(new Error("Cannot issue quotation with unconfigured tax status. A configured tax treatment is required."), { status: 400 });
    }
    // Production environments reject provisional tax treatment — only approved
    // taxable, zero-rated, or exempt configurations may be sent to clients.
    const requireApprovedTax = (process.env.NODE_ENV || "development") === "production" || process.env.ORAC_REQUIRE_APPROVED_TAX === "true";
    if (requireApprovedTax && (quote.tax_status === "provisional" || !quote.tax_approved)) {
      throw Object.assign(new Error("Production quotation issuance requires approved tax configuration. Provisional tax treatment is restricted to development/test fixtures."), { status: 400 });
    }
  }

  if (targetState === "Approved_Pending_PO") {
    requirePermission(actor, "approveQuote");
    if (actor.role === "Sales" && quote.sent_by && quote.sent_by === actor.id) {
      throw Object.assign(new Error("Sales cannot approve a quote they personally sent. A different Sales colleague, Operations, or Admin must approve it."), { status: 403 });
    }
    const totalCents = Number.isInteger(quote.grand_total_cents)
      ? quote.grand_total_cents
      : Math.round(Number(quote.total_amount || 0) * 100);
    const isAboveThreshold = totalCents > 500000;
    const hasDiscount = Number(quote.discount_percent || 0) > 0;

    if ((isAboveThreshold || hasDiscount) && !["Management", "Admin"].includes(actor.role)) {
      const reason = isAboveThreshold && hasDiscount
        ? "Quotations exceeding USD 5,000 and quotations with commercial discounts require Management approval."
        : isAboveThreshold
          ? "Quotations exceeding USD 5,000 require Management approval."
          : "Quotations with commercial discounts require Management approval.";
      throw Object.assign(new Error(reason), { status: 403 });
    }
  }

  if (targetState === "PO_Verified") {
    requirePermission(actor, "verifyPo");
    const po = getPo(db, quote.id);
    if (!po || po.status !== "verified" || !String(po.po_reference || "").trim() || Number(po.po_amount || 0) <= 0) {
      throw Object.assign(new Error("A verified PO with reference and amount is required."), { status: 400 });
    }
  }

  if (targetState === "Field_Dispatch") {
    requirePermission(actor, "dispatch");
    const po = getPo(db, quote.id);
    if (payload.started_before_po) {
      throw Object.assign(new Error("Urgent pre-PO dispatch is not permitted; a verified PO is required before dispatch."), { status: 400 });
    }
    if (!po || po.status !== "verified" || !String(po.po_reference || "").trim() || Number(po.po_amount || 0) <= 0) {
      throw Object.assign(new Error("Dispatch requires a verified PO with reference and positive amount."), { status: 400 });
    }
    if (quote.status !== "PO_Verified") {
      throw Object.assign(new Error("Dispatch is permitted only from PO_Verified status."), { status: 400 });
    }
  }

  if (targetState === "Invoiced") {
    requirePermission(actor, "invoice");
    const po = getPo(db, quote.id);
    const job = getDispatch(db, quote.id);
    if (!job) throw Object.assign(new Error("A dispatch card must exist before invoicing."), { status: 400 });
    const blocked = invoiceReadinessBlock(db, job);
    if (blocked) throw Object.assign(new Error(blocked.message), { status: blocked.status, code: blocked.code });
  }
}

function createDispatch(db, store, quote, payload, actor) {
  let po = getPo(db, quote.id);

  let job = getDispatch(db, quote.id);
  if (!job) {
    job = {
      id: store.id("job"),
      quotation_id: quote.id,
      purchase_order_id: po?.id || null,
      equipment_tag_id: quote.equipment_tag_id || null,
      dispatch_number: `JOB-${String(db.dispatch_cards.length + 1).padStart(4, "0")}`,
      status: "active",
      site_contact: payload.site_contact || "",
      scheduled_start: payload.scheduled_start || new Date().toISOString().slice(0, 10),
      scheduled_end: payload.scheduled_end || null,
      started_before_po: Boolean(payload.started_before_po),
      urgent_reason: payload.urgent_reason || "",
      assigned_supervisor_id: payload.assigned_supervisor_id || actor.id,
      assigned_technician_ids: [],
      created_at: new Date().toISOString()
    };
    db.dispatch_cards.push(job);
    store.audit(db, actor, "dispatch_card", job.id, job.started_before_po ? "URGENT_DISPATCH_CREATED" : "DISPATCH_CREATED", null, job);
  }
  return job;
}

export function createLegacyInvoice(db, store, quote, actor) {
  const po = getPo(db, quote.id);
  const job = getDispatch(db, quote.id);
  const { timesheets, materials, laborTotal, laborHours, materialTotal, total } = calculateLegacyInvoiceAmounts(db, job, quote);
  // Dark by default (TIMESHEET_INVOICE_VARIANCE): billed hours may never exceed eligible hours without a second-approved override.
  const gate = invoiceVarianceGate(db, job.id);
  if (!gate.allow) throw Object.assign(new Error(gate.reason), { status: 409, code: "INVOICE_VARIANCE_BLOCK" });

  const invoice = {
    id: store.id("inv"),
    invoice_number: `INV-${String(db.invoices.length + 1).padStart(4, "0")}`,
    purchase_order_id: po.id,
    dispatch_card_id: job.id,
    total_amount: total,
    status: "sent",
    generated_by: actor.id,
    generated_at: new Date().toISOString()
  };

  db.invoices.push(invoice);
  if (gate.overridden) { const o = (db.timesheet_variance_overrides || []).find((x) => x.dispatch_card_id === job.id && !x.voided_at && !x.consumed_invoice_id); if (o) o.consumed_invoice_id = invoice.id; }
  if (!gate.skipped) lockTimesheetsForInvoice(db, job.id, invoice.id, invoice.generated_at);
  // A labour line is written unless the invoice is materials-only. Without this
  // guard a materials-only invoice put the whole total on the labour line and
  // then added the materials line again, so the lines summed to twice the total.
  if (laborTotal > 0 || materialTotal <= 0) {
    db.invoice_lines.push({
      id: store.id("il"),
      invoice_id: invoice.id,
      description: "Field service labour",
      quantity: laborHours || 1,
      unit_price: laborTotal > 0 && laborHours > 0 ? laborTotal / laborHours : total,
      line_total: laborTotal || total,
      gl_account_code: "SALES-SERVICE",
      cost_center: "FIELD"
    });
  }

  if (materialTotal > 0) {
    db.invoice_lines.push({
      id: store.id("il"),
      invoice_id: invoice.id,
      description: "Materials used",
      quantity: 1,
      unit_price: materialTotal,
      line_total: materialTotal,
      gl_account_code: "SALES-MATERIALS",
      cost_center: "FIELD"
    });
  }

  store.audit(db, actor, "invoice", invoice.id, "INVOICE_GENERATED", null, invoice);
  return invoice;
}

// Direct Field_Dispatch -> Invoiced transitions are intentionally refused by
// the HTTP path. The controlled draft issuer calls this helper only after the
// independent-review and stale-evidence checks have completed.
export function issueLegacyInvoice(db, store, quoteId, actor) {
  const quote = db.quotes.find((item) => item.id === quoteId);
  if (!quote) throw Object.assign(new Error("Quote not found."), { status: 404 });
  validateTransition(db, quote, "Invoiced", {}, actor);
  const before = { ...quote };
  const invoice = createLegacyInvoice(db, store, quote, actor);
  quote.status = "Invoiced";
  quote.updated_at = new Date().toISOString();
  store.audit(db, actor, "quotation", quote.id, `QUOTE_TRANSITION_${before.status}_TO_Invoiced`, before, quote);
  return invoice;
}

export function transitionQuote(db, store, quoteId, targetState, payload, actor) {
  const quote = db.quotes.find((item) => item.id === quoteId);
  if (!quote) throw Object.assign(new Error("Quote not found."), { status: 404 });

  if (quote.status === targetState) return { quote, created: null };
  if (targetState === "Invoiced") {
    throw Object.assign(new Error("A controlled invoice draft must be independently issued before a quotation can be invoiced."), { status: 409, code: "LEGACY_INVOICE_DRAFT_REQUIRED" });
  }
  validateTransition(db, quote, targetState, payload, actor);
  const before = { ...quote };
  quote.status = targetState;
  quote.updated_at = new Date().toISOString();
  if (targetState === "Sent") {
    quote.sent_by = actor.id;
    quote.sent_at = new Date().toISOString();
    quote.tax_rate_locked = true;
  }

  let created = null;
  if (targetState === "Field_Dispatch") created = createDispatch(db, store, quote, payload, actor);

  store.audit(db, actor, "quotation", quote.id, `QUOTE_TRANSITION_${before.status}_TO_${targetState}`, before, quote);
  return { quote, created };
}

export { allowedTransitions };
