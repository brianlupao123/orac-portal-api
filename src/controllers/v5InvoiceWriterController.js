import { requirePermission } from "../permissions.js";
import { buildV5InvoiceCandidate, nextV5InvoiceNumber, v5InvoiceCandidateHash, v5InvoiceDraftWorkspace, v5InvoiceLineEvidence } from "../v5InvoiceWriter.js";
import { config } from "../config.js";
import { v5InvoiceWriterRefusal } from "../v5InvoiceWriterPolicy.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const active = (record) => String(record?.status || "").toLowerCase() !== "voided";
const quoteRootId = (quote) => quote?.root_quote_id || quote?.id || null;

function actorFor(req) {
  return (req.db.users || []).find((user) => user.id === req.user?.id) || null;
}

function respondError(res, error) {
  return res.status(error.status || 409).json({ success: false, code: error.code, message: error.message, ...(error.blockers ? { blockers: error.blockers } : {}) });
}

function idempotencyFingerprint(command, dispatchId, payload) {
  return v5InvoiceCandidateHash({ command, dispatch_card_id: dispatchId, payload });
}

function publicDraft(record, db = null) {
  const { request_lines, idempotency_key, idempotency_fingerprint, ...safe } = record;
  const invoice = db && (db.v5_invoices || []).find((item) => item.draft_id === record.id);
  return {
    ...safe,
    status: invoice ? "issued" : record.status,
    ...(invoice ? { issued_invoice_id: invoice.id, issued_at: invoice.issued_at } : {})
  };
}

function publicInvoice(record) {
  const { idempotency_key, idempotency_fingerprint, ...safe } = record;
  return safe;
}

function idempotencyRecord(db, key) {
  return (db.v5_invoice_idempotency || []).find((item) => item.idempotency_key === key) || null;
}

function samePoOnly(candidate) {
  const poIds = new Set(candidate.lines.map((line) => line.purchase_order_id));
  return poIds.size === 1 ? [...poIds][0] : null;
}

function isDispatchLineage(db, dispatch, quote, link = null) {
  const dispatchQuote = (db.quotes || []).find((item) => item.id === dispatch?.quotation_id);
  return Boolean(
    dispatchQuote && quote && quoteRootId(dispatchQuote) === quoteRootId(quote) &&
    (!link?.dispatch_quote_id || link.dispatch_quote_id === dispatchQuote.id)
  );
}

function writerGate(req, res) {
  const refusal = v5InvoiceWriterRefusal({ storeDriver: req.store?.driver || config.storeDriver });
  if (!refusal) return false;
  res.status(409).json({ success: false, ...refusal });
  return true;
}

function createEvent(req, actor, invoiceId, action, details) {
  const event = {
    id: req.store.id("v5ive"), invoice_id: invoiceId, action,
    actor_id: actor.id, created_at: new Date().toISOString(), details: copy(details)
  };
  (req.db.v5_invoice_events ||= []).push(event);
  req.store.audit(req.db, actor, "v5_invoice", invoiceId, action, null, event);
}

export function getV5InvoiceDraftWorkspace(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5InvoiceDraft");
  if (writerGate(req, res)) return;
  const result = v5InvoiceDraftWorkspace(req.db, req.params.id, { storeDriver: req.store?.driver || config.storeDriver });
  if (result.error) return respondError(res, result.error);
  return res.json({ success: true, data: result.data });
}

export function listDispatchV5InvoiceDrafts(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5InvoiceDraft");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  const drafts = (req.db.v5_invoice_drafts || [])
    .filter((item) => item.dispatch_card_id === dispatch.id)
    .map((item) => publicDraft(item, req.db));
  return res.json({ success: true, data: drafts });
}

