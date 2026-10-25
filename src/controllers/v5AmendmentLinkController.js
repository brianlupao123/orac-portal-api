import { requirePermission } from "../permissions.js";
import { readIdempotencyKey, requestFingerprint, findIdempotentRecord } from "../inventoryLedger.js";
import { v5Enabled } from "../v5CommercialWorkflow.js";

const disabled = (res) => res.status(409).json({ success: false, code: "FEATURE_DISABLED", message: "V5 amendment linking is not enabled yet." });
const rootId = (quote) => quote?.root_quote_id || quote?.id || null;

function publicLink(link) {
  const { idempotency_key: _key, idempotency_fingerprint: _fingerprint, ...safe } = link;
  return safe;
}

// This attaches a separately approved commercial amendment to one dispatch.
// It deliberately does not change the dispatch's original accepted quotation,
// evidence mappings, PO value, or invoice preview. Those coverage semantics
// need a separate, deterministic writer/read-model design.
export function linkV5AmendmentToDispatch(req, res) {
  const actor = (req.db.users || []).find((user) => user.id === req.user?.id) || null;
  requirePermission(actor, "manageV5AmendmentLink");
  if (!v5Enabled()) return disabled(res);

  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, message: "Dispatch card not found." });
  const dispatchQuote = (req.db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  const amendment = (req.db.quotes || []).find((item) => item.id === req.body.amendment_quote_id);
  if (!dispatchQuote?.v5_commercial_workflow || !amendment?.v5_commercial_workflow || !amendment.revision_of_quote_id) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_LINK_INVALID", message: "The dispatch and amendment must be linked to V5 quotation revisions." });
  }
  if (rootId(dispatchQuote) !== rootId(amendment)) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_LINEAGE_MISMATCH", message: "The amendment revision does not belong to this dispatch quotation lineage." });
  }
  const po = (req.db.purchase_orders || []).find((item) => item.id === amendment.commercial_acceptance_po_id);
  if (!amendment.v5_amendment_approval || amendment.commercial_acceptance_status !== "po_verified" || !po || po.status !== "verified") {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_NOT_APPROVED", message: "Only an independently approved V5 amendment with a verified purchase order may be linked." });
  }

  const keyResult = readIdempotencyKey(req);
  if (keyResult.error) return res.status(400).json({ success: false, message: keyResult.error });
  if (!keyResult.key) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "An Idempotency-Key is required to link a V5 amendment." });
  if (!Array.isArray(req.db.v5_amendment_dispatch_links)) req.db.v5_amendment_dispatch_links = [];
  const fingerprint = requestFingerprint({ dispatch_card_id: dispatch.id, amendment_quote_id: amendment.id });
  const prior = findIdempotentRecord(req.db.v5_amendment_dispatch_links, actor.id, keyResult.key, fingerprint, "linked_by");
  if (prior.kind === "conflict") return res.status(409).json({ success: false, message: "This idempotency key was already used for a different amendment link." });
  if (prior.kind === "replay") return res.json({ success: true, idempotent_replay: true, data: publicLink(prior.record) });
  if (req.db.v5_amendment_dispatch_links.some((item) => item.dispatch_card_id === dispatch.id && item.amendment_quote_id === amendment.id)) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_ALREADY_LINKED", message: "This approved amendment is already linked to the dispatch." });
  }

  const link = {
    id: req.store.id("v5adl"),
    dispatch_card_id: dispatch.id,
    dispatch_quote_id: dispatchQuote.id,
    amendment_quote_id: amendment.id,
    amendment_purchase_order_id: po.id,
    amendment_approval_at: amendment.v5_amendment_approval.approved_at,
    linked_by: actor.id,
    linked_at: new Date().toISOString(),
    idempotency_key: keyResult.key,
    idempotency_fingerprint: fingerprint
  };
  req.db.v5_amendment_dispatch_links.push(link);
  req.store.audit(req.db, actor, "v5_amendment_dispatch_link", link.id, "V5_AMENDMENT_LINKED_TO_DISPATCH", null, publicLink(link));
  return res.status(201).json({ success: true, data: publicLink(link) });
}
