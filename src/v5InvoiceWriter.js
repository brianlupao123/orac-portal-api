import { createHash } from "node:crypto";
import { isV5Verified, v5SignatureState, v5VerifiedHoursByQuoteLine } from "./v5SignatureEvidence.js";
import { v5InvoiceWriterRefusal } from "./v5InvoiceWriterPolicy.js";

const MICRO_UNITS = 1000000;
const active = (record) => String(record?.status || "").toLowerCase() !== "voided";
const clone = (value) => JSON.parse(JSON.stringify(value));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const v5InvoiceCandidateHash = (candidate) => createHash("sha256").update(stable(candidate)).digest("hex");

export function toMicroUnits(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const micro = Math.round(value * MICRO_UNITS);
  return Math.abs(value * MICRO_UNITS - micro) < 1e-7 ? micro : null;
}

export const fromMicroUnits = (value) => Number((Number(value) / MICRO_UNITS).toFixed(6));

const moneyCents = (value) => {
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return Number.isFinite(amount) && Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
};

function add(blockers, code, message, details = {}) {
  blockers.push({ code, message, ...details });
}

function currentOriginalAllocation(db, usageId) {
  return (db.v5_material_allocations || []).find((item) => item.material_usage_id === usageId) || null;
}

function amendmentAllocations(db, sourceType, sourceId) {
  return (db.v5_amendment_evidence_allocations || [])
    .filter((item) => item.source_type === sourceType && item.source_id === sourceId)
    .map((item) => {
      const remap = (db.v5_allocation_remaps || []).find((candidate) => candidate.allocation_id === item.id);
      return remap ? { ...item, amendment_quote_line_id: remap.replacement_amendment_quote_line_id } : item;
    });
}

function unremappedSupersededAllocations(db, dispatchId) {
  const supersededQuoteIds = new Set((db.v5_amendment_supersessions || [])
    .filter((item) => item.dispatch_card_id === dispatchId)
    .map((item) => item.superseded_amendment_quote_id));
  const remappedIds = new Set((db.v5_allocation_remaps || []).map((item) => item.allocation_id));
  return (db.v5_amendment_evidence_allocations || []).filter((item) =>
    item.dispatch_card_id === dispatchId && supersededQuoteIds.has(item.amendment_quote_id) && !remappedIds.has(item.id)
  );
}

function consumedMicroUnits(db, sourceType, sourceId) {
  return (db.v5_invoice_source_consumption || [])
    .filter((item) => item.source_type === sourceType && item.source_id === sourceId)
    .reduce((total, item) => total + Number(item.quantity_micro_units || 0), 0);
}

function quoteAndPoForLine(db, line) {
  const quote = (db.quotes || []).find((item) => item.id === line.quotation_id) || null;
  const po = (db.purchase_orders || []).find((item) => item.id === quote?.commercial_acceptance_po_id) || null;
  return { quote, po };
}

function validV5Authority(quote, po) {
  return Boolean(
    quote?.v5_commercial_workflow && quote.currency === "USD" && quote.tax_status === "unconfigured" &&
    quote.commercial_acceptance_status === "po_verified" && quote.commercial_acceptance_po_id === po?.id &&
    po?.status === "verified" && moneyCents(po.po_amount) !== null && moneyCents(po.po_amount) > 0
  );
}

function knownDispatchAmendments(db, dispatchId) {
  return (db.v5_amendment_dispatch_links || []).filter((link) => link.dispatch_card_id === dispatchId);
}

const quoteRootId = (quote) => quote?.root_quote_id || quote?.id || null;

function validAmendmentLink(db, dispatchId, quoteId) {
  const link = knownDispatchAmendments(db, dispatchId).find((item) => item.amendment_quote_id === quoteId);
  if (!link) return null;
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  const dispatchQuote = (db.quotes || []).find((item) => item.id === dispatch?.quotation_id);
  const quote = (db.quotes || []).find((item) => item.id === quoteId);
  const po = (db.purchase_orders || []).find((item) => item.id === link.amendment_purchase_order_id);
  if (!dispatchQuote || quoteRootId(dispatchQuote) !== quoteRootId(quote) ||
    (link.dispatch_quote_id && link.dispatch_quote_id !== dispatchQuote.id) ||
    !quote?.revision_of_quote_id || !quote?.v5_amendment_approval || quote.commercial_acceptance_status !== "po_verified" ||
    quote.commercial_acceptance_po_id !== po?.id || quote.v5_amendment_approval.approved_po_id !== po?.id || !validV5Authority(quote, po)) return null;
  return { link, quote, po };
}