// Drafts are disposable calculation snapshots. They consume no source,
// receive no invoice number, and are always recalculated under lock at issue.
export function createV5InvoiceDraft(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5InvoiceDraft");
  if (writerGate(req, res)) return;
  const fingerprint = idempotencyFingerprint("draft", req.params.id, req.body);
  const key = req.body.idempotency_key;
  const prior = idempotencyRecord(req.db, key);
  if (prior) {
    if (prior.fingerprint !== fingerprint || prior.command !== "draft") {
      return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was used for a different V5 invoice operation." });
    }
    const draft = (req.db.v5_invoice_drafts || []).find((item) => item.id === prior.resource_id);
    if (!draft) return res.status(409).json({ success: false, code: "V5_IDEMPOTENCY_CORRUPT", message: "The V5 invoice idempotency record is incomplete and requires review." });
    return res.json({ success: true, idempotent_replay: true, data: publicDraft(draft, req.db) });
  }
  const result = buildV5InvoiceCandidate(req.db, req.params.id, req.body.lines, { storeDriver: req.store?.driver || config.storeDriver });
  if (result.error) return respondError(res, result.error);
  const purchaseOrderId = samePoOnly(result.data);
  if (!purchaseOrderId) return res.status(409).json({ success: false, code: "V5_MULTIPLE_PO_DRAFT_UNSUPPORTED", message: "A V5 draft may cover one verified purchase order. Prepare separate drafts for original and amendment POs." });
  const draft = {
    id: req.store.id("v5idraft"), dispatch_card_id: req.params.id, purchase_order_id: purchaseOrderId,
    status: "prepared", prepared_by: actor.id, prepared_at: new Date().toISOString(),
    request_lines: copy(req.body.lines), candidate: result.data, candidate_hash: result.data.candidate_hash,
    idempotency_key: key, idempotency_fingerprint: fingerprint
  };
  (req.db.v5_invoice_drafts ||= []).push(draft);
  (req.db.v5_invoice_idempotency ||= []).push({
    id: req.store.id("v5iid"), command: "draft", idempotency_key: key, fingerprint,
    resource_id: draft.id, created_at: draft.prepared_at
  });
  req.store.audit(req.db, actor, "v5_invoice_draft", draft.id, "V5_INVOICE_DRAFT_PREPARED", null, publicDraft(draft, req.db));
  return res.status(201).json({ success: true, data: publicDraft(draft, req.db) });
}

