import { createHash } from "node:crypto";
import { requirePermission } from "../permissions.js";
import { calculateLegacyInvoiceAmounts, invoiceReadinessBlock } from "../invoiceReadiness.js";
import { issueLegacyInvoice } from "../stateMachine.js";

const copy = (value) => JSON.parse(JSON.stringify(value));

function actorFor(req) {
  return (req.db.users || []).find((user) => user.id === req.user?.id) || null;
}

function dispatchAndQuote(db, dispatchId) {
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  const quote = dispatch && (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  return { dispatch, quote };
}

function candidate(db, dispatch, quote) {
  const amounts = calculateLegacyInvoiceAmounts(db, dispatch, quote);
  const po = (db.purchase_orders || []).find((item) => item.id === dispatch.purchase_order_id || item.quotation_id === quote.id);
  const snapshot = {
    dispatch_card_id: dispatch.id,
    quotation_id: quote.id,
    quotation_revision: quote.revision_number || quote.version || null,
    purchase_order_id: po?.id || null,
    purchase_order_amount: po?.po_amount || null,
    tax_status: quote.tax_status || null,
    currency: "USD",
    labor_total: amounts.laborTotal,
    material_total: amounts.materialTotal,
    total: amounts.total,
    worksheet_ids: (amounts.timesheets || []).map((item) => item.source_worksheet_id || item.id).sort(),
    material_ids: (amounts.materials || []).map((item) => item.id).sort()
  };
  return { ...snapshot, candidate_hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

function fingerprint(command, dispatchId, key) {
  return createHash("sha256").update(JSON.stringify(["legacy.invoice.v1", command, dispatchId, key])).digest("hex");
}

function publicDraft(draft, db) {
  const invoice = draft.issued_invoice_id && (db.invoices || []).find((item) => item.id === draft.issued_invoice_id);
  return {
    id: draft.id, dispatch_card_id: draft.dispatch_card_id, quotation_id: draft.quotation_id,
    purchase_order_id: draft.purchase_order_id, status: invoice ? "issued" : draft.status,
    prepared_by: draft.prepared_by, prepared_at: draft.prepared_at, candidate: copy(draft.candidate),
    ...(invoice ? { issued_invoice_id: invoice.id, issued_at: draft.issued_at } : {})
  };
}

function refuse(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

export function listLegacyInvoiceDrafts(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageLegacyInvoiceDraft");
  const { dispatch } = dispatchAndQuote(req.db, req.params.id);
  if (!dispatch) return refuse(res, 404, "DISPATCH_NOT_FOUND", "Dispatch card not found.");
  return res.json({ success: true, data: (req.db.legacy_invoice_drafts || []).filter((item) => item.dispatch_card_id === dispatch.id).map((item) => publicDraft(item, req.db)) });
}

export function createLegacyInvoiceDraft(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageLegacyInvoiceDraft");
  const { dispatch, quote } = dispatchAndQuote(req.db, req.params.id);
  if (!dispatch || !quote) return refuse(res, 404, "DISPATCH_NOT_FOUND", "Dispatch card not found.");
  if (quote.v5_commercial_workflow) return refuse(res, 409, "V5_INVOICE_PATH_REQUIRED", "This quotation uses the separate V5 invoice workflow.");
  const key = req.body.idempotency_key;
  const hash = fingerprint("draft", dispatch.id, key);
  const prior = (req.db.legacy_invoice_idempotency || []).find((item) => item.idempotency_key === key);
  if (prior) {
    if (prior.fingerprint !== hash || prior.command !== "draft") return refuse(res, 409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different invoice draft request.");
    const draft = (req.db.legacy_invoice_drafts || []).find((item) => item.id === prior.resource_id);
    if (!draft) return refuse(res, 409, "INVOICE_DRAFT_IDEMPOTENCY_CORRUPT", "The invoice draft idempotency record is incomplete.");
    return res.json({ success: true, idempotent_replay: true, data: publicDraft(draft, req.db) });
  }
  const blocked = invoiceReadinessBlock(req.db, dispatch);
  if (blocked) return refuse(res, blocked.status, blocked.code, blocked.message);
  const existing = (req.db.legacy_invoice_drafts || []).find((item) => item.dispatch_card_id === dispatch.id && item.status === "prepared");
  if (existing) return refuse(res, 409, "LEGACY_INVOICE_DRAFT_EXISTS", "A prepared invoice draft already exists for this dispatch.");
  const now = new Date().toISOString();
  const draft = {
    id: req.store.id("lidraft"), dispatch_card_id: dispatch.id, quotation_id: quote.id,
    purchase_order_id: dispatch.purchase_order_id || null, status: "prepared", prepared_by: actor.id,
    prepared_at: now, candidate: candidate(req.db, dispatch, quote), idempotency_key: key, idempotency_fingerprint: hash
  };
  (req.db.legacy_invoice_drafts ||= []).push(draft);
  (req.db.legacy_invoice_idempotency ||= []).push({ id: req.store.id("liid"), command: "draft", idempotency_key: key, fingerprint: hash, resource_id: draft.id, created_at: now });
  req.store.audit(req.db, actor, "legacy_invoice_draft", draft.id, "LEGACY_INVOICE_DRAFT_PREPARED", null, publicDraft(draft, req.db));
  return res.status(201).json({ success: true, data: publicDraft(draft, req.db) });
}

export function issueLegacyInvoiceDraft(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "issueLegacyInvoiceDraft");
  const draft = (req.db.legacy_invoice_drafts || []).find((item) => item.id === req.params.id);
  if (!draft) return refuse(res, 404, "LEGACY_INVOICE_DRAFT_NOT_FOUND", "Invoice draft not found.");
  if (draft.prepared_by === actor.id) return refuse(res, 403, "LEGACY_INVOICE_TWO_PERSON_REQUIRED", "The user who prepared an invoice draft cannot issue it.");
  const key = req.body.idempotency_key;
  const hash = fingerprint("issue", draft.dispatch_card_id, key);
  const prior = (req.db.legacy_invoice_idempotency || []).find((item) => item.idempotency_key === key);
  if (prior) {
    if (prior.fingerprint !== hash || prior.command !== "issue") return refuse(res, 409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different invoice issue request.");
    const invoice = (req.db.invoices || []).find((item) => item.id === prior.resource_id);
    if (!invoice) return refuse(res, 409, "INVOICE_ISSUE_IDEMPOTENCY_CORRUPT", "The invoice issue idempotency record is incomplete.");
    return res.json({ success: true, idempotent_replay: true, data: invoice });
  }
  if (draft.status !== "prepared") return refuse(res, 409, "LEGACY_INVOICE_DRAFT_NOT_ISSUABLE", "Only a prepared invoice draft may be issued.");
  const { dispatch, quote } = dispatchAndQuote(req.db, draft.dispatch_card_id);
  if (!dispatch || !quote || quote.v5_commercial_workflow) return refuse(res, 409, "LEGACY_INVOICE_DRAFT_STALE", "The invoice draft no longer has an eligible legacy dispatch.");
  const blocked = invoiceReadinessBlock(req.db, dispatch);
  if (blocked) return refuse(res, blocked.status, blocked.code, blocked.message);
  if (candidate(req.db, dispatch, quote).candidate_hash !== draft.candidate.candidate_hash) return refuse(res, 409, "LEGACY_INVOICE_DRAFT_STALE", "Evidence or commercial authority changed after this invoice draft was prepared. Prepare a new draft.");
  const invoice = issueLegacyInvoice(req.db, req.store, quote.id, actor);
  const now = new Date().toISOString();
  draft.status = "issued";
  draft.issued_invoice_id = invoice.id;
  draft.issued_by = actor.id;
  draft.issued_at = now;
  (req.db.legacy_invoice_idempotency ||= []).push({ id: req.store.id("liid"), command: "issue", idempotency_key: key, fingerprint: hash, resource_id: invoice.id, created_at: now });
  req.store.audit(req.db, actor, "legacy_invoice_draft", draft.id, "LEGACY_INVOICE_DRAFT_ISSUED", null, publicDraft(draft, req.db));
  return res.status(201).json({ success: true, data: invoice });
}