function sourceFor(db, dispatchId, type, id) {
  const collection = type === "field_worksheet" ? db.field_worksheets : db.material_usage;
  return (collection || []).find((item) => item.id === id && item.dispatch_card_id === dispatchId) || null;
}

function sourceCapacityMicro(db, source, sourceType) {
  return toMicroUnits(sourceType === "field_worksheet" ? Number(source.hours) : Number(source.quantity_used));
}

function v5InvoiceDirtyEvidence(db, dispatchId) {
  const blockers = [];
  const verified = v5VerifiedHoursByQuoteLine(db, dispatchId);
  if (verified.unverified.hours > 0) add(blockers, "UNVERIFIED_TIMESHEET_EVIDENCE", "Every Timesheet on the dispatch must be current and V5-verified before issue.", { source_ids: verified.unverified.source_ids });
  for (const source of db.material_usage || []) {
    if (source.dispatch_card_id !== dispatchId) continue;
    const original = currentOriginalAllocation(db, source.id);
    const amendments = amendmentAllocations(db, "material_usage", source.id);
    if (!original && amendments.length === 0) add(blockers, "UNALLOCATED_MATERIAL_USAGE", "Every material usage must be allocated or reconciled before issue.", { material_usage_id: source.id });
  }
  for (const allocation of unremappedSupersededAllocations(db, dispatchId)) {
    add(blockers, "V5_SUPERSEDED_ALLOCATION_REMAP_REQUIRED", "A superseded amendment has an unconsumed allocation that must be remapped before issue.", { allocation_id: allocation.id });
  }
  return blockers;
}

function priorPoCents(db, poId) {
  const legacy = (db.invoices || []).filter((invoice) => invoice.purchase_order_id === poId && active(invoice))
    .reduce((total, invoice) => total + (moneyCents(invoice.total_amount) ?? 0), 0);
  const v5 = (db.v5_invoices || []).filter((invoice) => invoice.purchase_order_id === poId && active(invoice))
    .reduce((total, invoice) => total + Number(invoice.grand_total_cents || 0), 0);
  return legacy + v5;
}

function requestedSourceTotalMicro(requestedSources) {
  return requestedSources.reduce((total, source) => total + toMicroUnits(source.quantity), 0);
}

export function v5InvoiceLineEvidence(db, dispatchId, quoteLineId) {
  const sheets = (db.field_worksheets || [])
    .filter((sheet) => sheet.dispatch_card_id === dispatchId && sheet.quote_line_id === quoteLineId && !sheet.superseded_by && isV5Verified(db, sheet))
    .map((sheet) => ({ id: sheet.id, hours_micro_units: toMicroUnits(Number(sheet.hours)), evidence_hash: v5SignatureState(db, sheet).current_hash }));
  return {
    sheets,
    total_micro_units: sheets.reduce((total, sheet) => total + (sheet.hours_micro_units || 0), 0),
    evidence_hash: v5InvoiceCandidateHash({ dispatch_card_id: dispatchId, quote_line_id: quoteLineId, sheets })
  };
}

function hasCurrentCompletion(db, dispatchId, lineId, evidenceHash) {
  return (db.v5_line_completions || []).some((item) =>
    item.dispatch_card_id === dispatchId && item.quote_line_id === lineId && item.evidence_hash === evidenceHash
  );
}

function lineAlreadyIssued(db, lineId) {
  return (db.v5_invoice_lines || []).some((item) => item.quote_line_id === lineId);
}

function issuedLineMicroUnits(db, lineId) {
  return (db.v5_invoice_lines || [])
    .filter((item) => item.quote_line_id === lineId)
    .reduce((total, item) => total + Number(item.quantity_micro_units || 0), 0);
}

