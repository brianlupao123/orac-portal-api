import test from "node:test";
import assert from "node:assert/strict";
import { StockMovementSchema, AddMaterialSchema } from "../src/schemas.js";

// Schema-level checks for the Task 02 additions. Zod strips unknown keys, so a
// field the schema does not list never reaches the controller: these tests prove
// the new fields actually survive validation.

const base = { stock_item_id: "si-1", movement_type: "in", quantity: 5, reason: "Delivery" };

test("StockMovementSchema keeps source_document_ref and idempotency_key", () => {
  const out = StockMovementSchema.parse({ ...base, reference_type: "supplier", reference_id: "sup-1", source_document_ref: "  DN-7781 ", idempotency_key: "abcd-1234-efgh" });
  assert.equal(out.source_document_ref, "DN-7781");
  assert.equal(out.idempotency_key, "abcd-1234-efgh");
  assert.equal(out.reference_type, "supplier");
});

test("StockMovementSchema still rejects reserved and unknown reference types and zero quantity", () => {
  assert.throws(() => StockMovementSchema.parse({ ...base, reference_type: "direct_sale" }));
  assert.throws(() => StockMovementSchema.parse({ ...base, reference_type: "opening_balance" }));
  assert.throws(() => StockMovementSchema.parse({ ...base, quantity: 0 }));
  assert.throws(() => StockMovementSchema.parse({ ...base, reason: "" }));
});

test("StockMovementSchema rejects malformed or over-long idempotency keys and source documents", () => {
  assert.throws(() => StockMovementSchema.parse({ ...base, idempotency_key: "short" }));
  assert.throws(() => StockMovementSchema.parse({ ...base, idempotency_key: "has spaces in it" }));
  assert.throws(() => StockMovementSchema.parse({ ...base, source_document_ref: "x".repeat(121) }));
});

test("AddMaterialSchema keeps unit_of_measure and idempotency_key, and stays backward compatible without them", () => {
  const legacy = AddMaterialSchema.parse({ catalog_item_id: "cat-1", description: "Gasket", quantity_used: 2, unit_cost: 5 });
  assert.equal(legacy.unit_of_measure, undefined);
  const out = AddMaterialSchema.parse({ catalog_item_id: "cat-1", description: "Gasket", quantity_used: 2, unit_cost: 5, unit_of_measure: "each", idempotency_key: "usage-key-0001" });
  assert.equal(out.unit_of_measure, "each");
  assert.equal(out.idempotency_key, "usage-key-0001");
});

test("AddMaterialSchema does not accept override_negative (documented existing behaviour: the worksheet HTTP path cannot force negative stock)", () => {
  const out = AddMaterialSchema.parse({ description: "x", quantity_used: 1, unit_cost: 0, override_negative: true });
  assert.equal("override_negative" in out, false);
});

// ── Real schema -> handler pipeline (validate() middleware, no express needed) ─
import { validate } from "../src/middleware/validate.js";
import { recordStockMovement, getStockMovements } from "../src/controllers/inventoryController.js";
import { addMaterialUsage } from "../src/controllers/dispatchController.js";

function pipeline(schema, handler, req) {
  const r = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  validate(schema)(req, r, () => { passed = true; });
  if (passed) handler(req, r);
  return { passed, r };
}

function pipelineWorld() {
  let n = 0;
  const users = [
    { id: "u-ops", role: "Operations", is_active: true },
    { id: "u-tech", role: "Technician", is_active: true },
    { id: "u-mgmt", role: "Management", is_active: true }
  ];
  const db = {
    users, suppliers: [{ id: "sup-1", name: "Fictional Supplies" }], clients: [], quotes: [],
    dispatch_cards: [{ id: "d-1", dispatch_number: "JOB-1", assigned_technician_id: "u-tech" }],
    material_usage: [], stock_movements: [],
    stock_items: [{ id: "si-1", catalog_item_id: "cat-1", item_code: "G", item_name: "Gasket", unit_of_measure: "each", quantity_on_hand: 10, reorder_level: 1 }]
  };
  return { db, store: { id: (p) => `${p}-${++n}`, audit: () => {}, recalculateVariance: () => {} } };
}

