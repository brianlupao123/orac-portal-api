import { requirePermission } from "../permissions.js";
import { readIdempotencyKey, requestFingerprint, findIdempotentRecord } from "../inventoryLedger.js";
import { v5Enabled } from "../v5CommercialWorkflow.js";

const disabled = (res) => res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: "V5 material allocation is not enabled yet." });

function actorFor(req) {
  return (req.db.users || []).find((user) => user.id === req.user?.id) || null;
}

function publicAllocation(allocation) {
  const { idempotency_fingerprint: _fingerprint, idempotency_key: _key, ...safe } = allocation;
  return safe;
}

// Sales/Admin performs a deliberate, auditable allocation after the operational
// material entry exists. The endpoint never writes stock, usage, catalog cost,
// a quote price, or an invoice.
export function allocateV5MaterialUsage(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5MaterialAllocation");
  if (!v5Enabled()) return disabled(res);

  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  const quote = (req.db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  if (!quote?.v5_commercial_workflow) return res.status(409).json({ success: false, message: "This dispatch is not linked to a V5 quotation revision." });
  if (quote.commercial_acceptance_status !== "po_verified") {
    return res.status(409).json({ success: false, code: "V5_QUOTE_NOT_ACCEPTED", message: "Material evidence can be allocated only after the V5 quotation is accepted by a verified PO." });
  }

  const keyResult = readIdempotencyKey(req);
  if (keyResult.error) return res.status(400).json({ success: false, message: keyResult.error });
  if (!keyResult.key) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "An Idempotency-Key is required to allocate V5 material evidence." });

  const usage = (req.db.material_usage || []).find((item) => item.id === req.body.material_usage_id && item.dispatch_card_id === dispatch.id);
  if (!usage) return res.status(404).json({ success: false, message: "Material usage was not found on this dispatch." });
  const quoteLine = (req.db.quote_lines || []).find((item) => item.id === req.body.quote_line_id && item.quotation_id === quote.id);
  if (!quoteLine || quoteLine.pricing_basis !== "material") {
    return res.status(409).json({ success: false, message: "Material evidence must be allocated to a material line on this accepted quotation." });
  }
  // A client-price line may only claim stock-backed evidence for the same
  // catalog item. Ad-hoc or uncatalogued usage stays unallocated for an
  // amendment/review; matching by description would be guesswork.
  if (!usage.catalog_item_id || !quoteLine.catalog_item_id || usage.catalog_item_id !== quoteLine.catalog_item_id) {
    return res.status(409).json({ success: false, message: "Material allocation requires the same catalog item on the usage record and accepted material quote line." });
  }

  if (!Array.isArray(req.db.v5_material_allocations)) req.db.v5_material_allocations = [];
  const fingerprint = requestFingerprint({
    dispatch_card_id: dispatch.id,
    material_usage_id: usage.id,
    quote_line_id: quoteLine.id
  });
  const prior = findIdempotentRecord(req.db.v5_material_allocations, actor.id, keyResult.key, fingerprint, "allocated_by");
  if (prior.kind === "conflict") return res.status(409).json({ success: false, message: "This idempotency key was already used for a different material allocation." });
  if (prior.kind === "replay") return res.json({ success: true, idempotent_replay: true, data: publicAllocation(prior.record) });

  // Amendment allocation is another commercial claim over the same operational
  // material evidence. Whichever allocation is recorded first owns the usage.
  if ((req.db.v5_amendment_evidence_allocations || []).some((item) => item.source_type === "material_usage" && item.source_id === usage.id)) {
    return res.status(409).json({ success: false, code: "MATERIAL_USAGE_ALREADY_ALLOCATED", message: "This material usage is already allocated to an amendment and cannot be billed twice." });
  }
  const existing = req.db.v5_material_allocations.find((item) => item.material_usage_id === usage.id);
  if (existing) return res.status(409).json({ success: false, code: "MATERIAL_USAGE_ALREADY_ALLOCATED", message: "This material usage is already allocated and cannot be billed twice." });

  const stockItem = (req.db.stock_items || []).find((item) => item.catalog_item_id === usage.catalog_item_id);
  const allocation = {
    id: req.store.id("v5ma"),
    dispatch_card_id: dispatch.id,
    quotation_id: quote.id,
    quote_line_id: quoteLine.id,
    material_usage_id: usage.id,
    catalog_item_id: usage.catalog_item_id,
    quantity_used: usage.quantity_used,
    unit_of_measure: usage.unit_of_measure || stockItem?.unit_of_measure || null,
    allocated_by: actor.id,
    allocated_at: new Date().toISOString(),
    idempotency_key: keyResult.key,
    idempotency_fingerprint: fingerprint
  };
  req.db.v5_material_allocations.push(allocation);
  req.store.audit(req.db, actor, "v5_material_allocation", allocation.id, "V5_MATERIAL_EVIDENCE_ALLOCATED", null, publicAllocation(allocation));
  return res.status(201).json({ success: true, data: publicAllocation(allocation) });
}
