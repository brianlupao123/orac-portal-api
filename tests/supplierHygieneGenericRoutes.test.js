// Z7 (test-only): supplier hygiene across the GENERIC archive routes
// (POST /admin/suppliers/:id/deactivate and /reactivate, built by deactivateEntity / reactivateEntity
// in coreController.js) versus the inventory controller's receipt rules.
// Adds no route, collection, permission, status, field or workflow; changes no production source.
// Direct-handler style, fictional data. Handlers are exercised exactly as router.js registers them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deactivateEntity, reactivateEntity, getCollection } from "../src/controllers/coreController.js";
import { recordStockMovement, getStockMovements, getStockItemMovements, getLowStockReport, createSupplier, updateSupplier } from "../src/controllers/inventoryController.js";
import { permissions } from "../src/permissions.js";

const ROLES = ["Admin", "Management", "Sales", "Operations", "Technician", "Supervisor", "Finance", "Client Viewer"];
const ARCHIVE_ROLES = ["Admin", "Management", "Operations"]; // pinned: archivePermissions.suppliers = manageInventory
const idOf = (role) => `u-${role.toLowerCase().replace(/\s+/g, "-")}`;
const deactivate = deactivateEntity("suppliers");
const reactivate = reactivateEntity("suppliers");

function createResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function createWorld() {
  let counter = 0;
  const db = {
    users: [
      ...ROLES.map((role) => ({ id: idOf(role), role, name: `${role} User`, is_active: true })),
      { id: "u-gone", role: "Admin", name: "Gone Admin", is_active: false }
    ],
    suppliers: [
      { id: "sup-1", name: "Legacy Supplies" },                      // legacy: no is_active field
      { id: "sup-2", name: "Active Supplies", is_active: true },
      { id: "sup-off", name: "Dormant Supplies", is_active: false }   // explicitly inactive
    ],
    stock_items: [
      { id: "stock-1", item_code: "GSK-1", item_name: "Gasket", quantity_on_hand: 10, unit_of_measure: "each", reorder_level: 20, supplier_id: "sup-1" }
    ],
    stock_movements: [],
    clients: [],
    audit_logs: []
  };
  const store = {
    id: (prefix) => `${prefix}-${++counter}`,
    audit: (database, actor, entity, id, action, before, after) => { database.audit_logs.push({ actor: actor.id, entity, id, action, before, after }); }
  };
  return { db, store };
}

const request = (world, userId, { body = {}, params = {}, query = {}, headers = {} } = {}) => ({ user: userId ? { id: userId } : undefined, body, params, query, headers, db: world.db, store: world.store });
const run = (handler, world, userId, extra) => {
  const res = createResponse();
  try { handler(request(world, userId, extra), res); } catch (error) { return { threw: error, res }; }
  return { res };
};
const snapshot = (world) => JSON.stringify(world.db);
const receipt = (supplierId, note = "DN-1", overrides = {}) => ({ stock_item_id: "stock-1", movement_type: "in", quantity: 4, reason: "Delivery received", reference_type: "supplier", reference_id: supplierId, source_document_ref: note, ...overrides });
const post = (world, supplierId, note, headers) => run(recordStockMovement, world, idOf("Operations"), { body: receipt(supplierId, note), headers }).res;
const archive = (world, id, role = "Admin") => run(deactivate, world, idOf(role), { params: { id } }).res;
const restore = (world, id, role = "Admin") => run(reactivate, world, idOf(role), { params: { id } }).res;

