import assert from "node:assert/strict";
import test from "node:test";
import {
  QuoteLineSchema,
  WorkPackageSchema,
  CreateQuoteSchema,
  UpdateQuoteSchema
} from "../src/schemas.js";

test("QuoteLineSchema accepts valid line with standard fields", () => {
  const parsed = QuoteLineSchema.parse({
    description: "Wear lining installation",
    quantity: 10,
    unit_price: 75
  });
  assert.equal(parsed.description, "Wear lining installation");
  assert.equal(parsed.quantity, 10);
  assert.equal(parsed.unit_price, 75);
});

test("QuoteLineSchema accepts all new controlled quotation fields", () => {
  const parsed = QuoteLineSchema.parse({
    description: "Rigging Crew",
    quantity: 16,
    unit_price: 45,
    cost_type: "labour",
    resource_role: "Rigging Crew (3)",
    unit_of_measure: "hours",
    work_package_id: "wp_01",
    item_type: "standard"
  });
  assert.equal(parsed.cost_type, "labour");
  assert.equal(parsed.resource_role, "Rigging Crew (3)");
  assert.equal(parsed.unit_of_measure, "hours");
  assert.equal(parsed.work_package_id, "wp_01");
  assert.equal(parsed.item_type, "standard");
});

test("QuoteLineSchema rejects unapproved unit of measure", () => {
  assert.throws(() => QuoteLineSchema.parse({
    description: "Invalid UoM",
    quantity: 1,
    unit_price: 10,
    unit_of_measure: "gallons"
  }));
});

test("QuoteLineSchema rejects invalid cost type", () => {
  assert.throws(() => QuoteLineSchema.parse({
    description: "Invalid cost type",
    quantity: 1,
    unit_price: 10,
    cost_type: "entertainment"
  }));
});

test("WorkPackageSchema validates work package structure", () => {
  const wp = WorkPackageSchema.parse({
    id: "wp_01",
    code: "WP-01",
    title: "Structural Dismantling & Removal",
    sequence: 1,
    description: "Initial rigging and lift"
  });
  assert.equal(wp.id, "wp_01");
  assert.equal(wp.title, "Structural Dismantling & Removal");
  assert.equal(wp.sequence, 1);
});

test("CreateQuoteSchema validates currency, tax status, discount and work packages", () => {
  const valid = CreateQuoteSchema.parse({
    client_id: "client-1",
    currency: "USD",
    tax_status: "provisional",
    applied_tax_rate: 0.15,
    discount_percent: 5,
    validity_days: 30,
    work_packages: [
      { id: "wp_01", title: "General Scope" }
    ],
    lines: [
      { description: "Item 1", quantity: 2, unit_price: 50, unit_of_measure: "each" }
    ]
  });
  assert.equal(valid.currency, "USD");
  assert.equal(valid.tax_status, "provisional");
  assert.equal(valid.discount_percent, 5);
  assert.equal(valid.validity_days, 30);
  assert.equal(valid.work_packages.length, 1);
});

test("CreateQuoteSchema rejects non-USD currency", () => {
  assert.throws(() => CreateQuoteSchema.parse({
    client_id: "client-1",
    currency: "ZAR",
    lines: [{ description: "Item 1", quantity: 1, unit_price: 10 }]
  }));
});

test("CreateQuoteSchema rejects invalid tax status", () => {
  assert.throws(() => CreateQuoteSchema.parse({
    client_id: "client-1",
    tax_status: "non_existent_tax_status",
    lines: [{ description: "Item 1", quantity: 1, unit_price: 10 }]
  }));
});

test("CreateQuoteSchema rejects negative discount or discount > 100", () => {
  assert.throws(() => CreateQuoteSchema.parse({
    client_id: "client-1",
    discount_percent: -5,
    lines: [{ description: "Item 1", quantity: 1, unit_price: 10 }]
  }));
  assert.throws(() => CreateQuoteSchema.parse({
    client_id: "client-1",
    discount_percent: 105,
    lines: [{ description: "Item 1", quantity: 1, unit_price: 10 }]
  }));
});
