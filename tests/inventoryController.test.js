import test from "node:test";
import assert from "node:assert/strict";

import { recordStockMovement } from "../src/controllers/inventoryController.js";

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

function createRequest({ role = "Admin", quantity, movementType = "adjustment", overrideNegative = false } = {}) {
  const user = { id: "user-1", role, is_active: true };
  return {
    user,
    body: {
      stock_item_id: "stock-1",
      movement_type: movementType,
      quantity,
      reason: "Test stock movement",
      override_negative: overrideNegative
    },
    db: {
      users: [user],
      stock_items: [{ id: "stock-1", item_name: "Ceramic tile", quantity_on_hand: 10, unit_of_measure: "each" }],
      stock_movements: []
    },
    store: {
      id: () => "movement-1",
      audit: () => {}
    }
  };
}

test("signed inventory adjustment reduces stock by its supplied amount", () => {
  const req = createRequest({ quantity: -3 });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.movement.quantity, -3);
  assert.equal(res.body.data.stock_item.quantity_on_hand, 7);
});

test("stock out always reduces stock even when supplied as a positive quantity", () => {
  const req = createRequest({ quantity: 3, movementType: "out" });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.movement.quantity, -3);
  assert.equal(res.body.data.stock_item.quantity_on_hand, 7);
});

test("negative stock is rejected without an explicit override", () => {
  const req = createRequest({ quantity: -11 });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(req.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(req.db.stock_movements.length, 0);
});

test("Management cannot override a negative-stock movement", () => {
  const req = createRequest({ role: "Management", quantity: -11, overrideNegative: true });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(req.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(req.db.stock_movements.length, 0);
});

test("Admin can explicitly override a negative-stock movement", () => {
  const req = createRequest({ quantity: -11, overrideNegative: true });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stock_item.quantity_on_hand, -1);
  assert.equal(res.body.data.movement.override_negative, true);
});
