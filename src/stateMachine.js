import { requirePermission } from "./permissions.js";
import { countedTimesheets, pendingKioskTimesheets, reviewBlockedReason } from "./timesheetReview.js";

const allowedTransitions = {
  Draft: ["Sent"],
  Sent: ["Approved_Pending_PO"],
  Approved_Pending_PO: ["PO_Verified", "Field_Dispatch"],
  PO_Verified: ["Field_Dispatch"],
  Field_Dispatch: ["Invoiced"],
  Invoiced: []
};

function quoteLines(db, quoteId) {
  return db.quote_lines.filter((line) => line.quotation_id === quoteId);
}

function getPo(db, quoteId) {
  return db.purchase_orders.find((po) => po.quotation_id === quoteId);
}

function getDispatch(db, quoteId) {
  return db.dispatch_cards.find((job) => job.quotation_id === quoteId);
}

function approvedWorksheets(db, dispatchId) {
  return db.field_worksheets.filter((item) => item.dispatch_card_id === dispatchId && item.status === "Supervisor_Approved");
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
  }

  if (targetState === "Approved_Pending_PO") {
    requirePermission(actor, "approveQuote");
    if (actor.role === "Sales" && quote.sent_by && quote.sent_by === actor.id) {
      throw Object.assign(new Error("Sales cannot approve a quote they personally sent. A different Sales colleague, Operations, or Admin must approve it."), { status: 403 });
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
    const urgent = Boolean(payload.started_before_po);
    if (!po && !urgent) {
      throw Object.assign(new Error("Dispatch requires a verified PO, unless urgent pre-PO dispatch is explicitly authorized."), { status: 400 });
    }
    if (urgent && !String(payload.urgent_reason || "").trim()) {
      throw Object.assign(new Error("Urgent pre-PO dispatch requires a reason."), { status: 400 });
    }
  }

  if (targetState === "Invoiced") {
    requirePermission(actor, "invoice");
    const po = getPo(db, quote.id);
    const job = getDispatch(db, quote.id);
    if (!job) throw Object.assign(new Error("A dispatch card must exist before invoicing."), { status: 400 });
    if (!po || po.status !== "verified" || !String(po.po_reference || "").trim()) {
      throw Object.assign(new Error("Invoice blocked: verified PO reference is required."), { status: 400 });
    }
    if (approvedWorksheets(db, job.id).length === 0) {
      throw Object.assign(new Error("Invoice blocked: at least one supervisor-approved worksheet is required."), { status: 400 });
    }
    const pendingKiosk = pendingKioskTimesheets(db, job.id);
    if (pendingKiosk.length > 0) {
      throw Object.assign(new Error(`Invoice blocked: ${pendingKiosk.length} kiosk timesheet ${pendingKiosk.length === 1 ? "entry is" : "entries are"} awaiting Supervisor review.${reviewBlockedReason(db, job) ? " " + reviewBlockedReason(db, job) : ""}`), { status: 400 });
    }
    if (po.requires_amendment) {
      throw Object.assign(new Error("Invoice blocked: logged work exceeds PO amount and requires an approved PO amendment."), { status: 400 });
    }
  }
}

function createDispatch(db, store, quote, payload, actor) {
  let po = getPo(db, quote.id);
  if (!po && payload.started_before_po) {
    po = {
      id: store.id("po"),
      quotation_id: quote.id,
      po_reference: "",
      po_amount: 0,
      status: "pending",
      started_before_po: true,
      date_received: null,
      verified_by: null,
      verified_at: null,
      requires_amendment: false
    };
    db.purchase_orders.push(po);
  }

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

function createInvoice(db, store, quote, actor) {
  const po = getPo(db, quote.id);
  const job = getDispatch(db, quote.id);
  // Only approved hours are billed: pending or rejected kiosk entries are excluded.
  const timesheets = countedTimesheets(db, job.id);
  const materials = db.material_usage.filter((item) => item.dispatch_card_id === job.id);
  const laborTotal = timesheets.reduce((sum, item) => sum + item.hours_logged * item.hourly_rate, 0);
  const laborHours = timesheets.reduce((sum, item) => sum + item.hours_logged, 0);
  const materialTotal = materials.reduce((sum, item) => sum + item.total_cost, 0);
  const total = laborTotal + materialTotal || quote.total_amount;

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

export function transitionQuote(db, store, quoteId, targetState, payload, actor) {
  const quote = db.quotes.find((item) => item.id === quoteId);
  if (!quote) throw Object.assign(new Error("Quote not found."), { status: 404 });

  validateTransition(db, quote, targetState, payload, actor);
  const before = { ...quote };
  quote.status = targetState;
  quote.updated_at = new Date().toISOString();
  if (targetState === "Sent") quote.sent_by = actor.id;

  let created = null;
  if (targetState === "Field_Dispatch") created = createDispatch(db, store, quote, payload, actor);
  if (targetState === "Invoiced") created = createInvoice(db, store, quote, actor);

  store.audit(db, actor, "quotation", quote.id, `QUOTE_TRANSITION_${before.status}_TO_${targetState}`, before, quote);
  return { quote, created };
}

export { allowedTransitions };
