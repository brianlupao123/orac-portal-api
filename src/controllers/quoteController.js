import { requirePermission } from "../permissions.js";
import { transitionQuote } from "../stateMachine.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

export const createQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");
  
  const body = req.body;
  const client = req.db.clients.find((item) => item.id === body.client_id);
  if (!client) return res.status(400).json({ success: false, message: "Client is required." });

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
      verified_at: new Date().toISOString(),
      requires_amendment: false
    });
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