function sourceAvailabilityMicro(db, line, sourceType, source, isOriginal) {
  const capacity = sourceCapacityMicro(db, source, sourceType);
  if (capacity === null) return 0;
  let available = capacity - consumedMicroUnits(db, sourceType, source.id);
  const claims = amendmentAllocations(db, sourceType, source.id);
  if (isOriginal) {
    const linked = sourceType === "field_worksheet"
      ? source.quote_line_id === line.id
      : currentOriginalAllocation(db, source.id)?.quote_line_id === line.id;
    if (!linked) return 0;
    available -= claims.reduce((total, item) => total + (toMicroUnits(Number(item.quantity)) ?? 0), 0);
  } else {
    const claimed = claims
      .filter((item) => item.amendment_quote_line_id === line.id)
      .reduce((total, item) => total + (toMicroUnits(Number(item.quantity)) ?? 0), 0);
    available = Math.min(available, claimed);
  }
  return Math.max(0, available);
}

// Read-only selector data for the Finance/Admin V5 writer surface. Draft
// creation and issue still rebuild the candidate under current authority.
export function v5InvoiceDraftWorkspace(db, dispatchId, { storeDriver } = {}) {
  const policyRefusal = v5InvoiceWriterRefusal({ storeDriver });
  if (policyRefusal) return { error: { status: 409, ...policyRefusal } };
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  if (!dispatch) return { error: { status: 404, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." } };
  const originalQuote = (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  const originalPo = (db.purchase_orders || []).find((item) => item.id === originalQuote?.commercial_acceptance_po_id);
  const blockers = [];
  if (!validV5Authority(originalQuote, originalPo) || dispatch.purchase_order_id !== originalPo?.id) {
    add(blockers, "V5_ORIGINAL_AUTHORITY_INVALID", "The dispatch needs an accepted V5 quote and matching verified purchase order.");
  }
  if ((db.invoices || []).some((invoice) => invoice.dispatch_card_id === dispatch.id && active(invoice))) {
    add(blockers, "V5_LEGACY_INVOICE_EXISTS", "A non-voided legacy invoice blocks the V5 writer for this dispatch.");
  }
  blockers.push(...v5InvoiceDirtyEvidence(db, dispatch.id));
  const lines = (db.quote_lines || []).flatMap((line) => {
    const { quote, po } = quoteAndPoForLine(db, line);
    const isOriginal = quote?.id === originalQuote?.id;
    const amendment = isOriginal ? null : validAmendmentLink(db, dispatch.id, quote?.id);
    if (!isOriginal && !amendment) return [];
    const sourceType = line.pricing_basis === "hourly" ? "field_worksheet" : line.pricing_basis === "material" ? "material_usage" : null;
    const sources = sourceType === "field_worksheet"
      ? (db.field_worksheets || []).filter((item) => item.dispatch_card_id === dispatch.id && !item.superseded_by && isV5Verified(db, item))
      : sourceType === "material_usage" ? (db.material_usage || []).filter((item) => item.dispatch_card_id === dispatch.id) : [];
    const availableSources = sources.map((source) => {
      const availableMicro = sourceAvailabilityMicro(db, line, sourceType, source, isOriginal);
      return {
        source_type: sourceType, source_id: source.id,
        available_quantity: fromMicroUnits(availableMicro), available_micro_units: availableMicro,
        unit: sourceType === "field_worksheet" ? "hours" : "quantity",
        evidence_status: sourceType === "field_worksheet" ? "v5_verified" : "allocated_material",
        selectable: availableMicro > 0
      };
    }).filter((source) => source.selectable);
    const evidence = ["minimum_hours", "fixed"].includes(line.pricing_basis)
      ? v5InvoiceLineEvidence(db, dispatch.id, line.id) : null;
    return [{
      quote_line_id: line.id, quotation_id: quote.id, purchase_order_id: po?.id || null,
      description: line.description || line.id, pricing_basis: line.pricing_basis || null,
      authority_valid: validV5Authority(quote, po),
      source_rule: sourceType ? "exact_evidence_portions" : "supervisor_completion_required",
      remaining_quantity: fromMicroUnits(Math.max(0, (toMicroUnits(Number(line.quantity)) ?? 0) - issuedLineMicroUnits(db, line.id))),
      already_issued: lineAlreadyIssued(db, line.id), available_sources: availableSources,
      completion_current: evidence ? hasCurrentCompletion(db, dispatch.id, line.id, evidence.evidence_hash) : null,
      completion_evidence_hash: evidence?.evidence_hash || null
    }];
  });
  return { data: {
    dispatch_card_id: dispatch.id, quotation_id: originalQuote?.id || null,
    currency: "USD", tax_status: "unconfigured", blockers, lines
  } };
}

// Builds, but never persists, a candidate. Controllers must use this function
// both at draft creation and again under the persistence lock before issue.
export function buildV5InvoiceCandidate(db, dispatchId, requestedLines, { storeDriver } = {}) {
  const policyRefusal = v5InvoiceWriterRefusal({ storeDriver });
  if (policyRefusal) return { error: { status: 409, ...policyRefusal } };

  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  if (!dispatch) return { error: { status: 404, code: "DISPATCH_NOT_FOUND", message: "Dispatch card not found." } };
  const originalQuote = (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  const originalPo = (db.purchase_orders || []).find((item) => item.id === originalQuote?.commercial_acceptance_po_id);
  const blockers = [];
  if (!validV5Authority(originalQuote, originalPo) || dispatch.purchase_order_id !== originalPo?.id) {
    add(blockers, "V5_ORIGINAL_AUTHORITY_INVALID", "The dispatch needs an accepted V5 quote and matching verified purchase order.");
  }
  if ((db.invoices || []).some((invoice) => invoice.dispatch_card_id === dispatch.id && active(invoice))) {
    add(blockers, "V5_LEGACY_INVOICE_EXISTS", "A non-voided legacy invoice blocks the V5 writer for this dispatch.");
  }
  blockers.push(...v5InvoiceDirtyEvidence(db, dispatch.id));

  const seenLines = new Set();
  const candidateLines = [];
  const poCharges = new Map();
  for (const requested of requestedLines || []) {
    if (seenLines.has(requested.quote_line_id)) {
      add(blockers, "DUPLICATE_QUOTE_LINE", "Each quote line may appear only once in a draft.", { quote_line_id: requested.quote_line_id });
      continue;
    }
    seenLines.add(requested.quote_line_id);
    const line = (db.quote_lines || []).find((item) => item.id === requested.quote_line_id);
    if (!line) {
      add(blockers, "QUOTE_LINE_NOT_FOUND", "A requested quote line was not found.", { quote_line_id: requested.quote_line_id });
      continue;
    }
    const { quote, po } = quoteAndPoForLine(db, line);
    const isOriginal = quote?.id === originalQuote?.id;
    const amendment = isOriginal ? null : validAmendmentLink(db, dispatch.id, quote?.id);
    if (!isOriginal && !amendment) {
      add(blockers, "V5_AMENDMENT_AUTHORITY_INVALID", "A requested amendment line needs a currently approved, linked amendment and its verified purchase order.", { quote_line_id: line.id });
      continue;
    }
    if (!validV5Authority(quote, po)) {
      add(blockers, "V5_QUOTE_AUTHORITY_INVALID", "A requested V5 quote line has no valid USD, unconfigured-tax authority.", { quote_line_id: line.id });
      continue;
    }
    if (!Number.isInteger(line.unit_price_cents) || line.unit_price_cents < 0 || line.currency !== "USD") {
      add(blockers, "V5_LINE_SNAPSHOT_INVALID", "A requested quote line has an invalid USD price snapshot.", { quote_line_id: line.id });
      continue;
    }
    if (line.pricing_basis === "fixed" && !isOriginal) {
      add(blockers, "V5_AMENDMENT_FIXED_LINE_UNSUPPORTED", "Amendment fixed lines cannot be billed in V1 because evidence cannot be mapped safely.", { quote_line_id: line.id });
      continue;
    }
    const sources = requested.sources || [];
    if (["minimum_hours", "fixed"].includes(line.pricing_basis)) {
      if (sources.length) {
        add(blockers, "V5_LINE_SOURCES_NOT_ALLOWED", "Minimum-hours and fixed lines are indivisible and do not accept requested source portions.", { quote_line_id: line.id });
        continue;
      }
      const evidence = v5InvoiceLineEvidence(db, dispatch.id, line.id);
      if (evidence.total_micro_units <= 0 || !hasCurrentCompletion(db, dispatch.id, line.id, evidence.evidence_hash)) {
        add(blockers, "V5_LINE_COMPLETION_REQUIRED", "Minimum-hours and fixed lines require a Supervisor completion record bound to current verified evidence.", { quote_line_id: line.id });
        continue;
      }
      if (lineAlreadyIssued(db, line.id)) {
        add(blockers, "V5_INDIVISIBLE_LINE_ALREADY_BILLED", "A minimum-hours or fixed line is billed once only.", { quote_line_id: line.id });
        continue;
      }
      const quotedMicro = toMicroUnits(Number(line.quantity));
      const plannedMicro = toMicroUnits(Number(line.planned_hours));
      let quantityMicro = quotedMicro;
      if (line.pricing_basis === "minimum_hours") {
        if (plannedMicro === null || plannedMicro < quotedMicro || evidence.total_micro_units > plannedMicro) {
          add(blockers, "V5_LINE_CEILING_EXCEEDED", "The minimum-hours completion exceeds its recorded planned-hours ceiling.", { quote_line_id: line.id });
          continue;
        }
        quantityMicro = Math.max(quotedMicro, evidence.total_micro_units);
      }
      if (quotedMicro === null) {
        add(blockers, "V5_LINE_SNAPSHOT_INVALID", "A completed line has an invalid accepted quantity.", { quote_line_id: line.id });
        continue;
      }
      const rawCents = quantityMicro * line.unit_price_cents;
      if (rawCents % MICRO_UNITS !== 0) {
        add(blockers, "V5_LINE_ROUNDING_INVALID", "The completed line would create a fraction of a USD cent.", { quote_line_id: line.id });
        continue;
      }
      const preTaxTotalCents = rawCents / MICRO_UNITS;
      poCharges.set(po.id, (poCharges.get(po.id) || 0) + preTaxTotalCents);
      candidateLines.push({
        quote_line_id: line.id, quotation_id: quote.id, purchase_order_id: po.id, pricing_basis: line.pricing_basis,
        description: line.description, quantity_micro_units: quantityMicro, quantity: fromMicroUnits(quantityMicro),
        unit_price_cents: line.unit_price_cents, pre_tax_total_cents: preTaxTotalCents, sources: [],
        completion_evidence_hash: evidence.evidence_hash
      });
      continue;
    }
    if (!sources.length) {
      add(blockers, "V5_LINE_SOURCES_REQUIRED", "Hourly and material lines require exact evidence source portions.", { quote_line_id: line.id });
      continue;
    }
    const sourceIds = new Set();
    let sourceError = false;
    for (const requestedSource of sources) {
      const sourceKey = `${requestedSource.source_type}:${requestedSource.source_id}`;
      if (sourceIds.has(sourceKey)) {
        add(blockers, "DUPLICATE_EVIDENCE_SOURCE", "An evidence source may appear once per quote line.", { quote_line_id: line.id, source_id: requestedSource.source_id });
        sourceError = true;
        continue;
      }
      sourceIds.add(sourceKey);
      const source = sourceFor(db, dispatch.id, requestedSource.source_type, requestedSource.source_id);
      const requestedMicro = toMicroUnits(requestedSource.quantity);
      const capacity = source && sourceCapacityMicro(db, source, requestedSource.source_type);
      if (!source || requestedMicro === null || capacity === null) {
        add(blockers, "V5_EVIDENCE_SOURCE_INVALID", "An evidence source is missing or has an invalid quantity.", { quote_line_id: line.id, source_id: requestedSource.source_id });
        sourceError = true;
        continue;
      }
      if (requestedSource.source_type === "field_worksheet" && (!isV5Verified(db, source) || line.pricing_basis !== "hourly")) {
        add(blockers, "V5_LABOUR_EVIDENCE_INELIGIBLE", "Only current V5-verified Timesheets can cover an hourly line.", { quote_line_id: line.id, source_id: source.id });
        sourceError = true;
        continue;
      }
      if (requestedSource.source_type === "material_usage" && line.pricing_basis !== "material") {
        add(blockers, "V5_MATERIAL_EVIDENCE_INELIGIBLE", "Material usage can cover a material line only.", { quote_line_id: line.id, source_id: source.id });
        sourceError = true;
        continue;
      }
      const alreadyConsumed = consumedMicroUnits(db, requestedSource.source_type, source.id);
      const amendmentClaims = amendmentAllocations(db, requestedSource.source_type, source.id)
        .reduce((total, item) => total + (toMicroUnits(Number(item.quantity)) ?? 0), 0);
      let available = capacity - alreadyConsumed;
      if (isOriginal) {
        if (requestedSource.source_type === "field_worksheet" && source.quote_line_id !== line.id) available = -1;
        if (requestedSource.source_type === "material_usage" && currentOriginalAllocation(db, source.id)?.quote_line_id !== line.id) available = -1;
        available -= amendmentClaims;
      } else {
        const claim = amendmentAllocations(db, requestedSource.source_type, source.id)
          .filter((item) => item.amendment_quote_line_id === line.id)
          .reduce((total, item) => total + (toMicroUnits(Number(item.quantity)) ?? 0), 0);
        available = Math.min(available, claim);
      }
      if (requestedMicro > available) {
        add(blockers, "V5_EVIDENCE_SOURCE_EXHAUSTED", "The requested source portion is not available to this quote line.", { quote_line_id: line.id, source_id: source.id });
        sourceError = true;
      }
    }
    if (sourceError) continue;
    const quantityMicro = requestedSourceTotalMicro(sources);
    const quotedMicro = toMicroUnits(Number(line.quantity));
    const remainingLineMicro = quotedMicro === null ? null : quotedMicro - issuedLineMicroUnits(db, line.id);
    if (remainingLineMicro === null || remainingLineMicro < 0 || quantityMicro > remainingLineMicro) {
      add(blockers, "V5_LINE_CEILING_EXCEEDED", "The requested quantity exceeds the remaining accepted quote-line ceiling.", { quote_line_id: line.id });
      continue;
    }
    const rawCents = quantityMicro * line.unit_price_cents;
    if (rawCents % MICRO_UNITS !== 0) {
      add(blockers, "V5_LINE_ROUNDING_INVALID", "The requested quantity would create a fraction of a USD cent.", { quote_line_id: line.id });
      continue;
    }
    const preTaxTotalCents = rawCents / MICRO_UNITS;
    poCharges.set(po.id, (poCharges.get(po.id) || 0) + preTaxTotalCents);
    candidateLines.push({
      quote_line_id: line.id,
      quotation_id: quote.id,
      purchase_order_id: po.id,
      pricing_basis: line.pricing_basis,
      description: line.description,
      quantity_micro_units: quantityMicro,
      quantity: fromMicroUnits(quantityMicro),
      unit_price_cents: line.unit_price_cents,
      pre_tax_total_cents: preTaxTotalCents,
      sources: sources.map((source) => ({ ...source, quantity_micro_units: toMicroUnits(source.quantity) }))
    });
  }
  if (!candidateLines.length) add(blockers, "NO_BILLABLE_V5_EVIDENCE", "The request contains no billable V5 evidence.");
  for (const [poId, requestCents] of poCharges) {
    const po = (db.purchase_orders || []).find((item) => item.id === poId);
    const ceiling = moneyCents(po?.po_amount);
    if (ceiling === null || priorPoCents(db, poId) + requestCents > ceiling) {
      add(blockers, "INVOICE_EXCEEDS_PO_REMAINING", "The request exceeds the remaining verified purchase-order ceiling.", { purchase_order_id: poId });
    }
  }
  if (blockers.length) return { error: { status: 409, code: blockers[0].code, message: blockers[0].message, blockers } };
  const candidate = {
    version: 1,
    dispatch_card_id: dispatch.id,
    currency: "USD",
    tax_status: "unconfigured",
    tax_total_cents: 0,
    pre_tax_total_cents: candidateLines.reduce((total, line) => total + line.pre_tax_total_cents, 0),
    grand_total_cents: candidateLines.reduce((total, line) => total + line.pre_tax_total_cents, 0),
    lines: candidateLines
  };
  return { data: { ...clone(candidate), candidate_hash: v5InvoiceCandidateHash(candidate) } };
}

export function nextV5InvoiceNumber(db, now = new Date()) {
  const harareYear = new Intl.DateTimeFormat("en", { timeZone: "Africa/Harare", year: "numeric" }).format(now);
  const lastSequence = (db.v5_invoice_number_ledger || [])
    .filter((item) => item.year === harareYear)
    .reduce((highest, item) => Math.max(highest, Number(item.last_sequence || 0)), 0);
  const sequence = lastSequence + 1;
  return { year: harareYear, sequence, invoice_number: `V5-INV-${harareYear}-${String(sequence).padStart(5, "0")}` };
}
