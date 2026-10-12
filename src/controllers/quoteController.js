import { requirePermission } from "../permissions.js";
import { transitionQuote } from "../stateMachine.js";
import { validateEquipmentTagForClient } from "../services/entityHierarchy.js";
import { v5Enabled, getV5Policy } from "../v5CommercialWorkflow.js";
import { calculateV5QuoteLines, quoteTotal } from "../v5QuoteRules.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

export const createQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");
  
  const body = req.body;
  const client = req.db.clients.find((item) => item.id === body.client_id);
  if (!client) return res.status(400).json({ success: false, message: "Client is required." });

  // A new quote may only link an active equipment tag that belongs to this
  // client (same rule client service requests and maintenance schedules use).
  const tagCheck = validateEquipmentTagForClient(req.db, { tagId: body.equipment_tag_id, clientId: client.id });
  if (!tagCheck.ok) return res.status(tagCheck.status).json({ success: false, message: tagCheck.message });

  const lines = body.lines.map((line, index) => {
    return {
      id: req.store.id("ql"),
      catalog_item_id: line.catalog_item_id || null,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_total: line.quantity * line.unit_price
    };
  });

  const quote = {
    id: req.store.id("quote"),
    quote_number: `Q-${String(req.db.quotes.length + 1).padStart(4, "0")}`,
    client_id: client.id,
    equipment_tag_id: body.equipment_tag_id || null,
    status: "Draft",
    total_amount: lines.reduce((sum, line) => sum + line.line_total, 0),
    created_by: actor.id,
    created_at: new Date().toISOString()
  };

  req.db.quotes.push(quote);
  req.db.quote_lines.push(...lines.map((line) => ({ ...line, quotation_id: quote.id })));
  req.store.audit(req.db, actor, "quotation", quote.id, "QUOTE_CREATED", null, quote);
  
  res.json({ success: true, data: quote });
};

function requireV5CommercialWorkflow(res) {
  if (v5Enabled()) return true;
  res.status(409).json({ success: false, code: "V5_WORKFLOW_DISABLED", message: "The V5 commercial workflow is not enabled." });
  return false;
}

// A revision is a new immutable quotation. The original quote and its lines are
// deliberately not changed; this protects the accepted commercial record.
export const createQuoteRevision = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");
  if (!requireV5CommercialWorkflow(res)) return;

  const original = req.db.quotes.find((item) => item.id === req.params.id);
  if (!original) return res.status(404).json({ success: false, message: "Quote not found." });
  if (original.status === "Cancelled") return res.status(409).json({ success: false, message: "A cancelled quote cannot be revised." });
  const policy = getV5Policy(req.db);
  const lines = calculateV5QuoteLines(req.body.lines);
  const rootId = original.root_quote_id || original.id;
  const rootQuote = req.db.quotes.find((quote) => quote.id === rootId) || original;
  const revisionNumber = req.db.quotes.filter((quote) => (quote.root_quote_id || quote.id) === rootId).length;
  const quote = {
    id: req.store.id("quote"),
    quote_number: `${rootQuote.quote_number}-R${revisionNumber}`,
    client_id: original.client_id,
    equipment_tag_id: original.equipment_tag_id || null,
    status: "Draft",
    total_amount: quoteTotal(lines),
    currency: policy.currency,
    tax_rate: req.body.tax_rate ?? policy.tax_rate,
    root_quote_id: rootId,
    revision_of_quote_id: original.id,
    revision_number: revisionNumber,
    revision_reason: req.body.reason,
    client_po_reference: req.body.client_po_reference || null,
    client_po_date: req.body.client_po_date || null,
    created_by: actor.id,
    created_at: new Date().toISOString(),
    v5_commercial_workflow: true
  };
  req.db.quotes.push(quote);
  req.db.quote_lines.push(...lines.map((line) => ({ ...line, id: req.store.id("ql"), quotation_id: quote.id })));
  req.store.audit(req.db, actor, "quotation", quote.id, "V5_QUOTE_REVISION_CREATED", null, quote);
  res.status(201).json({ success: true, data: quote });
};

