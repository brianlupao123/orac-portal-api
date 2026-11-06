import { requirePermission, roles } from "../permissions.js";
import { transitionQuote } from "../stateMachine.js";
import { validateEquipmentTagForClient } from "../services/entityHierarchy.js";
import { v5Enabled, getV5Policy } from "../v5CommercialWorkflow.js";
import { calculateV5QuoteLines, quoteTotal } from "../v5QuoteRules.js";
import { calculateQuoteFinancials } from "../quoteCalculation.js";
import { validateLeadLink } from "../recordTrail.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

function requiresApprovedTaxConfiguration() {
  return (process.env.NODE_ENV || "development") === "production"
    || process.env.ORAC_REQUIRE_APPROVED_TAX === "true";
}

// Development and test fixtures deliberately retain the provisional 15% value
// supplied by the local UAT form.  Once approved-tax mode is enabled, however,
// the request body is not commercial authority: only the audited company
// profile configuration may determine a quote's tax treatment.
function resolveQuoteTaxConfiguration(db, body) {
  if (!requiresApprovedTaxConfiguration()) {
    return {
      taxStatus: body.tax_status ?? "provisional",
      appliedTaxRate: body.applied_tax_rate,
      taxApproved: false,
      taxApprovalReference: null
    };
  }

  const configuration = db.company_profile?.quotation_tax_configuration;
  if (!configuration?.approved) {
    return {
      taxStatus: "unconfigured",
      appliedTaxRate: null,
      taxApproved: false,
      taxApprovalReference: null
    };
  }

  return {
    taxStatus: configuration.tax_status,
    appliedTaxRate: configuration.applied_tax_rate,
    taxApproved: true,
    taxApprovalReference: configuration.approval_reference || null
  };
}

// A Draft cannot retain an obsolete tax approval simply because the company
// profile changed after it was created.  Immediately before issue, derive the
// commercial tax state again from the current approved company configuration
// and recalculate the stored totals from the persisted lines.
function refreshTaxConfigurationForIssue(req, quote, actor) {
  if (!requiresApprovedTaxConfiguration()) return;

  const before = { ...quote };
  const taxConfiguration = resolveQuoteTaxConfiguration(req.db, {});
  const lines = req.db.quote_lines.filter((line) => line.quotation_id === quote.id);
  const financials = calculateQuoteFinancials({
    lines,
    discountPercent: quote.discount_percent ?? 0,
    taxStatus: taxConfiguration.taxStatus,
    appliedTaxRate: taxConfiguration.appliedTaxRate
  });

  quote.currency = "USD";
  quote.pre_tax_total_cents = financials.pre_tax_total_cents;
  quote.discount_cents = financials.discount_cents;
  quote.net_subtotal_cents = financials.net_subtotal_cents;
  quote.tax_total_cents = financials.tax_total_cents;
  quote.grand_total_cents = financials.grand_total_cents;
  quote.total_amount = financials.total_amount;
  quote.tax_status = financials.tax_status;
  quote.applied_tax_rate = financials.applied_tax_rate;
  quote.tax_approved = taxConfiguration.taxApproved;
  quote.tax_approval_reference = taxConfiguration.taxApprovalReference;

  req.store.audit(req.db, actor, "quotation", quote.id, "QUOTE_TAX_CONFIGURATION_REFRESHED_FOR_ISSUE", before, quote);
}

function resolveSalesOwnerId(db, actor, bodySalesOwnerId) {
  if (actor.role === roles.SALES) return actor.id;
  if (!bodySalesOwnerId) return null;
  const target = (db.users || []).find((u) => u.id === bodySalesOwnerId && u.role === roles.SALES && u.is_active !== false);
  if (!target) {
    const error = new Error("sales_owner_id must belong to an active Sales user.");
    error.status = 400;
    throw error;
  }
  return target.id;
}