test("pipeline: a valid supplier receipt passes the real schema and reaches the ledger with its source document", () => {
  const w = pipelineWorld();
  const { passed, r } = pipeline(StockMovementSchema, recordStockMovement, {
    user: { id: "u-ops" }, db: w.db, store: w.store, headers: {}, query: {}, params: {},
    body: { stock_item_id: "si-1", movement_type: "in", quantity: 5, reason: "Delivery", reference_type: "supplier", reference_id: "sup-1", source_document_ref: " DN-55 " }
  });
  assert.equal(passed, true);
  assert.equal(r.statusCode, 200);
  assert.equal(w.db.stock_movements[0].source_document_ref, "DN-55");
});

test("pipeline: reserved or unknown reference types and malformed keys are stopped by the schema before any handler runs", () => {
  const w = pipelineWorld();
  for (const body of [
    { reference_type: "opening_balance" }, { reference_type: "direct_sale" }, { reference_type: "cash_sale" },
    { idempotency_key: "short" }
  ]) {
    const { passed, r } = pipeline(StockMovementSchema, recordStockMovement, {
      user: { id: "u-ops" }, db: w.db, store: w.store, headers: {}, query: {}, params: {},
      body: { stock_item_id: "si-1", movement_type: "out", quantity: 1, reason: "x", ...body }
    });
    assert.equal(passed, false);
    assert.equal(r.statusCode, 400);
  }
  assert.equal(w.db.stock_movements.length, 0);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10);
});

test("pipeline: over-stock worksheet usage through the real schema is refused with no usage and no movement, even if override_negative is sent", () => {
  const w = pipelineWorld();
  const { passed, r } = pipeline(AddMaterialSchema, addMaterialUsage, {
    user: { id: "u-ops" }, db: w.db, store: w.store, headers: {}, query: {}, params: { id: "d-1" },
    body: { catalog_item_id: "cat-1", description: "Gasket", quantity_used: 99, unit_cost: 1, override_negative: true }
  });
  assert.equal(passed, true, "the schema accepts and strips the extra field");
  assert.equal(r.statusCode, 409, "the override never reaches the handler over HTTP, so stock cannot go negative via the worksheet path");
  assert.equal(w.db.material_usage.length, 0);
  assert.equal(w.db.stock_movements.length, 0);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10);
});

test("pipeline: the Idempotency-Key header makes a repeated worksheet submission deduct once", () => {
  const w = pipelineWorld();
  const send = () => pipeline(AddMaterialSchema, addMaterialUsage, {
    user: { id: "u-tech" }, db: w.db, store: w.store, query: {}, params: { id: "d-1" },
    headers: { "idempotency-key": "hdr-worksheet-0001" },
    body: { catalog_item_id: "cat-1", description: "Gasket", quantity_used: 2, unit_cost: 1 }
  }).r;
  const first = send();
  const again = send();
  assert.equal(first.statusCode, 200);
  assert.equal(again.body.idempotent_replay, true);
  assert.equal(w.db.material_usage.length, 1);
  assert.equal(w.db.stock_movements.length, 1);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 8);
});

test("pipeline: Management can read the ledger but its negative-stock override is still refused after validation", () => {
  const w = pipelineWorld();
  const { r } = pipeline(StockMovementSchema, recordStockMovement, {
    user: { id: "u-mgmt" }, db: w.db, store: w.store, headers: {}, query: {}, params: {},
    body: { stock_item_id: "si-1", movement_type: "out", quantity: 50, reason: "force", override_negative: true }
  });
  assert.equal(r.statusCode, 403);
  assert.equal(w.db.stock_movements.length, 0);
  const read = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  getStockMovements({ user: { id: "u-mgmt" }, db: w.db, store: w.store, query: {}, headers: {} }, read);
  assert.equal(read.statusCode, 200);
});