// Sales records the client's amended PO or written acceptance. Finance remains
// payments-only in the V5 path; later invoice preparation checks this evidence.
export const recordAmendedPoEvidence = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");
  if (!requireV5CommercialWorkflow(res)) return;
  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!quote.revision_of_quote_id) return res.status(409).json({ success: false, message: "Client amendment evidence applies to a quotation revision only." });
  const before = { ...quote };
  quote.amended_po_evidence = {
    ...req.body,
    recorded_by: actor.id,
    recorded_at: new Date().toISOString()
  };
  req.store.audit(req.db, actor, "quotation", quote.id, "V5_AMENDED_PO_EVIDENCE_RECORDED", before, quote);
  res.json({ success: true, data: quote });
};

export const updateQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote"); // Sales or Admin

  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (quote.status !== "Draft") {
    return res.status(400).json({ success: false, message: "Only Draft quotes can be edited." });
  }

  const before = { ...quote };
  const body = req.body;

  // Validate BEFORE mutating anything, so a rejected update leaves the quote
  // exactly as it was. Only validate when the link actually changes: re-saving
  // a Draft that already carries a tag must not fail just because that tag (or
  // a parent) was disabled since; clearing the link is always allowed.
  if (body.equipment_tag_id !== undefined) {
    const nextTagId = body.equipment_tag_id || null;
    if (nextTagId && nextTagId !== quote.equipment_tag_id) {
      const tagCheck = validateEquipmentTagForClient(req.db, { tagId: nextTagId, clientId: quote.client_id });
      if (!tagCheck.ok) return res.status(tagCheck.status).json({ success: false, message: tagCheck.message });
    }
  }

  if (body.description) quote.description = body.description;
  if (body.equipment_tag_id !== undefined) quote.equipment_tag_id = body.equipment_tag_id || null;

  // Handle line item updates
  if (body.lines && Array.isArray(body.lines)) {
    // Remove existing lines
    req.db.quote_lines = req.db.quote_lines.filter(l => l.quotation_id !== quote.id);
    
    // Add new lines
    const newLines = body.lines.map((line) => ({
      id: req.store.id("ql"),
      quotation_id: quote.id,
      catalog_item_id: line.catalog_item_id || null,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_total: line.quantity * line.unit_price
    }));
    req.db.quote_lines.push(...newLines);
    quote.total_amount = newLines.reduce((sum, line) => sum + line.line_total, 0);
  }

  req.store.audit(req.db, actor, "quotation", quote.id, "QUOTE_UPDATED", before, quote);
  res.json({ success: true, data: quote });
};

export const cancelQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");

  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (quote.status !== "Draft") {
    return res.status(400).json({ success: false, message: "Only Draft quotes can be cancelled." });
  }

  const before = { ...quote };
  quote.status = "Cancelled";
  
  req.store.audit(req.db, actor, "quotation", quote.id, "QUOTE_CANCELLED", before, quote);
  res.json({ success: true, data: quote });
};

export const transition = (req, res) => {
  const actor = getActor(req);
  const result = transitionQuote(req.db, req.store, req.params.id, req.body.target_state, req.body, actor);
  res.json({ success: true, data: result });
};