function resolveRevisionSalesOwnerId(db, actor, original, bodySalesOwnerId) {
  // If an Admin explicitly specifies a new sales_owner_id in revision body, validate it
  if (actor.role === roles.ADMIN && bodySalesOwnerId !== undefined) {
    if (!bodySalesOwnerId) return null;
    const target = (db.users || []).find((u) => u.id === bodySalesOwnerId && u.role === roles.SALES && u.is_active !== false);
    if (!target) {
      const error = new Error("sales_owner_id must belong to an active Sales user.");
      error.status = 400;
      throw error;
    }
    return target.id;
  }
  // Otherwise, the revision MUST preserve the original quotation's sales_owner_id
  if (original.sales_owner_id) {
    return original.sales_owner_id;
  }
  // If original had no sales owner, assign to actor if actor is Sales
  if (actor.role === roles.SALES) return actor.id;
  return null;
}

export const createQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote");
  
  const body = req.body;
  let salesOwnerId = null;
  try {
    salesOwnerId = resolveSalesOwnerId(req.db, actor, body.sales_owner_id);
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }
  const client = req.db.clients.find((item) => item.id === body.client_id);
  if (!client) return res.status(400).json({ success: false, message: "Client is required." });

  // A new quote may only link an active equipment tag that belongs to this
  // client (same rule client service requests and maintenance schedules use).
  const tagCheck = validateEquipmentTagForClient(req.db, { tagId: body.equipment_tag_id, clientId: client.id });
  if (!tagCheck.ok) return res.status(tagCheck.status).json({ success: false, message: tagCheck.message });

  const leadLink = validateLeadLink(req.db, { leadId: body.source_lead_id, clientId: client.id });
  if (!leadLink.ok) return res.status(leadLink.status).json({ success: false, code: leadLink.code, message: leadLink.message });

  const taxConfiguration = resolveQuoteTaxConfiguration(req.db, body);
  const financials = calculateQuoteFinancials({
    lines: body.lines,
    discountPercent: body.discount_percent ?? 0,
    taxStatus: taxConfiguration.taxStatus,
    appliedTaxRate: taxConfiguration.appliedTaxRate
  });

  const lines = financials.lines.map((line) => {
    return {
      id: req.store.id("ql"),
      catalog_item_id: line.catalog_item_id || null,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_total: line.line_total,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      unit_of_measure: line.unit_of_measure,
      cost_type: line.cost_type,
      resource_role: line.resource_role || null,
      work_package_id: line.work_package_id,
      item_type: line.item_type,
      is_provisional: Boolean(line.is_provisional)
    };
  });

  const quote = {
    id: req.store.id("quote"),
    quote_number: `Q-${String(req.db.quotes.length + 1).padStart(4, "0")}`,
    client_id: client.id,
    equipment_tag_id: body.equipment_tag_id || null,
    ...(leadLink.leadId ? { source_lead_id: leadLink.leadId } : {}),
    status: "Draft",
    currency: "USD",
    total_amount: financials.total_amount,
    pre_tax_total_cents: financials.pre_tax_total_cents,
    discount_percent: financials.discount_percent,
    discount_cents: financials.discount_cents,
    net_subtotal_cents: financials.net_subtotal_cents,
    tax_status: financials.tax_status,
    applied_tax_rate: financials.applied_tax_rate,
    tax_approved: taxConfiguration.taxApproved,
    tax_approval_reference: taxConfiguration.taxApprovalReference,
    tax_total_cents: financials.tax_total_cents,
    grand_total_cents: financials.grand_total_cents,
    validity_days: body.validity_days || 30,
    scope_summary: body.scope_summary || null,
    assumptions: body.assumptions || null,
    work_packages: body.work_packages && body.work_packages.length > 0
      ? body.work_packages
      : [{ id: "wp_01", code: "WP-01", title: "General Scope", sequence: 1 }],
    sales_owner_id: salesOwnerId,
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
  if (req.body.tax_rate !== undefined && req.body.tax_rate !== null) {
    return res.status(409).json({ success: false, code: "V5_TAX_UNCONFIGURED", message: "V5 tax calculation is not configured." });
  }
  const lines = calculateV5QuoteLines(req.body.lines);
  const preTaxTotalCents = lines.reduce((total, line) => total + line.line_total_cents, 0);
  const rootId = original.root_quote_id || original.id;
  const rootQuote = req.db.quotes.find((quote) => quote.id === rootId) || original;
  const revisionNumber = req.db.quotes.filter((quote) => (quote.root_quote_id || quote.id) === rootId).length;
  let revisionSalesOwnerId = null;
  try {
    revisionSalesOwnerId = resolveRevisionSalesOwnerId(req.db, actor, original, req.body.sales_owner_id);
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }

  const quote = {
    id: req.store.id("quote"),
    quote_number: `${rootQuote.quote_number}-R${revisionNumber}`,
    client_id: original.client_id,
    equipment_tag_id: original.equipment_tag_id || null,
    status: "Draft",
    total_amount: quoteTotal(lines),
    currency: policy.currency,
    tax_rate: null,
    tax_status: "unconfigured",
    pre_tax_total_cents: preTaxTotalCents,
    tax_total_cents: 0,
    grand_total_cents: preTaxTotalCents,
    commercial_acceptance_status: "pending",
    root_quote_id: rootId,
    revision_of_quote_id: original.id,
    revision_number: revisionNumber,
    revision_reason: req.body.reason,
    client_po_reference: req.body.client_po_reference || null,
    client_po_date: req.body.client_po_date || null,
    sales_owner_id: revisionSalesOwnerId,
    account_team_user_ids: [...(original.account_team_user_ids || [])],
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
  if (!quote.v5_commercial_workflow || !quote.revision_of_quote_id) {
    return res.status(409).json({ success: false, message: "Client amendment evidence applies to a V5 quotation revision only." });
  }
  if (quote.amended_po_evidence) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_EVIDENCE_IMMUTABLE", message: "Amended PO evidence is already recorded for this revision. Create a new revision to correct it." });
  }
  const before = { ...quote };
  quote.amended_po_evidence = {
    ...req.body,
    recorded_by: actor.id,
    recorded_at: new Date().toISOString()
  };
  req.store.audit(req.db, actor, "quotation", quote.id, "V5_AMENDED_PO_EVIDENCE_RECORDED", before, quote);
  res.json({ success: true, data: quote });
};

