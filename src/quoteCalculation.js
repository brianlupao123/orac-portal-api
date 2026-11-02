export const APPROVED_UNITS_OF_MEASURE = Object.freeze([
  "hours",
  "days",
  "metres",
  "m2",
  "m²",
  "m3",
  "m³",
  "kg",
  "tonnes",
  "each",
  "lot",
  "set"
]);

export const CANONICAL_UNITS_OF_MEASURE = Object.freeze([
  "hours",
  "days",
  "metres",
  "m²",
  "m³",
  "kg",
  "tonnes",
  "each",
  "lot",
  "set"
]);

export const COST_TYPES = Object.freeze([
  "labour",
  "material",
  "equipment",
  "transport"
]);

export const ITEM_TYPES = Object.freeze([
  "standard",
  "optional",
  "provisional_sum"
]);

export const TAX_STATUSES = Object.freeze([
  "taxable",
  "zero-rated",
  "exempt",
  "unconfigured",
  "provisional"
]);

export const DEFAULT_PROVISIONAL_VAT_RATE = 0.15;
export const PROVISIONAL_VAT_NOTICE = "Provisional — accountant confirmation required";

export function toCents(value, label = "Amount") {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  const result = Math.round(numeric * 100);
  if (Math.abs(numeric * 100 - result) > 1e-7) {
    throw new Error(`${label} may use at most two decimal places.`);
  }
  return result;
}

export function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

export function canonicalUnit(unit) {
  if (!unit) return "each";
  const lower = String(unit).trim().toLowerCase();
  if (lower === "hour" || lower === "hrs" || lower === "hr") return "hours";
  if (lower === "day") return "days";
  if (lower === "metre" || lower === "meter" || lower === "meters") return "metres";
  if (lower === "m2") return "m²";
  if (lower === "m3") return "m³";
  if (lower === "tonne" || lower === "ton" || lower === "tons") return "tonnes";
  return APPROVED_UNITS_OF_MEASURE.includes(lower) ? lower : "each";
}

export function calculateLineTotals(line) {
  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }
  
  let unitPriceCents;
  if (line.unit_price_cents !== undefined && Number.isInteger(line.unit_price_cents)) {
    unitPriceCents = line.unit_price_cents;
  } else {
    unitPriceCents = toCents(line.unit_price ?? 0, "Unit price");
  }

  const lineTotalCents = Math.round(quantity * unitPriceCents);
  if (Math.abs(quantity * unitPriceCents - lineTotalCents) > 1e-7) {
    throw new Error("Quantity produces a fraction of a cent.");
  }

  return {
    quantity,
    unit_price: unitPriceCents / 100,
    unit_price_cents: unitPriceCents,
    line_total: lineTotalCents / 100,
    line_total_cents: lineTotalCents
  };
}

export function calculateQuoteFinancials({
  lines = [],
  discountPercent = 0,
  taxStatus = "provisional",
  appliedTaxRate = null
} = {}) {
  const normalizedDiscountPercent = Number(discountPercent) || 0;
  if (normalizedDiscountPercent < 0 || normalizedDiscountPercent > 100) {
    throw new Error("Discount percent must be between 0 and 100.");
  }

  if (taxStatus && !TAX_STATUSES.includes(taxStatus)) {
    throw new Error(`Invalid tax status: ${taxStatus}`);
  }

  let preTaxTotalCents = 0;
  let provisionalSumCents = 0;
  const processedLines = [];

  for (const rawLine of lines) {
    const totals = calculateLineTotals(rawLine);
    const itemType = rawLine.item_type || "standard";
    const lineObj = {
      ...rawLine,
      ...totals,
      item_type: itemType,
      cost_type: rawLine.cost_type || "material",
      unit_of_measure: canonicalUnit(rawLine.unit_of_measure),
      work_package_id: rawLine.work_package_id || "wp_01"
    };
    processedLines.push(lineObj);

    // Only standard lines contribute to pre_tax_total_cents
    if (itemType === "standard") {
      preTaxTotalCents += totals.line_total_cents;
    } else {
      provisionalSumCents += totals.line_total_cents;
    }
  }

  // Discount
  const discountCents = Math.round(preTaxTotalCents * (normalizedDiscountPercent / 100));
  const netSubtotalCents = Math.max(0, preTaxTotalCents - discountCents);

  // Tax calculation
  let effectiveTaxRate = null;
  let taxTotalCents = 0;

  if (taxStatus === "taxable" || taxStatus === "provisional") {
    effectiveTaxRate = appliedTaxRate != null ? Number(appliedTaxRate) : DEFAULT_PROVISIONAL_VAT_RATE;
    if (effectiveTaxRate < 0 || effectiveTaxRate > 1) {
      throw new Error("Applied tax rate must be between 0 and 1.");
    }
    taxTotalCents = Math.round(netSubtotalCents * effectiveTaxRate);
  } else if (taxStatus === "zero-rated" || taxStatus === "exempt") {
    effectiveTaxRate = 0;
    taxTotalCents = 0;
  } else {
    // unconfigured
    effectiveTaxRate = null;
    taxTotalCents = 0;
  }

  const grandTotalCents = netSubtotalCents + taxTotalCents;

  return {
    lines: processedLines,
    pre_tax_total_cents: preTaxTotalCents,
    pre_tax_total: fromCents(preTaxTotalCents),
    discount_percent: normalizedDiscountPercent,
    discount_cents: discountCents,
    discount_amount: fromCents(discountCents),
    net_subtotal_cents: netSubtotalCents,
    net_subtotal: fromCents(netSubtotalCents),
    tax_status: taxStatus,
    applied_tax_rate: effectiveTaxRate,
    tax_total_cents: taxTotalCents,
    tax_total: fromCents(taxTotalCents),
    grand_total_cents: grandTotalCents,
    total_amount: fromCents(grandTotalCents),
    provisional_sum_cents: provisionalSumCents,
    provisional_sum: fromCents(provisionalSumCents)
  };
}