export function issueV5InvoiceDraft(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "issueV5Invoice");
  if (writerGate(req, res)) return;
  const draft = (req.db.v5_invoice_drafts || []).find((item) => item.id === req.params.id);
  if (!draft) return res.status(404).json({ success: false, code: "V5_INVOICE_DRAFT_NOT_FOUND", message: "V5 invoice draft not found." });
  if (draft.prepared_by === actor.id) return res.status(403).json({ success: false, code: "V5_INVOICE_TWO_PERSON_REQUIRED", message: "The user who prepared a V5 invoice draft cannot issue it." });
  const fingerprint = idempotencyFingerprint("issue", draft.dispatch_card_id, { draft_id: draft.id, ...req.body });
  const key = req.body.idempotency_key;
  const prior = idempotencyRecord(req.db, key);
  if (prior) {
    if (prior.fingerprint !== fingerprint || prior.command !== "issue") {
      return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was used for a different V5 invoice operation." });
    }
    const invoice = (req.db.v5_invoices || []).find((item) => item.id === prior.resource_id);
    if (!invoice) return res.status(409).json({ success: false, code: "V5_IDEMPOTENCY_CORRUPT", message: "The V5 invoice idempotency record is incomplete and requires review." });
    return res.json({ success: true, idempotent_replay: true, data: publicInvoice(invoice) });
  }
  if (draft.status !== "prepared" || (req.db.v5_invoices || []).some((item) => item.draft_id === draft.id)) {
    return res.status(409).json({ success: false, code: "V5_INVOICE_DRAFT_NOT_ISSUABLE", message: "Only an unissued prepared V5 invoice draft may be issued." });
  }
  const result = buildV5InvoiceCandidate(req.db, draft.dispatch_card_id, draft.request_lines, { storeDriver: req.store?.driver || config.storeDriver });
  if (result.error) return respondError(res, result.error);
  if (result.data.candidate_hash !== draft.candidate_hash) {
    return res.status(409).json({ success: false, code: "V5_INVOICE_DRAFT_STALE", message: "The V5 invoice evidence or authority changed after draft preparation. Prepare a new draft." });
  }
  const purchaseOrderId = samePoOnly(result.data);
  if (!purchaseOrderId || purchaseOrderId !== draft.purchase_order_id) {
    return res.status(409).json({ success: false, code: "V5_INVOICE_DRAFT_STALE", message: "The V5 invoice purchase-order authority changed after draft preparation." });
  }
  const number = nextV5InvoiceNumber(req.db);
  const issuedAt = new Date().toISOString();
  const invoice = {
    id: req.store.id("v5inv"), invoice_number: number.invoice_number, dispatch_card_id: draft.dispatch_card_id,
    purchase_order_id: purchaseOrderId, draft_id: draft.id, status: "issued", currency: "USD", tax_status: "unconfigured",
    pre_tax_total_cents: result.data.pre_tax_total_cents, tax_total_cents: 0, grand_total_cents: result.data.grand_total_cents,
    prepared_by: draft.prepared_by, issued_by: actor.id, issued_at: issuedAt, candidate_hash: result.data.candidate_hash,
    correction_boundary: "V1 has no void, credit-note, release, update or delete path. Issued source consumption remains immutable.",
    idempotency_key: key, idempotency_fingerprint: fingerprint
  };
  const lines = result.data.lines.map((line) => ({ id: req.store.id("v5il"), invoice_id: invoice.id, ...copy(line), issued_at: issuedAt }));
  const consumption = result.data.lines.flatMap((line) => line.sources.map((source) => ({
    id: req.store.id("v5ics"), invoice_id: invoice.id, invoice_line_id: lines.find((item) => item.quote_line_id === line.quote_line_id)?.id || null,
    dispatch_card_id: invoice.dispatch_card_id, quote_line_id: line.quote_line_id, source_type: source.source_type,
    source_id: source.source_id, quantity_micro_units: source.quantity_micro_units, created_at: issuedAt
  })));
  (req.db.v5_invoices ||= []).push(invoice);
  (req.db.v5_invoice_lines ||= []).push(...lines);
  (req.db.v5_invoice_source_consumption ||= []).push(...consumption);
  (req.db.v5_invoice_number_ledger ||= []).push({ year: number.year, last_sequence: number.sequence, invoice_id: invoice.id, assigned_at: issuedAt });
  req.db.v5_invoice_idempotency.push({ id: req.store.id("v5iid"), command: "issue", idempotency_key: key, fingerprint, resource_id: invoice.id, created_at: issuedAt });
  createEvent(req, actor, invoice.id, "V5_INVOICE_ISSUED", { draft_id: draft.id, candidate_hash: invoice.candidate_hash });
  return res.status(201).json({ success: true, data: publicInvoice(invoice) });
}

export function getV5InvoiceDraft(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5InvoiceDraft");
  if (writerGate(req, res)) return;
  const draft = (req.db.v5_invoice_drafts || []).find((item) => item.id === req.params.id);
  if (!draft) return res.status(404).json({ success: false, code: "V5_INVOICE_DRAFT_NOT_FOUND", message: "V5 invoice draft not found." });
  return res.json({ success: true, data: publicDraft(draft, req.db) });
}

