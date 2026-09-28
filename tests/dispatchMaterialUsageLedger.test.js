import test from "node:test";
import assert from "node:assert/strict";

import { addMaterialUsage } from "../src/controllers/dispatchController.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function createRequest({ quantityUsed = 5, overrideNegative = false, deductStock = true } = {}) {
  const actor = { id: "ops-1", role: "Operations", is_active: true };
  return {
    user: { id: actor.id },
    params: { id: "dispatch-1" },
    body: {
      catalog_item_id: "cat-rubber",
      description: "Rubber lining patch",
      quantity_used: quantityUsed,
      unit_cost: 60,
      deduct_stock: deductStock,
      override_negative: overrideNegative
    },
    db: {
      users: [actor],
      dispatch_cards: [{ id: "dispatch-1", dispatch_number: "JOB-0009", quotation_id: "quote-1" }],
      field_worksheets: [],
      quotes: [{ id: "quote-1", client_id: "client-1", equipment_tag_id: null }],
      clients: [{ id: "client-1", name: "Mimosa Mining Company" }],
      material_usage: [],
      stock_items: [{ id: "stock-rubber", catalog_item_id: "cat-rubber", item_code: "RUB-LINING", item_name: "Heavy Duty Rubber Lining", quantity_on_hand: 30, unit_of_measure: "m2" }],
      stock_movements: []
    },
    store: {
      id: (() => {
        let n = 0;
        return (prefix) => `${prefix}-${++n}`;
      })(),
      recalculateVariance: () => {},
      audit: () => {}
    }
  };
}

test("worksheet material usage with deduct_stock records a movement built by the shared ledger, not a divergent inline shape", () => {
  const req = createRequest({ quantityUsed: 5 });
  const res = createResponse();

  addMaterialUsage(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.db.stock_items[0].quantity_on_hand, 25);
  assert.equal(req.db.stock_movements.length, 1);

  const movement = req.db.stock_movements[0];
  // Same fields the manual /inventory/movements endpoint produces via
  // buildMovementRecord() — proves one shared builder, not two designs.
  assert.equal(movement.movement_type, "out");
  assert.equal(movement.direction, "decrease");
  assert.equal(movement.quantity, -5);
  assert.equal(movement.quantity_before, 30);
  assert.equal(movement.quantity_after, 25);
  assert.equal(movement.unit_of_measure, "m2");
  assert.equal(movement.reference_type, "material_usage");
  assert.match(movement.reference_label, /^Material usage on dispatch JOB-0009$/);
  assert.equal(movement.actor_id, "ops-1");
  assert.ok(movement.created_at);
});

test("insufficient stock without override leaves on-hand quantity and ledger untouched", () => {
  const req = createRequest({ quantityUsed: 100 });
  const res = createResponse();

  addMaterialUsage(req, res);

  assert.equal(res.statusCode, 200); // material usage itself still records; stock deduction is skipped
  assert.ok(res.body.stock_warning);
  assert.equal(req.db.stock_items[0].quantity_on_hand, 30);
  assert.equal(req.db.stock_movements.length, 0);
});

test("a non-Admin/Operations actor cannot force a negative-stock deduction via the worksheet path", () => {
  const req = createRequest({ quantityUsed: 100, overrideNegative: true });
  req.db.users[0].role = "Technician";
  req.db.dispatch_cards[0].assigned_technician_id = "ops-1";
  const res = createResponse();

  addMaterialUsage(req, res);

  assert.equal(req.db.stock_items[0].quantity_on_hand, 30);
  assert.equal(req.db.stock_movements.length, 0);
  assert.ok(res.body.stock_warning);
});

test("worksheet deduction and the direct-sale endpoint produce ledger entries with identical field sets (one deduction path)", async () => {
  process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE = "true";
  const { issueDirectSaleStock } = await import("../src/controllers/inventoryController.js");

  const wsReq = createRequest({ quantityUsed: 2 });
  addMaterialUsage(wsReq, createResponse());
  const worksheetKeys = Object.keys(wsReq.db.stock_movements[0]).sort();

  const actor = { id: "ops-1", role: "Operations", is_active: true };
  const dsReq = {
    user: { id: actor.id },
    body: { stock_item_id: "stock-rubber", quantity: 2, reason: "Counter sale", client_id: "client-1", sale_reference_id: "sale-1" },
    db: { ...wsReq.db, stock_movements: [], stock_items: [{ id: "stock-rubber", item_code: "RUB-LINING", quantity_on_hand: 30, unit_of_measure: "m2" }] },
    store: wsReq.store
  };
  issueDirectSaleStock(dsReq, createResponse());
  const directSaleKeys = Object.keys(dsReq.db.stock_movements[0]).sort();

  assert.deepEqual(directSaleKeys, worksheetKeys);
});
