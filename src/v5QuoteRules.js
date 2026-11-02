export const PRICING_BASES = Object.freeze(["hourly", "minimum_hours", "fixed", "material"]);

const cents = (value, label) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`${label} must be a non-negative number.`);
  const result = Math.round(numeric * 100);
  if (Math.abs(numeric * 100 - result) > 1e-7) throw new Error(`${label} may use at most two decimal places.`);
  return result;
};

export function calculateV5QuoteLines(lines) {
  return lines.map((line) => {
    if (!PRICING_BASES.includes(line.pricing_basis)) throw new Error("Unsupported pricing basis.");
    if (line.pricing_basis === "fixed" && line.completion_rule !== "supervisor_confirmed_timesheet") {
      throw new Error("A fixed line requires the supervisor_confirmed_timesheet completion rule.");
    }
    if (line.pricing_basis !== "fixed" && line.completion_rule != null) {
      throw new Error("A completion rule is supported only for a fixed line.");
    }
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be greater than zero.");
    const unitPriceCents = cents(line.unit_price, "Unit price");
    const lineTotalCents = Math.round(quantity * unitPriceCents);
    if (Math.abs(quantity * unitPriceCents - lineTotalCents) > 1e-7) throw new Error("Quantity produces a fraction of a cent.");
    return {
      catalog_item_id: line.catalog_item_id || null,
      description: line.description,
      quantity,
      unit_price: unitPriceCents / 100,
      line_total: lineTotalCents / 100,
      unit_price_cents: unitPriceCents,
      line_total_cents: lineTotalCents,
      currency: "USD",
      tax_status: "unconfigured",
      pricing_basis: line.pricing_basis,
      planned_hours: line.planned_hours ?? null,
      completion_rule: line.completion_rule ?? null,
      materials_included: Boolean(line.materials_included)
    };
  });
}

export const quoteTotal = (lines) => lines.reduce((total, line) => {
  const lineTotalCents = Number.isInteger(line.line_total_cents)
    ? line.line_total_cents
    : Math.round(Number(line.line_total) * 100);
  return total + lineTotalCents;
}, 0) / 100;