export function recordV5LineCompletion(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "recordV5LineCompletion");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  if (dispatch.assigned_supervisor_id !== actor.id) {
    return res.status(403).json({ success: false, code: "V5_COMPLETION_SUPERVISOR_REQUIRED", message: "Only the Supervisor assigned to this dispatch can record line completion." });
  }
  const line = (req.db.quote_lines || []).find((item) => item.id === req.body.quote_line_id);
  if (!line || !["minimum_hours", "fixed"].includes(line.pricing_basis)) {
    return res.status(409).json({ success: false, code: "V5_COMPLETION_LINE_INVALID", message: "Completion is available only for a minimum-hours or fixed V5 line." });
  }
  const quote = (req.db.quotes || []).find((item) => item.id === line.quotation_id);
  const isOriginal = quote?.id === dispatch.quotation_id;
  const linked = (req.db.v5_amendment_dispatch_links || []).find((item) => item.dispatch_card_id === dispatch.id && item.amendment_quote_id === quote?.id);
  if (!quote?.v5_commercial_workflow || (!isOriginal && (!linked || !isDispatchLineage(req.db, dispatch, quote, linked)))) {
    return res.status(409).json({ success: false, code: "V5_COMPLETION_LINE_OUT_OF_SCOPE", message: "The V5 line is not authorized for this dispatch." });
  }
  const fingerprint = idempotencyFingerprint("completion", dispatch.id, req.body);
  const prior = idempotencyRecord(req.db, req.body.idempotency_key);
  if (prior) {
    if (prior.command !== "completion" || prior.fingerprint !== fingerprint) return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was used for a different V5 invoice operation." });
    const record = (req.db.v5_line_completions || []).find((item) => item.id === prior.resource_id);
    if (!record) return res.status(409).json({ success: false, code: "V5_IDEMPOTENCY_CORRUPT", message: "The V5 invoice idempotency record is incomplete and requires review." });
    return res.json({ success: true, idempotent_replay: true, data: copy(record) });
  }
  const evidence = v5InvoiceLineEvidence(req.db, dispatch.id, line.id);
  if (evidence.total_micro_units <= 0) return res.status(409).json({ success: false, code: "V5_COMPLETION_EVIDENCE_REQUIRED", message: "Completion needs current V5-verified Timesheet evidence for this line." });
  const record = {
    id: req.store.id("v5lc"), dispatch_card_id: dispatch.id, quote_line_id: line.id,
    evidence_hash: evidence.evidence_hash, reason: req.body.reason, completed_by: actor.id,
    completed_at: new Date().toISOString(), idempotency_key: req.body.idempotency_key, idempotency_fingerprint: fingerprint
  };
  (req.db.v5_line_completions ||= []).push(record);
  (req.db.v5_invoice_idempotency ||= []).push({ id: req.store.id("v5iid"), command: "completion", idempotency_key: req.body.idempotency_key, fingerprint, resource_id: record.id, created_at: record.completed_at });
  req.store.audit(req.db, actor, "v5_line_completion", record.id, "V5_LINE_COMPLETION_RECORDED", null, copy(record));
  return res.status(201).json({ success: true, data: copy(record) });
}

function approvedLinkedAmendment(db, dispatchId, quoteId) {
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  const quote = (db.quotes || []).find((item) => item.id === quoteId);
  const link = (db.v5_amendment_dispatch_links || []).find((item) => item.dispatch_card_id === dispatchId && item.amendment_quote_id === quoteId);
  const po = (db.purchase_orders || []).find((item) => item.id === link?.amendment_purchase_order_id);
  if (!dispatch || !isDispatchLineage(db, dispatch, quote, link) || !quote?.revision_of_quote_id || !quote.v5_amendment_approval || quote.commercial_acceptance_status !== "po_verified" || quote.commercial_acceptance_po_id !== po?.id || po?.status !== "verified") return null;
  return { quote, link, po };
}

