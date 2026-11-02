import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_UNITS_OF_MEASURE,
  CANONICAL_UNITS_OF_MEASURE,
  COST_TYPES,
  ITEM_TYPES,
  TAX_STATUSES,
  DEFAULT_PROVISIONAL_VAT_RATE,
  toCents,
  fromCents,
  canonicalUnit,
  calculateLineTotals,
  calculateQuoteFinancials
} from "../src/quoteCalculation.js";
import { normalizeDb } from "../src/store.js";

test("quoteCalculation constants match confirmed business decisions", () => {
  const expectedUnits = ["hours", "days", "metres", "m2", "m²", "m3", "m³", "kg", "tonnes", "each", "lot", "set"];
  for (const u of expectedUnits) {
    assert.ok(APPROVED_UNITS_OF_MEASURE.includes(u), `Unit ${u} should be in approved units list`);
  }
  assert.deepEqual([...COST_TYPES], ["labour", "material", "equipment", "transport"]);
  assert.deepEqual([...TAX_STATUSES], ["taxable", "zero-rated", "exempt", "unconfigured", "provisional"]);
  assert.equal(DEFAULT_PROVISIONAL_VAT_RATE, 0.15);
});

test("canonicalUnit normalizes common abbreviations to standard units", () => {
  assert.equal(canonicalUnit("hour"), "hours");
  assert.equal(canonicalUnit("hrs"), "hours");
  assert.equal(canonicalUnit("hr"), "hours");
  assert.equal(canonicalUnit("day"), "days");
  assert.equal(canonicalUnit("metre"), "metres");
  assert.equal(canonicalUnit("m2"), "m²");
  assert.equal(canonicalUnit("m3"), "m³");
  assert.equal(canonicalUnit("ton"), "tonnes");
  assert.equal(canonicalUnit("each"), "each");
  assert.equal(canonicalUnit("unknown_xyz"), "each");
});

test("calculateLineTotals calculates exact integer cents", () => {
  const res = calculateLineTotals({ quantity: 16, unit_price: 45 });
  assert.equal(res.quantity, 16);
  assert.equal(res.unit_price, 45);
  assert.equal(res.unit_price_cents, 4500);
  assert.equal(res.line_total, 720);
  assert.equal(res.line_total_cents, 72000);
});

test("calculateLineTotals supports fractional quantities without float rounding errors", () => {
  const res = calculateLineTotals({ quantity: 2.5, unit_price: 115 });
  assert.equal(res.unit_price_cents, 11500);
  assert.equal(res.line_total_cents, 28750);
  assert.equal(res.line_total, 287.5);
});

test("calculateLineTotals rejects invalid quantities and negative unit prices", () => {
  assert.throws(() => calculateLineTotals({ quantity: 0, unit_price: 50 }), /Quantity must be greater than zero/);
  assert.throws(() => calculateLineTotals({ quantity: -2, unit_price: 50 }), /Quantity must be greater than zero/);
  assert.throws(() => calculateLineTotals({ quantity: 1, unit_price: -10 }), /Unit price must be a non-negative number/);
});

test("calculateQuoteFinancials computes pre-tax, provisional 15% VAT, and grand total in integer cents", () => {
  const lines = [
    { description: "Rigging Crew", quantity: 16, unit_price: 45, cost_type: "labour", unit_of_measure: "hours", work_package_id: "wp_01" },
    { description: "Mobile Crane", quantity: 1, unit_price: 850, cost_type: "equipment", unit_of_measure: "days", work_package_id: "wp_01" }
  ];
  // 16 * 45 = 720, 1 * 850 = 850 => pre-tax = 1570.00 (157,000 cents)
  // VAT 15% provisional => 157000 * 0.15 = 23550 cents (235.50)
  // Grand total => 180550 cents (1,805.50)
  const result = calculateQuoteFinancials({
    lines,
    taxStatus: "provisional",
    appliedTaxRate: 0.15
  });

  assert.equal(result.pre_tax_total_cents, 157000);
  assert.equal(result.pre_tax_total, 1570);
  assert.equal(result.discount_cents, 0);
  assert.equal(result.net_subtotal_cents, 157000);
  assert.equal(result.tax_status, "provisional");
  assert.equal(result.applied_tax_rate, 0.15);
  assert.equal(result.tax_total_cents, 23550);
  assert.equal(result.tax_total, 235.5);
  assert.equal(result.grand_total_cents, 180550);
  assert.equal(result.total_amount, 1805.5);
});

