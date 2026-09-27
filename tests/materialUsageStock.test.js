import test from "node:test";
import assert from "node:assert/strict";
import { addMaterialUsage, getDispatchMaterialStatus } from "../src/controllers/dispatchController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function baseDb({ quantityOnHand = 10, reorderLevel = 2 } = {}) {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const dispatch = { id: "dispatch-1", assigned_technician_id: "tech-1", dispatch_number: "DC-001", purchase_order_id: "po-1" };
  const stockItem = {
    id: "stock-1",
    catalog_item_id: "cat-1",
    item_code: "BOLT-10",
    item_name: "10mm Bolt",
    unit_of_measure: "each",
    quantity_on_hand: quantityOnHand,
    reorder_level: reorderLevel
  };
  return {
    users: [technician],
    dispatch_cards: [dispatch],
    material_usage: [],
    stock_items: [stockItem],
    stock_movements: [],
    audit_logs: []
  };
}

function req(db, body, actorId = "tech-1", dispatchId = "dispatch-1") {
  return {
    user: { id: actorId },
    params: { id: dispatchId },
    body,
    db,
    store: { id: (prefix) => `${prefix}-new`, audit() {}, recalculateVariance() {} }
  };
}

test("recording usage against a tracked catalog item always deducts stock — no caller toggle required", () => {
  const db = baseDb();
  const res = response();
  addMaterialUsage(req(db, { catalog_item_id: "cat-1", description: "Bolts", quantity_used: 3, unit_cost: 1 }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db.stock_items[0].quantity_on_hand, 7);
  assert.equal(db.stock_movements.length, 1);
  assert.equal(db.stock_movements[0].movement_type, "out");
  assert.equal(res.body.stock_deducted.remaining, 7);
});

test("a caller can no longer opt out of a real stock deduction by omitting deduct_stock", () => {
  const db = baseDb();
  const res = response();
  // No deduct_stock flag at all — under the old contract this silently
  // skipped inventory impact while still recording the usage/cost.
  addMaterialUsage(req(db, { catalog_item_id: "cat-1", description: "Bolts", quantity_used: 3, unit_cost: 1 }), res);

  assert.equal(db.stock_items[0].quantity_on_hand, 7, "stock must move even without a deduct_stock flag");
  assert.equal(db.material_usage.length, 1);
});

test("insufficient stock blocks the whole request — no usage record and no stock movement are left behind", () => {
  const db = baseDb({ quantityOnHand: 2 });
  const res = response();
  addMaterialUsage(req(db, { catalog_item_id: "cat-1", description: "Bolts", quantity_used: 5, unit_cost: 1 }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(db.material_usage.length, 0, "material usage must not be recorded when the linked stock move is rejected");
  assert.equal(db.stock_movements.length, 0);
  assert.equal(db.stock_items[0].quantity_on_hand, 2);
});

test("a Technician cannot override negative stock even with override_negative:true", () => {
  const db = baseDb({ quantityOnHand: 2 });
  const res = response();
  addMaterialUsage(req(db, { catalog_item_id: "cat-1", description: "Bolts", quantity_used: 5, unit_cost: 1, override_negative: true }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(db.material_usage.length, 0);
  assert.equal(db.stock_items[0].quantity_on_hand, 2);
});

test("Operations can override negative stock explicitly, and the resulting deficit is recorded", () => {
  const db = baseDb({ quantityOnHand: 2 });
  db.users.push({ id: "ops-1", role: "Operations", is_active: true });
  const res = response();
  addMaterialUsage(req(db, { catalog_item_id: "cat-1", description: "Bolts", quantity_used: 5, unit_cost: 1, override_negative: true }, "ops-1"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db.stock_items[0].quantity_on_hand, -3);
  assert.equal(db.stock_movements[0].override_negative, true);
});

test("material usage with no catalog_item_id (untracked/adhoc material) records usage without touching stock", () => {
  const db = baseDb();
  const res = response();
  addMaterialUsage(req(db, { description: "Misc consumable", quantity_used: 1, unit_cost: 5 }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(db.stock_items[0].quantity_on_hand, 10);
  assert.equal(db.material_usage.length, 1);
  assert.equal(res.body.data.catalog_item_id, null);
});

test("dispatch material status is scoped to items already used on that dispatch and hides cost/supplier fields", () => {
  const db = baseDb({ quantityOnHand: 1, reorderLevel: 5 });
  db.material_usage.push({ id: "mu-1", dispatch_card_id: "dispatch-1", catalog_item_id: "cat-1", quantity_used: 3 });
  const res = response();
  getDispatchMaterialStatus(req(db, {}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
  const [row] = res.body.data;
  assert.equal(row.item_code, "BOLT-10");
  assert.equal(row.is_low_stock, true);
  assert.equal(row.used_on_this_dispatch, 3);
  assert.equal(row.unit_cost, undefined, "field roles must not receive commercial cost data");
  assert.equal(row.supplier_id, undefined);
});

test("a Technician cannot read material status for a dispatch they are not assigned to", () => {
  const db = baseDb();
  db.dispatch_cards.push({ id: "dispatch-2", assigned_technician_id: "tech-2" });
  const res = response();
  getDispatchMaterialStatus(req(db, {}, "tech-1", "dispatch-2"), res);

  assert.equal(res.statusCode, 403);
});