export function supersedeV5Amendment(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5AmendmentSupersession");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  const previous = approvedLinkedAmendment(req.db, dispatch.id, req.body.superseded_amendment_quote_id);
  const replacement = approvedLinkedAmendment(req.db, dispatch.id, req.body.replacement_amendment_quote_id);
  if (!previous || !replacement || previous.quote.revision_of_quote_id !== replacement.quote.revision_of_quote_id) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_LINEAGE_INVALID", message: "Supersession requires two independently approved amendments in the same dispatch lineage." });
  }
  if ([previous.quote.v5_amendment_approval.approved_by, replacement.quote.v5_amendment_approval.approved_by].includes(actor.id)) {
    return res.status(403).json({ success: false, code: "V5_AMENDMENT_SUPERSESSION_SEPARATION_REQUIRED", message: "The amendment approver cannot supersede its own approved amendment." });
  }
  if ((req.db.v5_invoice_lines || []).some((item) => item.quotation_id === previous.quote.id)) {
    return res.status(409).json({ success: false, code: "V5_SUPERSEDED_AMENDMENT_ALREADY_ISSUED", message: "An issued amendment portion is immutable and cannot be superseded." });
  }
  const fingerprint = idempotencyFingerprint("supersession", dispatch.id, req.body);
  const prior = idempotencyRecord(req.db, req.body.idempotency_key);
  if (prior) {
    if (prior.command !== "supersession" || prior.fingerprint !== fingerprint) return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was used for a different V5 invoice operation." });
    const record = (req.db.v5_amendment_supersessions || []).find((item) => item.id === prior.resource_id);
    if (!record) return res.status(409).json({ success: false, code: "V5_IDEMPOTENCY_CORRUPT", message: "The V5 invoice idempotency record is incomplete and requires review." });
    return res.json({ success: true, idempotent_replay: true, data: copy(record) });
  }
  const record = {
    id: req.store.id("v5as"), dispatch_card_id: dispatch.id,
    superseded_amendment_quote_id: previous.quote.id, replacement_amendment_quote_id: replacement.quote.id,
    reason: req.body.reason, superseded_by: actor.id, superseded_at: new Date().toISOString(),
    idempotency_key: req.body.idempotency_key, idempotency_fingerprint: fingerprint
  };
  (req.db.v5_amendment_supersessions ||= []).push(record);
  (req.db.v5_invoice_idempotency ||= []).push({ id: req.store.id("v5iid"), command: "supersession", idempotency_key: req.body.idempotency_key, fingerprint, resource_id: record.id, created_at: record.superseded_at });
  req.store.audit(req.db, actor, "v5_amendment_supersession", record.id, "V5_AMENDMENT_SUPERSEDED", null, copy(record));
  return res.status(201).json({ success: true, data: copy(record) });
}

export function remapV5Allocation(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "manageV5AllocationRemap");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  const allocation = (req.db.v5_amendment_evidence_allocations || []).find((item) => item.id === req.body.allocation_id && item.dispatch_card_id === dispatch.id);
  if (!allocation) return res.status(404).json({ success: false, code: "V5_ALLOCATION_NOT_FOUND", message: "Amendment evidence allocation not found on this dispatch." });
  const supersession = (req.db.v5_amendment_supersessions || []).find((item) => item.dispatch_card_id === dispatch.id && item.superseded_amendment_quote_id === allocation.amendment_quote_id);
  if (!supersession) return res.status(409).json({ success: false, code: "V5_ALLOCATION_REMAP_NOT_AUTHORIZED", message: "Only an allocation from a recorded superseded amendment may be remapped." });
  const replacementLine = (req.db.quote_lines || []).find((item) => item.id === req.body.replacement_amendment_quote_line_id && item.quotation_id === supersession.replacement_amendment_quote_id);
  if (!replacementLine || replacementLine.pricing_basis === "fixed") return res.status(409).json({ success: false, code: "V5_ALLOCATION_REMAP_LINE_INVALID", message: "The replacement amendment line is invalid for this evidence allocation." });
  const sourceTypeMatches = (allocation.source_type === "field_worksheet" && ["hourly", "minimum_hours"].includes(replacementLine.pricing_basis)) ||
    (allocation.source_type === "material_usage" && replacementLine.pricing_basis === "material");
  if (!sourceTypeMatches) return res.status(409).json({ success: false, code: "V5_ALLOCATION_REMAP_LINE_INVALID", message: "The replacement line pricing basis does not match the allocation evidence type." });
  if ((req.db.v5_invoice_source_consumption || []).some((item) => item.source_type === allocation.source_type && item.source_id === allocation.source_id)) {
    return res.status(409).json({ success: false, code: "V5_ALLOCATION_ALREADY_CONSUMED", message: "Consumed evidence is immutable and cannot be remapped." });
  }
  const fingerprint = idempotencyFingerprint("remap", dispatch.id, req.body);
  const prior = idempotencyRecord(req.db, req.body.idempotency_key);
  if (prior) {
    if (prior.command !== "remap" || prior.fingerprint !== fingerprint) return res.status(409).json({ success: false, code: "IDEMPOTENCY_KEY_REUSED", message: "This idempotency key was used for a different V5 invoice operation." });
    const record = (req.db.v5_allocation_remaps || []).find((item) => item.id === prior.resource_id);
    if (!record) return res.status(409).json({ success: false, code: "V5_IDEMPOTENCY_CORRUPT", message: "The V5 invoice idempotency record is incomplete and requires review." });
    return res.json({ success: true, idempotent_replay: true, data: copy(record) });
  }
  if ((req.db.v5_allocation_remaps || []).some((item) => item.allocation_id === allocation.id)) return res.status(409).json({ success: false, code: "V5_ALLOCATION_ALREADY_REMAPPED", message: "This amendment allocation has already been remapped." });
  const record = {
    id: req.store.id("v5ar"), dispatch_card_id: dispatch.id, allocation_id: allocation.id,
    replacement_amendment_quote_line_id: replacementLine.id, reason: req.body.reason, remapped_by: actor.id,
    remapped_at: new Date().toISOString(), idempotency_key: req.body.idempotency_key, idempotency_fingerprint: fingerprint
  };
  (req.db.v5_allocation_remaps ||= []).push(record);
  (req.db.v5_invoice_idempotency ||= []).push({ id: req.store.id("v5iid"), command: "remap", idempotency_key: req.body.idempotency_key, fingerprint, resource_id: record.id, created_at: record.remapped_at });
  req.store.audit(req.db, actor, "v5_allocation_remap", record.id, "V5_AMENDMENT_ALLOCATION_REMAPPED", null, copy(record));
  return res.status(201).json({ success: true, data: copy(record) });
}

