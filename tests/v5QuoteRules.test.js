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
  assert.equal(lines[0].unit_price_cents, 1000);
  assert.equal(lines[0].line_total_cents, 48000);
  assert.equal(lines[0].currency, "USD");
  assert.equal(lines[0].tax_status, "unconfigured");
});

test("V5 quotation lines support a rate-free material billing basis", () => {
  const [line] = calculateV5QuoteLines([
    { description: "Ceramic tiles", quantity: 3, unit_price: 95, pricing_basis: "material" }
  ]);
  assert.equal(line.pricing_basis, "material");
  assert.equal(line.line_total_cents, 28500);
});

test("a fixed V5 line snapshots its explicit Supervisor-confirmed completion rule", () => {
  const [line] = calculateV5QuoteLines([
    { description: "Fixed inspection", quantity: 1, unit_price: 500, pricing_basis: "fixed", completion_rule: "supervisor_confirmed_timesheet" }
  ]);
  assert.equal(line.completion_rule, "supervisor_confirmed_timesheet");
  assert.throws(() => calculateV5QuoteLines([{ description: "Incomplete", quantity: 1, unit_price: 500, pricing_basis: "fixed" }]));
  assert.throws(() => calculateV5QuoteLines([{ description: "Wrong basis", quantity: 1, unit_price: 500, pricing_basis: "hourly", completion_rule: "supervisor_confirmed_timesheet" }]));
});

test("V5 quotation lines reject unsupported basis and fractions of a cent", () => {
  assert.throws(() => calculateV5QuoteLines([{ description: "Bad", quantity: 1, unit_price: 10, pricing_basis: "other" }]));
  assert.throws(() => calculateV5QuoteLines([{ description: "Bad", quantity: 0.333, unit_price: 0.01, pricing_basis: "fixed" }]));
});