test("wiring (source): suppliers are in the generic collections list and get deactivate/reactivate from the shared loop; no supplier-specific archive route exists", () => {
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  const list = router.slice(router.indexOf("const collections = ["), router.indexOf("];", router.indexOf("const collections = [")));
  assert.match(list, /"suppliers"/);
  assert.match(router, /router\.post\(`\/admin\/\$\{collection\}\/:id\/deactivate`, deactivateEntity\(collection\)\)/);
  assert.match(router, /router\.post\(`\/admin\/\$\{collection\}\/:id\/reactivate`, reactivateEntity\(collection\)\)/);
  assert.ok(!/["'`]\/(admin|inventory)\/suppliers\/:id\/(deactivate|reactivate)/.test(router), "no explicit per-supplier archive route is expected");
  assert.match(router, /router\.patch\("\/inventory\/suppliers\/:id", validate\(UpdateSupplierSchema\), updateSupplier\)/);
});

test("pinned: the archive permission for suppliers is manageInventory (Admin, Management, Operations)", () => {
  assert.deepEqual([...permissions.manageInventory].sort(), [...ARCHIVE_ROLES].sort());
});

test("characterisation: generic deactivate/reactivate permission matrix; every refusal changes nothing", () => {
  const actors = [...ROLES.map((role) => [role, idOf(role)]), ["inactive Admin", "u-gone"]];
  for (const [label, userId] of actors) {
    for (const [name, handler] of [["deactivate", deactivate], ["reactivate", reactivate]]) {
      const world = createWorld();
      const before = snapshot(world);
      const { threw, res } = run(handler, world, userId, { params: { id: "sup-2" } });
      assert.equal(threw, undefined, `${name} ${label}`);
      if (ARCHIVE_ROLES.includes(label)) {
        assert.equal(res.statusCode, 200, `${name} ${label}`);
      } else {
        assert.equal(res.statusCode, 403, `${name} ${label}`);
        assert.equal(snapshot(world), before, `${name} ${label}: a refusal must change nothing`);
      }
    }
  }
});

test("characterisation: a request with no user, or a user id that is not in the database, is rejected with 401 and changes nothing", () => {
  for (const userId of [null, "u-missing"]) {
    for (const handler of [deactivate, reactivate]) {
      const world = createWorld();
      const before = snapshot(world);
      const { threw } = run(handler, world, userId, { params: { id: "sup-1" } });
      assert.equal(threw?.status, 401, String(userId));
      assert.equal(snapshot(world), before);
    }
  }
});

test("unknown supplier id: 404 on both routes, nothing changes", () => {
  const world = createWorld();
  const before = snapshot(world);
  assert.equal(archive(world, "nope").statusCode, 404);
  assert.equal(restore(world, "nope").statusCode, 404);
  assert.equal(snapshot(world), before);
});

test("generic deactivate: sets the flag and who/when, keeps every other field, audits once, and touches no stock data", () => {
  const world = createWorld();
  const stockBefore = JSON.stringify([world.db.stock_items, world.db.stock_movements]);
  const res = archive(world, "sup-1", "Operations");
  assert.equal(res.statusCode, 200);
  const supplier = world.db.suppliers.find((s) => s.id === "sup-1");
  assert.equal(supplier.is_active, false);
  assert.equal(supplier.deactivated_by, idOf("Operations"));
  assert.ok(!Number.isNaN(Date.parse(supplier.deactivated_at)));
  assert.equal(supplier.name, "Legacy Supplies");
  assert.equal(JSON.stringify([world.db.stock_items, world.db.stock_movements]), stockBefore);
  const entries = world.db.audit_logs.filter((a) => a.entity === "suppliers");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "SUPPLIERS_DEACTIVATED");
  assert.equal(entries[0].before.is_active, undefined);
  assert.equal(entries[0].after.is_active, false);
});

test("deactivating twice stays inactive and returns 200 (characterised, not a recommendation)", () => {
  const world = createWorld();
  assert.equal(archive(world, "sup-2").statusCode, 200);
  assert.equal(archive(world, "sup-2").statusCode, 200);
  assert.equal(world.db.suppliers.find((s) => s.id === "sup-2").is_active, false);
});

test("Z7 consistency: a receipt is refused the same way whether the supplier was deactivated through the generic route or is stored as inactive", () => {
  const viaRoute = createWorld();
  const routeLegacy = archive(viaRoute, "sup-1");
  assert.equal(routeLegacy.statusCode, 200);
  const viaRouteActive = createWorld();
  archive(viaRouteActive, "sup-2");
  const stored = createWorld(); // sup-off is stored inactive with no route involved

  const results = [
    ["legacy supplier, deactivated by route", viaRoute, "sup-1"],
    ["active supplier, deactivated by route", viaRouteActive, "sup-2"],
    ["supplier stored as inactive", stored, "sup-off"]
  ].map(([label, world, supplierId]) => {
    const before = snapshot(world);
    const res = post(world, supplierId, "DN-7");
    assert.equal(res.statusCode, 409, label);
    assert.match(res.body.message, /is inactive/, label);
    assert.equal(snapshot(world), before, `${label}: refusal must leave stock, movements and audit identical`);
    return res.body.message.replace(/Supplier .*? is inactive/, "Supplier X is inactive");
  });
  assert.equal(new Set(results).size, 1, "the refusal wording must not depend on how the supplier became inactive");
});

test("the controller cannot deactivate or reactivate: updateSupplier ignores the activity flag in either direction", () => {
  const world = createWorld();
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-2" }, body: { is_active: false, phone: "1" } }).res.statusCode, 200);
  assert.equal(world.db.suppliers.find((s) => s.id === "sup-2").is_active, true);
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-off" }, body: { is_active: true, phone: "2" } }).res.statusCode, 200);
  assert.equal(world.db.suppliers.find((s) => s.id === "sup-off").is_active, false, "reactivation is possible only through the generic route");
  assert.ok(post(world, "sup-off", "DN-8").statusCode === 409);
});

test("history stays readable after deactivation: earlier receipts and the supplier row are still listed", () => {
  const world = createWorld();
  assert.equal(post(world, "sup-1", "DN-1").statusCode, 200);
  assert.equal(post(world, "sup-1", "DN-2").statusCode, 200);
  assert.equal(archive(world, "sup-1").statusCode, 200);

  const viaInventory = run(getStockMovements, world, idOf("Operations"), { query: { reference_type: "supplier" } }).res.body;
  assert.equal(viaInventory.count, 2);
  assert.ok(viaInventory.data.every((m) => m.reference_id === "sup-1"));
  const perItem = run(getStockItemMovements, world, idOf("Admin"), { params: { id: "stock-1" } }).res.body.data;
  assert.equal(perItem.movements.length, 2);

  const generic = createResponse();
  getCollection("stock_movements")(request(world, idOf("Management")), generic);
  assert.equal(generic.statusCode, 200);
  assert.equal(generic.body.data.length, 2);
  assert.deepEqual(generic.body.data.map((m) => m.source_document_ref).sort(), ["DN-1", "DN-2"]);

  const suppliers = createResponse();
  getCollection("suppliers")(request(world, idOf("Admin")), suppliers);
  const row = suppliers.body.data.find((s) => s.id === "sup-1");
  assert.ok(row, "an inactive supplier must still be listed");
  assert.equal(row.is_active, false);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 18, "deactivation must not change the balance");
});