export const capturePo = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "verifyPo");
  
  const quoteId = req.params.id;
  const quote = req.db.quotes.find((item) => item.id === quoteId);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });

  const body = req.body;
  
  let po = req.db.purchase_orders.find((item) => item.quotation_id === quoteId);
  const before = po ? { ...po } : null;

  // GAP FIX (Chat E, PO controls): PO evidence is frozen once an invoice has
  // been generated from it, and a cancelled quote takes no PO.
  if (["Invoiced", "Cancelled"].includes(quote.status)) {
    return res.status(409).json({ success: false, message: `PO details cannot be captured for a ${quote.status} quote.` });
  }
  // GAP FIX (Chat E, PO controls): verifyPo includes Operations, but
  // approveAmendment is Admin/Finance with a maker-checker rule. Changing the
  // amount of an already-verified PO here would raise it (and clear the
  // amendment block) without that approval, so the amount is only changeable
  // through POST /purchase_orders/:id/amendments once verified. Pending
  // urgent-dispatch stubs are unaffected (their first verification sets the
  // real amount, as before).
  if (po && po.status === "verified" && Number(body.po_amount) !== Number(po.po_amount)) {
    return res.status(409).json({
      success: false,
      message: "A verified PO amount can only be changed through an approved PO amendment."
    });
  }
  
  if (!po) {
    po = {
      id: req.store.id("po"),
      quotation_id: quoteId,
      po_reference: body.po_reference,
      po_amount: body.po_amount,
      status: "verified",
      started_before_po: Boolean(body.started_before_po),
      date_received: body.date_received || new Date().toISOString().slice(0, 10),
      verified_by: actor.id,
      verified_at: new Date().toISOString(),
      requires_amendment: false
    };
    req.db.purchase_orders.push(po);
  } else {
    Object.assign(po, {
      po_reference: body.po_reference,
      po_amount: body.po_amount,
      status: "verified",
      verified_by: actor.id,
      verified_at: new Date().toISOString()
    });
    // Re-verifying an existing PO must not clear the amendment flag by fiat:
    // re-derive it from logged work against the (possibly changed) PO amount.
    req.store.recalculateVariance(req.db, po.id);
  }
  req.store.audit(req.db, actor, "purchase_order", po.id, "PO_VERIFIED", before, po);
  
  res.json({ success: true, data: po });
};

export const submitClientPo = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitClientPo");

  const quoteId = req.params.id;
  const quote = req.db.quotes.find((item) => item.id === quoteId);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!actor.client_id || quote.client_id !== actor.client_id) {
    return res.status(403).json({ success: false, message: "Client Viewer cannot submit a PO for another client's quote." });
  }

  // GAP FIX (Chat E): same rule serviceRequestsController already applies -
  // a deactivated client account cannot take commercial actions.
  const owningClient = (req.db.clients || []).find((item) => item.id === quote.client_id);
  if (owningClient && owningClient.is_active === false) {
    return res.status(403).json({ success: false, message: "Your client account is not active." });
  }

  // GAP FIX (Chat E): a client cannot attach a PO to a quote that is still an
  // unissued Draft, or to one that is cancelled or already invoiced.
  if (["Draft", "Cancelled", "Invoiced"].includes(quote.status)) {
    return res.status(409).json({ success: false, message: `A PO cannot be submitted for a ${quote.status} quote.` });
  }

  const body = req.body;
  let po = req.db.purchase_orders.find((item) => item.quotation_id === quoteId);
  const before = po ? { ...po } : null;

  if (po && po.status === "verified") {
    return res.status(409).json({ success: false, message: "This PO has already been verified internally and cannot be resubmitted by the client." });
  }

  if (!po) {
    po = {
      id: req.store.id("po"),
      quotation_id: quoteId,
      po_reference: body.po_reference,
      po_amount: body.po_amount,
      status: "pending",
      started_before_po: false,
      date_received: body.date_received || new Date().toISOString().slice(0, 10),
      verified_by: null,
      verified_at: null,
      requires_amendment: false
    };
    req.db.purchase_orders.push(po);
  } else {
    Object.assign(po, {
      po_reference: body.po_reference,
      po_amount: body.po_amount,
      status: "pending",
      date_received: body.date_received || po.date_received
    });
  }

  req.store.audit(req.db, actor, "purchase_order", po.id, "PO_SUBMITTED_BY_CLIENT", before, po);
  res.json({ success: true, data: po });
};