// A V5 amendment approval is evidence of independent reconciliation only. It
// does not change a dispatch, quote snapshot, PO amount, or invoice readiness;
// the later invoice writer must explicitly consume approved amendment coverage.
export const approveV5Amendment = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "approveV5Amendment");
  if (!requireV5CommercialWorkflow(res)) return;

  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (!quote.v5_commercial_workflow || !quote.revision_of_quote_id) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_REVISION_REQUIRED", message: "Only a V5 quotation revision can be approved as an amendment." });
  }
  if (!quote.amended_po_evidence) {
    return res.status(409).json({ success: false, code: "V5_AMENDED_PO_EVIDENCE_REQUIRED", message: "Record the client amendment evidence before approval." });
  }
  const po = req.db.purchase_orders.find((item) => item.id === quote.commercial_acceptance_po_id);
  if (quote.commercial_acceptance_status !== "po_verified" || !po || po.status !== "verified") {
    return res.status(409).json({ success: false, code: "V5_AMENDED_PO_VERIFICATION_REQUIRED", message: "A verified amendment purchase order is required before approval." });
  }
  if (quote.v5_amendment_approval) {
    return res.status(409).json({ success: false, code: "V5_AMENDMENT_ALREADY_APPROVED", message: "This V5 amendment revision is already approved." });
  }
  const excluded = new Set([quote.created_by, quote.amended_po_evidence.recorded_by, quote.commercial_acceptance_verified_by]);
  if (excluded.has(actor.id)) {
    return res.status(403).json({ success: false, code: "V5_AMENDMENT_SEPARATION_OF_DUTIES", message: "The amendment preparer, client-evidence recorder, or PO verifier cannot approve this amendment." });
  }

  const before = { ...quote };
  quote.v5_amendment_approval = {
    approved_by: actor.id,
    approved_at: new Date().toISOString(),
    approved_po_id: po.id,
    evidence_reference: quote.amended_po_evidence.evidence_reference,
    approval_note: req.body.approval_note || null
  };
  req.store.audit(req.db, actor, "quotation", quote.id, "V5_AMENDMENT_APPROVED", before, quote);
  res.json({ success: true, data: quote });
};