test("the generic supplier list is readable only by Admin, Management and Operations", () => {
  for (const role of ROLES) {
    const world = createWorld();
    const res = createResponse();
    getCollection("suppliers")(request(world, idOf(role)), res);
    assert.equal(res.statusCode, ARCHIVE_ROLES.includes(role) ? 200 : 403, role);
  }
});

test("reactivating restores receipt eligibility; the deactivation markers are removed and the audit trail shows both steps", () => {
  const world = createWorld();
  assert.equal(archive(world, "sup-2", "Management").statusCode, 200);
  assert.equal(post(world, "sup-2", "DN-A").statusCode, 409);
  const res = restore(world, "sup-2", "Operations");
  assert.equal(res.statusCode, 200);
  const supplier = world.db.suppliers.find((s) => s.id === "sup-2");
  assert.equal(supplier.is_active, true);
  assert.equal("deactivated_by" in supplier, false);
  assert.equal("deactivated_at" in supplier, false);
  const ok = post(world, "sup-2", "DN-A");
  assert.equal(ok.statusCode, 200);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 14);
  assert.deepEqual(world.db.audit_logs.filter((a) => a.entity === "suppliers").map((a) => a.action), ["SUPPLIERS_DEACTIVATED", "SUPPLIERS_REACTIVATED"]);
});

test("a supplier stored as inactive from the start can be reactivated and then receives", () => {
  const world = createWorld();
  assert.equal(post(world, "sup-off", "DN-B").statusCode, 409);
  assert.equal(restore(world, "sup-off").statusCode, 200);
  assert.equal(post(world, "sup-off", "DN-B").statusCode, 200);
});

test("reactivating an already-active or legacy supplier sets the flag to true and stays eligible (characterised)", () => {
  const world = createWorld();
  assert.equal(restore(world, "sup-1").statusCode, 200);
  assert.equal(world.db.suppliers.find((s) => s.id === "sup-1").is_active, true);
  assert.equal(post(world, "sup-1", "DN-C").statusCode, 200);
});

test("the idempotent replay of a receipt made before deactivation still returns the original result and posts nothing new", () => {
  const world = createWorld();
  const headers = { "idempotency-key": "z7-key-0001" };
  const first = post(world, "sup-1", "DN-D", headers);
  assert.equal(first.statusCode, 200);
  assert.equal(archive(world, "sup-1").statusCode, 200);
  const after = snapshot(world);
  const replay = post(world, "sup-1", "DN-D", headers);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(snapshot(world), after);
  // a NEW key for the same receipt is refused because the supplier is now inactive
  assert.equal(post(world, "sup-1", "DN-D", { "idempotency-key": "z7-key-0002" }).statusCode, 409);
});

test("supplier names still count while inactive and after the route changes state: duplicates are refused, a reactivated supplier can be renamed to a free name", () => {
  const world = createWorld();
  archive(world, "sup-2");
  assert.equal(run(createSupplier, world, idOf("Admin"), { body: { name: "  ACTIVE   supplies " } }).res.statusCode, 409);
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-1" }, body: { name: "active supplies" } }).res.statusCode, 409);
  restore(world, "sup-2");
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-2" }, body: { name: "Renamed Supplies" } }).res.statusCode, 200);
  assert.equal(run(createSupplier, world, idOf("Admin"), { body: { name: "Active Supplies" } }).res.statusCode, 200, "the old name is free once its owner is renamed");
});

test("a stock item linked to a deactivated supplier still appears in the low-stock report with the supplier name", () => {
  const world = createWorld();
  archive(world, "sup-1");
  const report = run(getLowStockReport, world, idOf("Operations")).res.body;
  assert.equal(report.count, 1);
  assert.equal(report.data[0].supplier_name, "Legacy Supplies");
});

test("immutable ledger is unaffected: stock_movements still answers 405 on the generic archive routes, and suppliers' archive does not touch movements", () => {
  const world = createWorld();
  post(world, "sup-1", "DN-E");
  const movementId = world.db.stock_movements[0].id;
  const before = JSON.stringify(world.db.stock_movements);
  for (const factory of [deactivateEntity, reactivateEntity]) {
    const res = createResponse();
    factory("stock_movements")(request(world, idOf("Admin"), { params: { id: movementId } }), res);
    assert.equal(res.statusCode, 405);
  }
  archive(world, "sup-1");
  restore(world, "sup-1");
  assert.equal(JSON.stringify(world.db.stock_movements), before);
});
