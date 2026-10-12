import assert from "node:assert/strict";
import test from "node:test";
import { calculateV5QuoteLines, quoteTotal } from "../src/v5QuoteRules.js";

test("V5 quotation lines preserve pricing basis and calculate to cents", () => {
  const lines = calculateV5QuoteLines([
    { description: "Field labour", quantity: 48, unit_price: 10, pricing_basis: "hourly", planned_hours: 48 },
    { description: "Minimum callout", quantity: 1, unit_price: 315, pricing_basis: "minimum_hours" }
  ]);
  assert.equal(lines[0].line_total, 480);
  assert.equal(lines[1].line_total, 315);
  assert.equal(quoteTotal(lines), 795);
});

test("V5 quotation lines reject unsupported basis and fractions of a cent", () => {
  assert.throws(() => calculateV5QuoteLines([{ description: "Bad", quantity: 1, unit_price: 10, pricing_basis: "other" }]));
  assert.throws(() => calculateV5QuoteLines([{ description: "Bad", quantity: 0.333, unit_price: 0.01, pricing_basis: "fixed" }]));
});