export const updateQuote = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "createQuote"); // Sales or Admin

  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (quote.v5_commercial_workflow) {
    return res.status(409).json({
      success: false,
      code: "V5_QUOTE_REVISION_IMMUTABLE",
      message: "A V5 quote revision is immutable. Create another revision for a commercial change."
    });
  }
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
  if (body.scope_summary !== undefined) quote.scope_summary = body.scope_summary;
  if (body.assumptions !== undefined) quote.assumptions = body.assumptions;
  if (body.work_packages !== undefined) quote.work_packages = body.work_packages;
  if (body.validity_days !== undefined) quote.validity_days = body.validity_days;
  if (body.discount_percent !== undefined) quote.discount_percent = body.discount_percent;

  const currentLines = body.lines && Array.isArray(body.lines)
    ? body.lines
    : req.db.quote_lines.filter(l => l.quotation_id === quote.id);

  const taxConfiguration = resolveQuoteTaxConfiguration(req.db, body);
  const financials = calculateQuoteFinancials({
    lines: currentLines,
    discountPercent: quote.discount_percent ?? 0,
    taxStatus: taxConfiguration.taxStatus,
    appliedTaxRate: taxConfiguration.appliedTaxRate
  });

  if (body.lines && Array.isArray(body.lines)) {
    // Remove existing lines
    req.db.quote_lines = req.db.quote_lines.filter(l => l.quotation_id !== quote.id);
    
    // Add new lines
    const newLines = financials.lines.map((line) => ({
      id: req.store.id("ql"),
      quotation_id: quote.id,
      catalog_item_id: line.catalog_item_id || null,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_total: line.line_total,
      unit_price_cents: line.unit_price_cents,
      line_total_cents: line.line_total_cents,
      unit_of_measure: line.unit_of_measure,
      cost_type: line.cost_type,
      resource_role: line.resource_role || null,
      work_package_id: line.work_package_id,
      item_type: line.item_type,
      is_provisional: Boolean(line.is_provisional)
    }));
    req.db.quote_lines.push(...newLines);
  }

  quote.pre_tax_total_cents = financials.pre_tax_total_cents;
  quote.discount_cents = financials.discount_cents;
  quote.net_subtotal_cents = financials.net_subtotal_cents;
  quote.tax_total_cents = financials.tax_total_cents;
  quote.grand_total_cents = financials.grand_total_cents;
  quote.total_amount = financials.total_amount;
  quote.currency = "USD";
  quote.tax_status = financials.tax_status;
  quote.applied_tax_rate = financials.applied_tax_rate;
  quote.tax_approved = taxConfiguration.taxApproved;
  quote.tax_approval_reference = taxConfiguration.taxApprovalReference;

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
  const quote = req.db.quotes.find((item) => item.id === req.params.id);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });
  if (req.body.target_state === "Sent" && quote.status === "Draft") {
    // Do not let an authenticated but unauthorised caller trigger an audited
    // tax refresh or mutate a Draft by attempting issue.
    requirePermission(actor, "sendQuote");
    refreshTaxConfigurationForIssue(req, quote, actor);
  }
  const result = transitionQuote(req.db, req.store, req.params.id, req.body.target_state, req.body, actor);
  res.json({ success: true, data: result });
};

