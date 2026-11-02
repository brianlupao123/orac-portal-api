import { allocatedMaterialsByQuoteLine } from "./v5CommercialWorkflow.js";
import { v5VerifiedHoursByQuoteLine } from "./v5SignatureEvidence.js";

const moneyToCents = (value) => {
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return Number.isFinite(amount) && Math.abs(amount * 100 - cents) < 1e-7 ? cents : null;
};

const activeInvoicesForDispatch = (db, dispatchId) => (db.invoices || []).filter((invoice) =>
  invoice.dispatch_card_id === dispatchId && String(invoice.status || "").toLowerCase() !== "voided"
);

const addBlocker = (blockers, code, message, details = {}) => blockers.push({ code, message, ...details });

const linkedApprovedAmendments = (db, dispatchId) => (db.v5_amendment_dispatch_links || [])
  .filter((link) => link.dispatch_card_id === dispatchId)
  .map((link) => {
    const quote = (db.quotes || []).find((item) => item.id === link.amendment_quote_id);
    const po = (db.purchase_orders || []).find((item) => item.id === link.amendment_purchase_order_id);
    return {
      amendment_quote_id: link.amendment_quote_id,
      amendment_quote_number: quote?.quote_number || link.amendment_quote_id,
      amendment_purchase_order_id: link.amendment_purchase_order_id,
      amendment_purchase_order_reference: po?.po_reference || null,
      linked_at: link.linked_at,
      approved_at: link.amendment_approval_at,
      valid: Boolean(quote?.v5_amendment_approval && quote.commercial_acceptance_status === "po_verified" && po?.status === "verified")
    };
  });

