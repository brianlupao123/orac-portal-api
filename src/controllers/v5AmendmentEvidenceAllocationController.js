import { requirePermission } from "../permissions.js";
import { readIdempotencyKey, requestFingerprint, findIdempotentRecord } from "../inventoryLedger.js";
import { isV5Verified } from "../v5SignatureEvidence.js";
import { v5Enabled } from "../v5CommercialWorkflow.js";

const off = (res) => res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: "V5 amendment coverage is not enabled yet." });
const EPSILON = 1e-9;
const positiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const publicRecord = ({ idempotency_key: _key, idempotency_fingerprint: _fingerprint, ...record }) => record;

function allocationTotal(records, predicate) {
  const quantities = records.filter(predicate).map((item) => item.quantity);
  if (!quantities.every(positiveNumber)) return null;
  return quantities.reduce((sum, quantity) => sum + quantity, 0);
}

export function allocateV5AmendmentEvidence(req, res) {
  const actor = (req.db.users || []).find((user) => user.id === req.user?.id) || null;
  requirePermission(actor, "manageV5AmendmentCoverage");
  if (!v5Enabled()) return off(res);
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  const link = (req.db.v5_amendment_dispatch_links || []).find((item) => item.dispatch_card_id === dispatch.id && item.amendment_quote_id === req.body.amendment_quote_id);
  const line = (req.db.quote_lines || []).find((item) => item.id === req.body.amendment_quote_line_id && item.quotation_id === req.body.amendment_quote_id);
  if (!link || !line) return res.status(409).json({ success: false, code: "V5_AMENDMENT_LINK_REQUIRED", message: "Use an approved amendment linked to this dispatch and one of its lines." });
  const amendment = (req.db.quotes || []).find((item) => item.id === link.amendment_quote_id);
  const po = (req.db.purchase_orders || []).find((item) => item.id === amendment?.commercial_acceptance_po_id);
  if (
    !amendment?.v5_amendment_approval
    || amendment.commercial_acceptance_status !== "po_verified"
    || !po
    || po.status !== "verified"
    || link.amendment_purchase_order_id !== po.id
    || amendment.v5_amendment_approval.approved_po_id !== po.id
  ) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_NOT_APPROVED", message: "The linked amendment must still be independently approved with its verified purchase order." });
  }
  const key = readIdempotencyKey(req);
  if (key.error) return res.status(400).json({ success: false, message: key.error });
  if (!key.key) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "An Idempotency-Key is required." });
  if (![
    "field_worksheet",
    "material_usage"
  ].includes(req.body.source_type) || !positiveNumber(req.body.quantity) || typeof req.body.reason !== "string" || req.body.reason.trim().length < 3) {
    return res.status(400).json({ success: false, code: "V5_AMENDMENT_ALLOCATION_INVALID", message: "A valid source type, positive numeric quantity and reason are required." });
  }
  const source = req.body.source_type === "field_worksheet"
    ? (req.db.field_worksheets || []).find((item) => item.id === req.body.source_id && item.dispatch_card_id === dispatch.id)
    : (req.db.material_usage || []).find((item) => item.id === req.body.source_id && item.dispatch_card_id === dispatch.id);
  if (!source) return res.status(404).json({ success: false, message: "Evidence source was not found on this dispatch." });
  if (req.body.source_type === "field_worksheet" && (!isV5Verified(req.db, source) || !["hourly", "minimum_hours"].includes(line.pricing_basis))) return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_INELIGIBLE", message: "Verified labour evidence may only cover an hourly or minimum-hours amendment line." });
  if (req.body.source_type === "material_usage" && (line.pricing_basis !== "material" || !source.catalog_item_id || source.catalog_item_id !== line.catalog_item_id)) return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_INELIGIBLE", message: "Material evidence requires a matching catalog-backed amendment material line." });
  if (req.body.source_type === "material_usage" && (req.db.v5_material_allocations || []).some((item) => item.material_usage_id === source.id)) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_ALREADY_ALLOCATED", message: "This material evidence is already allocated to an original quote line." });
  }
  if (!Array.isArray(req.db.v5_amendment_evidence_allocations)) req.db.v5_amendment_evidence_allocations = [];
  const fingerprint = requestFingerprint({ dispatch_card_id: dispatch.id, ...req.body });
  const prior = findIdempotentRecord(req.db.v5_amendment_evidence_allocations, actor.id, key.key, fingerprint, "allocated_by");
  if (prior.kind === "conflict") return res.status(409).json({ success: false, message: "This idempotency key was used for different amendment evidence." });
  if (prior.kind === "replay") return res.json({ success: true, idempotent_replay: true, data: publicRecord(prior.record) });
  const sourceQuantity = req.body.source_type === "field_worksheet" ? source.hours : source.quantity_used;
  if (!positiveNumber(sourceQuantity) || !positiveNumber(line.quantity)) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_INELIGIBLE", message: "The evidence and amendment line must both have a valid positive quantity." });
  }
  const used = allocationTotal(req.db.v5_amendment_evidence_allocations, (item) => item.source_type === req.body.source_type && item.source_id === source.id);
  const lineUsed = allocationTotal(req.db.v5_amendment_evidence_allocations, (item) => item.amendment_quote_line_id === line.id);
  if (used === null || lineUsed === null) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_INELIGIBLE", message: "Existing allocation evidence has an invalid quantity and requires review." });
  }
  if (used + req.body.quantity > sourceQuantity + EPSILON || lineUsed + req.body.quantity > line.quantity + EPSILON) return res.status(409).json({ success: false, code: "V5_AMENDMENT_COVERAGE_EXCEEDED", message: "The requested coverage exceeds the available evidence or accepted amendment quantity." });
  const record = { id: req.store.id("v5aca"), dispatch_card_id: dispatch.id, amendment_quote_id: link.amendment_quote_id, amendment_quote_line_id: line.id, source_type: req.body.source_type, source_id: source.id, quantity: req.body.quantity, unit: req.body.source_type === "field_worksheet" ? "hours" : (source.unit_of_measure || null), reason: req.body.reason, allocated_by: actor.id, allocated_at: new Date().toISOString(), idempotency_key: key.key, idempotency_fingerprint: fingerprint };
  req.db.v5_amendment_evidence_allocations.push(record);
  req.store.audit(req.db, actor, "v5_amendment_evidence_allocation", record.id, "V5_AMENDMENT_EVIDENCE_ALLOCATED", null, publicRecord(record));
  return res.status(201).json({ success: true, data: publicRecord(record) });
}