test("calculateQuoteFinancials handles commercial discount correctly", () => {
  const lines = [
    { description: "Ceramic tiles", quantity: 10, unit_price: 100, cost_type: "material", unit_of_measure: "m2" }
  ];
  // pre-tax: 1,000.00 (100,000 cents)
  // 10% discount: 10,000 cents
  // net subtotal: 90,000 cents (900.00)
  // 15% VAT: 90000 * 0.15 = 13500 cents (135.00)
  // grand total: 103,500 cents (1,035.00)
  const result = calculateQuoteFinancials({
    lines,
    discountPercent: 10,
    taxStatus: "taxable",
    appliedTaxRate: 0.15
  });

  assert.equal(result.pre_tax_total_cents, 100000);
  assert.equal(result.discount_percent, 10);
  assert.equal(result.discount_cents, 10000);
  assert.equal(result.discount_amount, 100);
  assert.equal(result.net_subtotal_cents, 90000);
  assert.equal(result.tax_total_cents, 13500);
  assert.equal(result.grand_total_cents, 103500);
});

test("calculateQuoteFinancials supports zero-rated and exempt tax treatments", () => {
  const lines = [
    { description: "Mining Export Scope", quantity: 5, unit_price: 200 }
  ];
  const zeroRated = calculateQuoteFinancials({ lines, taxStatus: "zero-rated" });
  assert.equal(zeroRated.tax_total_cents, 0);
  assert.equal(zeroRated.applied_tax_rate, 0);
  assert.equal(zeroRated.grand_total_cents, 100000);

  const exempt = calculateQuoteFinancials({ lines, taxStatus: "exempt" });
  assert.equal(exempt.tax_total_cents, 0);
  assert.equal(exempt.applied_tax_rate, 0);
  assert.equal(exempt.grand_total_cents, 100000);
});

test("calculateQuoteFinancials handles unconfigured tax status safely", () => {
  const lines = [{ description: "Draft item", quantity: 2, unit_price: 50 }];
  const result = calculateQuoteFinancials({ lines, taxStatus: "unconfigured" });
  assert.equal(result.tax_status, "unconfigured");
  assert.equal(result.applied_tax_rate, null);
  assert.equal(result.tax_total_cents, 0);
  assert.equal(result.grand_total_cents, 10000);
});

test("calculateQuoteFinancials excludes provisional_sum items from pre_tax_total_cents", () => {
  const lines = [
    { description: "Definite lining", quantity: 1, unit_price: 1000, item_type: "standard" },
    { description: "Optional ultrasonic testing", quantity: 1, unit_price: 350, item_type: "provisional_sum" }
  ];
  const result = calculateQuoteFinancials({ lines, taxStatus: "provisional" });
  assert.equal(result.pre_tax_total_cents, 100000);
  assert.equal(result.provisional_sum_cents, 35000);
  assert.equal(result.grand_total_cents, 115000);
});

test("normalizeDb preserves historical issued quote totals exactly without assigning provisional VAT", () => {
  const db = {
    users: [],
    suppliers: [],
    stock_items: [],
    company_profile: {},
    quotes: [
      { id: "q_hist_1", quote_number: "Q-HIST-01", status: "Sent", total_amount: 4250.75 },
      { id: "q_hist_2", quote_number: "Q-HIST-02", status: "Invoiced", total_amount: 15000.00 }
    ],
    quote_lines: [
      { id: "ql_1", quotation_id: "q_hist_1", description: "Wear tiles", quantity: 50, unit_price: 85.015 }
    ]
  };

  normalizeDb(db, { seedDemoRecords: false });

  assert.equal(db.quotes[0].currency, "USD");
  assert.equal(db.quotes[0].grand_total_cents, 425075);
  assert.equal(db.quotes[0].tax_status, "unconfigured", "historical quote must NOT be assigned provisional 15% VAT");
  assert.equal(db.quotes[0].applied_tax_rate, null);
  assert.equal(db.quotes[0].total_amount, 4250.75);

  assert.equal(db.quotes[1].grand_total_cents, 1500000);
  assert.equal(db.quotes[1].tax_status, "unconfigured");

  assert.equal(db.quote_lines[0].unit_of_measure, "each");
  assert.equal(db.quote_lines[0].cost_type, "material");
  assert.equal(db.quote_lines[0].work_package_id, "wp_01");
});