// This deliberately produces no invoice record. It is the deterministic
// evidence-and-snapshot calculation that a later, separately approved writer
// must consume. Historical invoices are not re-priced or folded into V5.
export function buildV5InvoicePreview(db, dispatchId) {
  const dispatch = (db.dispatch_cards || []).find((item) => item.id === dispatchId);
  if (!dispatch) return { error: { status: 404, message: "Dispatch card not found." } };
  const quote = (db.quotes || []).find((item) => item.id === dispatch.quotation_id);
  if (!quote?.v5_commercial_workflow) {
    return { error: { status: 409, code: "V5_QUOTE_REQUIRED", message: "This dispatch is not linked to a V5 quotation revision." } };
  }

  const blockers = [];
  if (quote.currency !== "USD" || quote.tax_status !== "unconfigured") {
    addBlocker(blockers, "V5_QUOTE_SNAPSHOT_INVALID", "The V5 quotation must retain its USD, unconfigured-tax snapshot.");
  }
  if (quote.commercial_acceptance_status !== "po_verified" || !quote.commercial_acceptance_po_id) {
    addBlocker(blockers, "V5_QUOTE_NOT_ACCEPTED", "The V5 quotation is not accepted by a verified purchase order.");
  }

  const po = (db.purchase_orders || []).find((item) => item.id === quote.commercial_acceptance_po_id);
  const poCents = moneyToCents(po?.po_amount);
  if (!po || po.status !== "verified" || !String(po.po_reference || "").trim() || poCents === null || poCents <= 0) {
    addBlocker(blockers, "VERIFIED_PO_REQUIRED", "A linked verified purchase order with a positive amount is required.");
  }
  if (dispatch.purchase_order_id && po && dispatch.purchase_order_id !== po.id) {
    addBlocker(blockers, "DISPATCH_PO_MISMATCH", "The dispatch does not point to the accepted quotation's verified purchase order.");
  }
  if (activeInvoicesForDispatch(db, dispatch.id).length) {
    addBlocker(blockers, "V5_INVOICE_HISTORY_REVIEW_REQUIRED", "This dispatch already has a non-voided invoice and needs controlled migration review before V5 billing.");
  }
  const amendments = linkedApprovedAmendments(db, dispatch.id);
  if (amendments.length) {
    addBlocker(blockers, "V5_AMENDMENT_COVERAGE_NOT_IMPLEMENTED", "Approved amendment links are recorded, but their evidence coverage is not yet included in the V5 invoice preview.", { amendment_quote_ids: amendments.map((item) => item.amendment_quote_id) });
  }

  const verifiedHours = v5VerifiedHoursByQuoteLine(db, dispatch.id);
  const materials = allocatedMaterialsByQuoteLine(db, dispatch.id);
  if (verifiedHours.unmapped.hours > 0) {
    addBlocker(blockers, "UNMAPPED_VERIFIED_HOURS", "Verified Timesheet hours are not linked to an accepted quotation line.", verifiedHours.unmapped);
  }
  if (materials.unallocated.length) {
    addBlocker(blockers, "UNALLOCATED_MATERIAL_USAGE", "Material usage needs a controlled allocation or an amendment before pricing.", { material_usage_ids: materials.unallocated.map((item) => item.material_usage_id) });
  }

  const lines = [];
  for (const quoteLine of (db.quote_lines || []).filter((item) => item.quotation_id === quote.id)) {
    const unitPriceCents = Number.isInteger(quoteLine.unit_price_cents) ? quoteLine.unit_price_cents : null;
    const quotedQuantity = Number(quoteLine.quantity);
    if (!Number.isFinite(quotedQuantity) || quotedQuantity <= 0 || unitPriceCents === null || unitPriceCents < 0 || quoteLine.currency !== "USD") {
      addBlocker(blockers, "QUOTE_LINE_SNAPSHOT_INVALID", "A V5 quote line has an invalid USD price snapshot.", { quote_line_id: quoteLine.id });
      continue;
    }

    const hours = verifiedHours.by_quote_line[quoteLine.id] || { hours: 0, source_ids: [] };
    const material = materials.by_quote_line[quoteLine.id] || { quantity: 0, source_material_usage_ids: [] };
    let quantityToBill = 0;
    let sourceIds = [];
    let basisBlock = null;

    if (quoteLine.pricing_basis === "hourly") {
      quantityToBill = hours.hours;
      sourceIds = hours.source_ids;
      if (quantityToBill > quotedQuantity) basisBlock = "Verified hours exceed the accepted hourly quantity and require an amendment.";
    } else if (quoteLine.pricing_basis === "minimum_hours") {
      if (!Number.isFinite(Number(quoteLine.planned_hours)) || Number(quoteLine.planned_hours) < quotedQuantity) {
        basisBlock = "A minimum-hours line needs a planned-hours ceiling at least as large as its quoted minimum.";
      } else if (hours.hours > Number(quoteLine.planned_hours)) {
        basisBlock = "Verified hours exceed the accepted minimum-hours ceiling and require an amendment.";
      } else if (hours.hours > 0) {
        quantityToBill = Math.max(quotedQuantity, hours.hours);
        sourceIds = hours.source_ids;
      }
    } else if (quoteLine.pricing_basis === "material") {
      quantityToBill = material.quantity;
      sourceIds = material.source_material_usage_ids;
      if (quantityToBill > quotedQuantity) basisBlock = "Allocated material quantity exceeds the accepted quantity and requires an amendment.";
    } else if (quoteLine.pricing_basis === "fixed") {
      if (quoteLine.completion_rule !== "supervisor_confirmed_timesheet") {
        basisBlock = "A fixed line needs a recorded completion rule before the approved evidence can be priced.";
      } else if (hours.hours > 0) {
        quantityToBill = quotedQuantity;
        sourceIds = hours.source_ids;
      }
    } else {
      basisBlock = "The quote line has an unsupported pricing basis.";
    }

    if (basisBlock) {
      addBlocker(blockers, "V5_LINE_AMENDMENT_OR_COMPLETION_REQUIRED", basisBlock, { quote_line_id: quoteLine.id });
      continue;
    }
    if (quantityToBill <= 0) continue; // Partial invoicing: untouched lines remain for a later preview.

    const preTaxTotalCents = Math.round(quantityToBill * unitPriceCents);
    if (Math.abs(quantityToBill * unitPriceCents - preTaxTotalCents) > 1e-7) {
      addBlocker(blockers, "V5_LINE_ROUNDING_INVALID", "The V5 line quantity produces a fraction of a cent.", { quote_line_id: quoteLine.id });
      continue;
    }
    lines.push({
      quote_line_id: quoteLine.id,
      description: quoteLine.description,
      pricing_basis: quoteLine.pricing_basis,
      quoted_quantity: quotedQuantity,
      quantity_to_bill: quantityToBill,
      unit_price_cents: unitPriceCents,
      pre_tax_total_cents: preTaxTotalCents,
      currency: "USD",
      source_evidence_ids: sourceIds
    });
  }

  if (!lines.length) addBlocker(blockers, "NO_BILLABLE_V5_EVIDENCE", "No accepted V5 quote line has billable verified evidence.");
  const preTaxTotalCents = lines.reduce((total, line) => total + line.pre_tax_total_cents, 0);
  const priorPoCents = (db.invoices || [])
    .filter((invoice) => invoice.purchase_order_id === po?.id && String(invoice.status || "").toLowerCase() !== "voided")
    .reduce((total, invoice) => total + (moneyToCents(invoice.total_amount) ?? 0), 0);
  if (poCents !== null && priorPoCents + preTaxTotalCents > poCents) {
    addBlocker(blockers, "INVOICE_EXCEEDS_PO_REMAINING", "The preview exceeds the remaining verified PO amount and needs an approved amendment.");
  }

  return {
    data: {
      preview_only: true,
      dispatch_card_id: dispatch.id,
      quotation_id: quote.id,
      quotation_number: quote.quote_number || quote.id,
      purchase_order_id: po?.id || null,
      purchase_order_reference: po?.po_reference || null,
      currency: "USD",
      tax_status: "unconfigured",
      tax_total_cents: 0,
      pre_tax_total_cents: preTaxTotalCents,
      grand_total_cents: preTaxTotalCents,
      purchase_order_amount_cents: poCents,
      remaining_purchase_order_cents: poCents === null ? null : poCents - priorPoCents,
      lines,
      verified_timesheet_evidence: { unmapped: verifiedHours.unmapped, unverified: verifiedHours.unverified },
      unallocated_material_usage: materials.unallocated,
      linked_approved_amendments: amendments,
      ready_to_create_in_future: blockers.length === 0,
      blockers
    }
  };
}