export function normalizePoReference(ref) {
  return String(ref || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function checkQuoteValidity(quote, dateReceived) {
  const sentAt = quote.sent_at ? new Date(quote.sent_at) : null;
  if (!sentAt || Number.isNaN(sentAt.getTime())) {
    return null;
  }
  const validityDays = quote.validity_days || 30;
  const expiresAt = new Date(sentAt.getTime() + validityDays * 24 * 60 * 60 * 1000);
  const checkDate = dateReceived ? new Date(dateReceived) : new Date();
  if (checkDate.getTime() > expiresAt.getTime()) {
    return {
      expired: true,
      expiresAt: expiresAt.toISOString().slice(0, 10),
      sentAt: sentAt.toISOString().slice(0, 10),
      message: `Quotation validity expired on ${expiresAt.toISOString().slice(0, 10)} (30 days from issuance at ${sentAt.toISOString().slice(0, 10)}). A quote revision or validity extension is required before PO verification.`
    };
  }
  return null;
}

function getQuoteGrandTotalCents(quote) {
  return Number.isInteger(quote.grand_total_cents)
    ? quote.grand_total_cents
    : Math.round(Number(quote.total_amount || 0) * 100);
}

function checkPoAmountMatch(quote, poAmount) {
  if (quote.grand_total_cents === undefined && quote.total_amount === undefined) {
    const poCents = Math.round(Number(poAmount) * 100);
    return { match: true, quoteCents: poCents, poCents };
  }
  const quoteCents = getQuoteGrandTotalCents(quote);
  const poCents = Math.round(Number(poAmount) * 100);
  if (poCents < quoteCents) {
    return {
      match: false,
      code: "PO_UNDER_VALUE",
      message: `PO amount (USD ${(poCents / 100).toFixed(2)}) is less than quotation grand total (USD ${(quoteCents / 100).toFixed(2)}). Under-value POs cannot be verified. Request a quote revision or formal PO amendment.`
    };
  }
  if (poCents > quoteCents) {
    return {
      match: false,
      code: "PO_OVER_VALUE",
      message: `PO amount (USD ${(poCents / 100).toFixed(2)}) exceeds quotation grand total (USD ${(quoteCents / 100).toFixed(2)}). Over-value POs cannot be verified as contingency buffer. Request a quote revision or formal PO amendment.`
    };
  }
  return { match: true, quoteCents, poCents };
}

function checkDuplicatePoReference(db, clientId, quoteId, normalizedRef) {
  return (db.purchase_orders || []).find((item) => {
    if (item.status === "rejected" || item.status === "cancelled") return false;
    const itemQuote = (db.quotes || []).find((q) => q.id === item.quotation_id);
    const itemClientId = item.client_id || itemQuote?.client_id;
    if (itemClientId !== clientId) return false;
    if (normalizePoReference(item.po_reference) !== normalizedRef) return false;
    if (item.quotation_id === quoteId) return false;
    return true;
  });
}

export const capturePo = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "verifyPo");

  const quoteId = req.params.id;
  const quote = req.db.quotes.find((item) => item.id === quoteId);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });

  const body = req.body;
  const normalizedRef = normalizePoReference(body.po_reference);

  if (["Invoiced", "Cancelled"].includes(quote.status)) {
    return res.status(409).json({ success: false, message: `PO details cannot be captured for a ${quote.status} quote.` });
  }

  const existingPo = (req.db.purchase_orders || []).find((item) => item.quotation_id === quoteId && item.status !== "rejected" && item.status !== "cancelled");
  const isLegacyPrePo = Boolean(existingPo?.started_before_po || body.started_before_po);

  // Validity check
  if (!isLegacyPrePo) {
    const validity = checkQuoteValidity(quote, body.date_received);
    if (validity?.expired) {
      return res.status(400).json({ success: false, code: "QUOTE_VALIDITY_EXPIRED", message: validity.message });
    }
  }

  // Exact amount match check
  const amountCheck = isLegacyPrePo
    ? { match: true, poCents: Math.round(Number(body.po_amount) * 100) }
    : checkPoAmountMatch(quote, body.po_amount);
  if (!amountCheck.match) {
    return res.status(400).json({ success: false, code: amountCheck.code, message: amountCheck.message });
  }

  // Duplicate check across client
  const clientDup = checkDuplicatePoReference(req.db, quote.client_id, quoteId, normalizedRef);
  if (clientDup) {
    return res.status(409).json({
      success: false,
      code: "DUPLICATE_PO_REFERENCE",
      message: `Purchase order reference '${body.po_reference}' is already in use for another quotation of this client.`
    });
  }

  let po = req.db.purchase_orders.find((item) => item.quotation_id === quoteId && item.status !== "rejected" && item.status !== "cancelled");
  const before = po ? { ...po } : null;

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
      client_id: quote.client_id,
      po_reference: body.po_reference.trim(),
      po_amount: body.po_amount,
      po_amount_cents: amountCheck.poCents,
      currency: "USD",
      status: "verified",
      started_before_po: Boolean(body.started_before_po),
      date_received: body.date_received || new Date().toISOString().slice(0, 10),
      po_issue_date: body.po_issue_date || null,
      document_reference: body.document_reference || null,
      verification_notes: body.verification_notes || null,
      verified_by: actor.id,
      verified_at: new Date().toISOString(),
      requires_amendment: false,
      created_at: new Date().toISOString()
    };
    req.db.purchase_orders.push(po);
  } else {
    Object.assign(po, {
      po_reference: body.po_reference.trim(),
      po_amount: body.po_amount,
      po_amount_cents: amountCheck.poCents,
      currency: "USD",
      status: "verified",
      po_issue_date: body.po_issue_date || po.po_issue_date || null,
      document_reference: body.document_reference || po.document_reference || null,
      verification_notes: body.verification_notes || po.verification_notes || null,
      verified_by: actor.id,
      verified_at: new Date().toISOString()
    });
    req.store.recalculateVariance(req.db, po.id);
  }
  req.store.audit(req.db, actor, "purchase_order", po.id, "PO_VERIFIED", before, po);

  if (quote.v5_commercial_workflow) {
    const quoteBefore = { ...quote };
    const verifiedAt = new Date().toISOString();
    quote.commercial_acceptance_status = "po_verified";
    quote.commercial_accepted_at = quote.commercial_accepted_at || verifiedAt;
    quote.commercial_acceptance_po_id = po.id;
    quote.commercial_acceptance_reference = po.po_reference;
    quote.commercial_acceptance_verified_by = actor.id;
    quote.commercial_acceptance_verified_at = verifiedAt;
    req.store.audit(req.db, actor, "quotation", quote.id, "V5_QUOTE_PO_VERIFIED", quoteBefore, quote);
  }

  // Advance quote to PO_Verified if currently in Approved_Pending_PO or Sent
  if (["Approved_Pending_PO", "Sent"].includes(quote.status)) {
    transitionQuote(req.db, req.store, quote.id, "PO_Verified", {}, actor);
  }

  res.json({ success: true, data: po, quote });
};