export function getV5Invoice(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "viewV5Invoice");
  if (writerGate(req, res)) return;
  const invoice = (req.db.v5_invoices || []).find((item) => item.id === req.params.id);
  if (!invoice) return res.status(404).json({ success: false, code: "V5_INVOICE_NOT_FOUND", message: "V5 invoice not found." });
  const lines = (req.db.v5_invoice_lines || []).filter((item) => item.invoice_id === invoice.id).map(copy);
  const events = (req.db.v5_invoice_events || []).filter((item) => item.invoice_id === invoice.id).map(copy);
  return res.json({ success: true, data: { ...publicInvoice(invoice), lines, events } });
}

export function listDispatchV5Invoices(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "viewV5Invoice");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  const invoices = (req.db.v5_invoices || []).filter((item) => item.dispatch_card_id === dispatch.id).map(publicInvoice);
  return res.json({ success: true, data: invoices });
}

export function getV5InvoiceBillingState(req, res) {
  const actor = actorFor(req);
  requirePermission(actor, "viewV5Invoice");
  if (writerGate(req, res)) return;
  const dispatch = (req.db.dispatch_cards || []).find((item) => item.id === req.params.id);
  if (!dispatch) return res.status(404).json({ success: false, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." });
  const invoices = (req.db.v5_invoices || []).filter((item) => item.dispatch_card_id === dispatch.id && active(item));
  const consumed = (req.db.v5_invoice_source_consumption || []).filter((item) => item.dispatch_card_id === dispatch.id);
  const billedCents = invoices.reduce((total, invoice) => total + Number(invoice.grand_total_cents || 0), 0);
  const state = invoices.length === 0 ? "unbilled" : "partially_billed";
  return res.json({ success: true, data: {
    dispatch_card_id: dispatch.id, billing_state: state, issued_invoice_count: invoices.length,
    billed_cents: billedCents, currency: "USD", consumed_source_count: consumed.length,
    correction_boundary: "V1 has no void, credit-note, release, update or delete path. Issued source consumption remains immutable."
  } });
}