export const submitClientPo = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "submitClientPo");

  const quoteId = req.params.id;
  const quote = req.db.quotes.find((item) => item.id === quoteId);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });

  // Tenant Isolation: Client Viewer must match quote.client_id
  if (actor.role === "Client Viewer") {
    if (!actor.client_id || quote.client_id !== actor.client_id) {
      return res.status(403).json({ success: false, message: "Client Viewer cannot submit a PO for another client's quote." });
    }
  }

  // Active client check
  const owningClient = (req.db.clients || []).find((item) => item.id === quote.client_id);
  if (owningClient && owningClient.is_active === false) {
    return res.status(403).json({ success: false, message: "Your client account is not active." });
  }

  // A PO must match one current, Sent/Approved quotation revision
  if (["Draft", "Cancelled", "Invoiced"].includes(quote.status)) {
    return res.status(409).json({ success: false, message: `A PO cannot be submitted for a ${quote.status} quote.` });
  }

  const body = req.body;
  const normalizedRef = normalizePoReference(body.po_reference);

  // Validity check (begins at sent_at)
  const validity = checkQuoteValidity(quote, body.date_received);
  if (validity?.expired) {
    return res.status(400).json({ success: false, code: "QUOTE_VALIDITY_EXPIRED", message: validity.message });
  }

  // Exact amount match check
  const amountCheck = checkPoAmountMatch(quote, body.po_amount);
  if (!amountCheck.match) {
    return res.status(400).json({ success: false, code: amountCheck.code, message: amountCheck.message });
  }

  // Duplicate check across client
  const clientDup = checkDuplicatePoReference(req.db, quote.client_id, quoteId, normalizedRef);
  if (clientDup) {
    return res.status(409).json({
      success: false,
      code: "DUPLICATE_PO_REFERENCE",
      message: `Purchase order reference '${body.po_reference}' is already in use for another quotation of this client.`
    });
  }

  // Active PO check on this quote: find existing pending or verified PO
  const activePo = (req.db.purchase_orders || []).find(
    (item) => item.quotation_id === quoteId && item.status !== "rejected" && item.status !== "cancelled"
  );

  if (activePo && activePo.status === "verified") {
    return res.status(409).json({ success: false, message: "This PO has already been verified internally and cannot be resubmitted by the client." });
  }

  // Idempotent retry: if existing pending PO has same reference and amount
  if (activePo && activePo.status === "pending") {
    if (normalizePoReference(activePo.po_reference) === normalizedRef && Math.round(Number(activePo.po_amount) * 100) === amountCheck.poCents) {
      return res.json({ success: true, data: activePo, idempotent: true });
    }
  }

  let po = activePo;
  const before = po ? { ...po } : null;

  if (!po) {
    po = {
      id: req.store.id("po"),
      quotation_id: quoteId,
      client_id: quote.client_id,
      po_reference: body.po_reference.trim(),
      po_amount: body.po_amount,
      po_amount_cents: amountCheck.poCents,
      currency: "USD",
      status: "pending",
      started_before_po: false,
      date_received: body.date_received || new Date().toISOString().slice(0, 10),
      po_issue_date: body.po_issue_date || null,
      document_reference: body.document_reference || null,
      verified_by: null,
      verified_at: null,
      requires_amendment: false,
      created_at: new Date().toISOString()
    };
    req.db.purchase_orders.push(po);
  } else {
    Object.assign(po, {
      po_reference: body.po_reference.trim(),
      po_amount: body.po_amount,
      po_amount_cents: amountCheck.poCents,
      currency: "USD",
      status: "pending",
      date_received: body.date_received || po.date_received,
      po_issue_date: body.po_issue_date || po.po_issue_date || null,
      document_reference: body.document_reference || po.document_reference || null
    });
  }

  const action = actor.role === "Client Viewer" ? "PO_SUBMITTED_BY_CLIENT" : "PO_RECORDED_BY_STAFF";
  req.store.audit(req.db, actor, "purchase_order", po.id, action, before, po);
  res.json({ success: true, data: po });
};

export const rejectPo = (req, res) => {
  const actor = getActor(req);
  requirePermission(actor, "rejectPo");

  const quoteId = req.params.id;
  const quote = req.db.quotes.find((item) => item.id === quoteId);
  if (!quote) return res.status(404).json({ success: false, message: "Quote not found." });

  const po = (req.db.purchase_orders || []).find((item) => item.quotation_id === quoteId && item.status === "pending");
  if (!po) {
    return res.status(404).json({ success: false, message: "No pending purchase order found for this quote." });
  }

  const before = { ...po };
  po.status = "rejected";
  po.rejection_reason = req.body.reason;
  po.rejected_by = actor.id;
  po.rejected_at = new Date().toISOString();

  req.store.audit(req.db, actor, "purchase_order", po.id, "PO_REJECTED", before, po);
  res.json({ success: true, data: po });
};
