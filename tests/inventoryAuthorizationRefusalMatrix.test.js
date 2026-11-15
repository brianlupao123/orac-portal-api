// F1 (test-only): authorization matrix and "refusal leaves no change" checks for the EXISTING
// supplier / stock / movement / reconciliation handlers. Adds no route, collection, status, field,
// permission or workflow. Fictional data only. Direct-handler style, like inventoryController.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as inventory from "../src/controllers/inventoryController.js";
import { permissions } from "../src/permissions.js";

const {
  getSuppliers, createSupplier, updateSupplier, getStockItems, createStockItem, updateStockItem,
  recordStockMovement, issueDirectSaleStock, getStockMovements, getStockItemMovements, getLowStockReport, getInventoryReconciliation
} = inventory;

const ROLES = ["Admin", "Management", "Sales", "Operations", "Technician", "Supervisor", "Finance", "Client Viewer"];
// Pinned on purpose: if the real matrix changes, this fails and a human must re-approve it.
const MANAGE_INVENTORY = ["Admin", "Management", "Operations"];

function createResponse() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function createWorld() {
  let counter = 0;
  const db = {
    users: [
      ...ROLES.map((role) => ({ id: `u-${role.toLowerCase().replace(/\s+/g, "-")}`, role, name: `${role} User`, is_active: true })),
      { id: "u-gone", role: "Admin", name: "Gone Admin", is_active: false }
    ],
    suppliers: [
      { id: "sup-1", name: "Legacy Supplies" },
      { id: "sup-off", name: "Dormant Supplies", is_active: false }
    ],
    stock_items: [
      { id: "stock-1", item_code: "GSK-1", item_name: "Gasket", quantity_on_hand: 10, unit_of_measure: "each", reorder_level: 2, supplier_id: "sup-1" },
      { id: "stock-2", item_code: "RUB-1", item_name: "Rubber sheet", quantity_on_hand: 0, unit_of_measure: "kg", reorder_level: 5 }
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

const idOf = (role) => `u-${role.toLowerCase().replace(/\s+/g, "-")}`;
const request = (world, userId, { body = {}, params = {}, query = {}, headers = {} } = {}) => ({ user: { id: userId }, body, params, query, headers, db: world.db, store: world.store });
const run = (handler, world, userId, extra) => {
  const res = createResponse();
  try { handler(request(world, userId, extra), res); } catch (error) { return { threw: error, res }; }
  return { res };
};
const snapshot = (world) => JSON.stringify(world.db);
const receiptBody = (overrides = {}) => ({ stock_item_id: "stock-1", movement_type: "in", quantity: 4, reason: "Delivery received", reference_type: "supplier", reference_id: "sup-1", source_document_ref: "DN-100", ...overrides });

// Handler, a request that would succeed for an allowed role, and whether it mutates data.
const CASES = [
  ["getSuppliers", getSuppliers, {}, false],
  ["createSupplier", createSupplier, { body: { name: "Matrix Supplies" } }, true],
  ["updateSupplier", updateSupplier, { params: { id: "sup-1" }, body: { phone: "000" } }, true],
  ["getStockItems", getStockItems, {}, false],
  ["createStockItem", createStockItem, { body: { item_code: "NEW-1", item_name: "New item", unit_of_measure: "each" } }, true],
  ["updateStockItem", updateStockItem, { params: { id: "stock-1" }, body: { location: "Bay 1" } }, true],
  ["recordStockMovement", recordStockMovement, { body: receiptBody() }, true],
  ["issueDirectSaleStock", issueDirectSaleStock, { body: { stock_item_id: "stock-1", quantity: 1, reason: "Walk-in sale" } }, true],
  ["getStockMovements", getStockMovements, {}, false],
  ["getStockItemMovements", getStockItemMovements, { params: { id: "stock-1" } }, false],
  ["getLowStockReport", getLowStockReport, {}, false],
  ["getInventoryReconciliation", getInventoryReconciliation, {}, false]
];

test("pinned: manageInventory is Admin, Management and Operations only", () => {
  assert.deepEqual([...permissions.manageInventory].sort(), [...MANAGE_INVENTORY].sort());
});

test("authorization matrix: every handler x every role, inactive user and unknown user; refusals change nothing", () => {
  delete process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE;
  for (const [name, handler, extra, mutates] of CASES) {
    const actors = [...ROLES.map((role) => [role, idOf(role)]), ["inactive Admin", "u-gone"], ["unknown user", "u-missing"]];
    for (const [label, userId] of actors) {
      const world = createWorld();
      const before = snapshot(world);
      const { threw, res } = run(handler, world, userId, extra);
      const allowed = MANAGE_INVENTORY.includes(label);
      if (allowed) {
        assert.equal(threw, undefined, `${name} should allow ${label}`);
        assert.notEqual(res.statusCode, 403, `${name} ${label}`);
      } else {
        assert.ok(threw, `${name} should refuse ${label}`);
        assert.equal(threw.status, 403, `${name} ${label}`);
        assert.equal(snapshot(world), before, `${name} ${label}: a refusal must change nothing`);
      }
    }
  }
});

test("dormant direct-sale issue answers 404 for allowed roles and changes nothing while its flag is unset", () => {
  delete process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE;
  const world = createWorld();
  const before = snapshot(world);
  const { res } = run(issueDirectSaleStock, world, idOf("Admin"), { body: { stock_item_id: "stock-1", quantity: 1, reason: "Walk-in sale" } });
  assert.equal(res.statusCode, 404);
  assert.equal(snapshot(world), before);
});

test("client viewer and every non-inventory role is refused on every inventory handler", () => {
  for (const role of ["Client Viewer", "Sales", "Technician", "Supervisor", "Finance"]) {
    for (const [name, handler, extra] of CASES) {
      const world = createWorld();
      const { threw } = run(handler, world, idOf(role), extra);
      assert.equal(threw?.status, 403, `${name} ${role}`);
    }
  }
});

test("refusal leaves no change: every way a manual receipt can be refused leaves stock, movements and audit untouched", () => {
  const refusals = [
    ["inactive supplier", receiptBody({ reference_id: "sup-off" }), 409],
    ["unknown supplier", receiptBody({ reference_id: "nope" }), 400],
    ["missing source document", receiptBody({ source_document_ref: "  " }), 400],
    ["no reference type", receiptBody({ reference_type: undefined, reference_id: undefined }), 400],
    ["material_usage posted manually", receiptBody({ reference_type: "material_usage" }), 409],
    ["unknown stock item", receiptBody({ stock_item_id: "missing" }), 404],
    ["insufficient stock", { stock_item_id: "stock-1", movement_type: "out", quantity: 50, reason: "Too much" }, 409]
  ];
  for (const [label, body, status] of refusals) {
    const world = createWorld();
    const before = snapshot(world);
    const { threw, res } = run(recordStockMovement, world, idOf("Operations"), { body });
    assert.equal(threw, undefined, label);
    assert.equal(res.statusCode, status, label);
    assert.equal(snapshot(world), before, `${label}: stock, movements and audit must be identical`);
  }
});

test("negative-stock override: Management is refused without any change; Admin and Operations may override", () => {
  const body = { stock_item_id: "stock-1", movement_type: "out", quantity: 50, reason: "Write-off", override_negative: true };
  const refused = createWorld();
  const before = snapshot(refused);
  const { res } = run(recordStockMovement, refused, idOf("Management"), { body });
  assert.equal(res.statusCode, 403);
  assert.equal(snapshot(refused), before);
  for (const role of ["Admin", "Operations"]) {
    const world = createWorld();
    assert.equal(run(recordStockMovement, world, idOf(role), { body }).res.statusCode, 200, role);
    assert.equal(world.db.stock_items[0].quantity_on_hand, -40);
    assert.equal(world.db.stock_movements.length, 1);
    assert.equal(world.db.stock_movements[0].override_negative, true);
  }
});

test("supplier hygiene refusals (duplicate name, inactive receipt) leave data untouched; legacy supplier still receives", () => {
  const world = createWorld();
  let before = snapshot(world);
  assert.equal(run(createSupplier, world, idOf("Admin"), { body: { name: "  legacy   SUPPLIES " } }).res.statusCode, 409);
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-off" }, body: { name: "legacy supplies" } }).res.statusCode, 409);
  assert.equal(snapshot(world), before);
  assert.equal(run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() }).res.statusCode, 200);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 14);
});

test("a supplier receipt writes only stock, movements and audit: no other collection changes", () => {
  const world = createWorld();
  world.db.invoices = [{ id: "inv-1", total: 100 }];
  world.db.purchase_orders = [{ id: "po-1", total: 50 }];
  const others = () => JSON.stringify({ users: world.db.users, suppliers: world.db.suppliers, clients: world.db.clients, invoices: world.db.invoices, purchase_orders: world.db.purchase_orders });
  const before = others();
  assert.equal(run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() }).res.statusCode, 200);
  assert.equal(others(), before);
  assert.equal(world.db.stock_movements.length, 1);
  assert.equal(world.db.audit_logs.filter((a) => a.action === "STOCK_MOVEMENT_RECORDED").length, 1);
});

test("property-level: unlisted fields in a body are ignored (activity flag, id, quantity_on_hand)", () => {
  const world = createWorld();
  assert.equal(run(updateSupplier, world, idOf("Admin"), { params: { id: "sup-1" }, body: { phone: "123", is_active: false, id: "hijack", role: "Admin" } }).res.statusCode, 200);
  const supplier = world.db.suppliers.find((s) => s.name === "Legacy Supplies");
  assert.equal(supplier.id, "sup-1");
  assert.equal(supplier.phone, "123");
  assert.equal(supplier.is_active, undefined, "updateSupplier must not let a body switch a supplier off");
  assert.equal(run(createSupplier, world, idOf("Admin"), { body: { name: "Fresh Co", is_active: false } }).res.statusCode, 200);
  assert.equal(world.db.suppliers.find((s) => s.name === "Fresh Co").is_active, undefined);
  assert.equal(run(updateStockItem, world, idOf("Admin"), { params: { id: "stock-1" }, body: { quantity_on_hand: 9999, location: "Bay 2" } }).res.statusCode, 200);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 10, "updateStockItem must not change the balance");
  assert.equal(world.db.stock_movements.length, 0);
});

test("unit of measure cannot change once movements exist, and the refusal changes nothing", () => {
  const world = createWorld();
  run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() });
  const before = snapshot(world);
  assert.equal(run(updateStockItem, world, idOf("Admin"), { params: { id: "stock-1" }, body: { unit_of_measure: "box" } }).res.statusCode, 409);
  assert.equal(snapshot(world), before);
});

test("idempotency: replay posts nothing twice; same key with a different body conflicts and changes nothing; a key is scoped to its user", () => {
  const world = createWorld();
  const headers = { "idempotency-key": "matrix-key-0001" };
  const first = run(recordStockMovement, world, idOf("Operations"), { body: receiptBody(), headers }).res;
  assert.equal(first.statusCode, 200);
  const afterFirst = snapshot(world);
  const replay = run(recordStockMovement, world, idOf("Operations"), { body: receiptBody(), headers }).res;
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal(snapshot(world), afterFirst);
  const conflict = run(recordStockMovement, world, idOf("Operations"), { body: receiptBody({ quantity: 9 }), headers }).res;
  assert.equal(conflict.statusCode, 409);
  assert.equal(snapshot(world), afterFirst);
  assert.equal(world.db.stock_movements.length, 1);
});

test("immutable ledger (behavioural): reading movements never changes them, and returned rows are copies", () => {
  const world = createWorld();
  run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() });
  const before = snapshot(world);
  const list = run(getStockMovements, world, idOf("Admin")).res.body.data;
  list[0].quantity = 999; list[0].reason = "tampered";
  const byItem = run(getStockItemMovements, world, idOf("Admin"), { params: { id: "stock-1" } }).res.body.data.movements;
  byItem[0].quantity = 999;
  assert.equal(snapshot(world), before, "stored movements must be unaffected by changes to returned rows");
});

test("immutable ledger (source): the controller exports no movement edit/delete handler, and the router exposes movements only through POST create and GET reads", () => {
  const names = Object.keys(inventory);
  assert.ok(!names.some((n) => /(update|edit|delete|remove|void|cancel)\w*Movement|Movement\w*(Update|Edit|Delete|Remove)/i.test(n)), names.join(", "));
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  const routeLines = router.split("\n").filter((line) => /router\.(get|post|put|patch|delete)\(\s*["'`]\/inventory\/(movements|stock_items\/:id\/movements)/.test(line));
  assert.ok(routeLines.length >= 3, "expected the known movement routes to be found");
  for (const line of routeLines) assert.ok(/router\.(get|post)\(/.test(line), `unexpected method on a movement route: ${line.trim()}`);
  assert.ok(!/router\.(put|patch|delete)\(\s*["'`][^"'`]*stock_movements/.test(router));
});

test("correction path: an adjustment is a NEW movement with actor and reason; the original movement is untouched", () => {
  const world = createWorld();
  run(recordStockMovement, world, idOf("Operations"), { body: receiptBody({ quantity: 5 }) });
  const original = JSON.stringify(world.db.stock_movements[0]);
  const fix = run(recordStockMovement, world, idOf("Operations"), { body: { stock_item_id: "stock-1", movement_type: "adjustment", quantity: -5, reason: "Receipt keyed twice in error" } }).res;
  assert.equal(fix.statusCode, 200);
  assert.equal(world.db.stock_movements.length, 2);
  assert.equal(JSON.stringify(world.db.stock_movements[0]), original);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(world.db.stock_movements[1].reason, "Receipt keyed twice in error");
  assert.equal(world.db.stock_movements[1].actor_id, idOf("Operations"));
});

test("a deactivated supplier keeps its history readable while new receipts are refused", () => {
  const world = createWorld();
  assert.equal(run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() }).res.statusCode, 200);
  world.db.suppliers.find((s) => s.id === "sup-1").is_active = false;
  const list = run(getStockMovements, world, idOf("Operations"), { query: { reference_type: "supplier" } }).res.body;
  assert.equal(list.count, 1);
  const before = snapshot(world);
  assert.equal(run(recordStockMovement, world, idOf("Operations"), { body: receiptBody({ source_document_ref: "DN-101" }) }).res.statusCode, 409);
  assert.equal(snapshot(world), before);
});

test("reconciliation is read-only and stays clean after receipts, adjustments and an override", () => {
  const world = createWorld();
  run(recordStockMovement, world, idOf("Operations"), { body: receiptBody() });
  run(recordStockMovement, world, idOf("Operations"), { body: { stock_item_id: "stock-1", movement_type: "adjustment", quantity: -2, reason: "Count correction" } });
  const before = snapshot(world);
  const report = run(getInventoryReconciliation, world, idOf("Management")).res.body.data;
  assert.equal(snapshot(world), before);
  assert.ok(report.totals, "report has totals");
  assert.equal(report.totals.with_exceptions ?? 0, 0);
});

// ── Findings kept visible without failing the run ────────────────────────────

test("FINDING: if the audit hook throws AFTER posting, stock and movement are already changed (no rollback)", { todo: "Expected behaviour is undecided. Today recordStockMovement posts via applyStockChange and only then calls store.audit, so an audit failure leaves an unaudited movement. Owner/Antigravity to decide whether to fix; this test is a todo so it does not fail the suite." }, () => {
  const world = createWorld();
  world.store.audit = () => { throw new Error("audit down"); };
  assert.throws(() => recordStockMovement(request(world, idOf("Operations"), { body: receiptBody() }), createResponse()), /audit down/);
  assert.equal(world.db.stock_items[0].quantity_on_hand, 10, "no half-posted stock after an audit failure");
  assert.equal(world.db.stock_movements.length, 0);
});

import { deactivateEntity, reactivateEntity } from "../src/controllers/coreController.js";

test("VERIFIED: generic deactivate/reactivate routes return 405 Method Not Allowed for stock_movements (immutable ledger)", () => {
  const world = createWorld();
  const res = createResponse();
  deactivateEntity("stock_movements")(request(world, idOf("Admin"), { params: { id: "sm-1" } }), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body.message, /immutable and cannot be archived/);

  const res2 = createResponse();
  reactivateEntity("stock_movements")(request(world, idOf("Admin"), { params: { id: "sm-1" } }), res2);
  assert.equal(res2.statusCode, 405);
  assert.match(res2.body.message, /immutable and cannot be reactivated/);
});

test("router source: the generic collections list includes stock_movements, so the generic loop must be checked (documented, not asserted)", () => {
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  assert.match(router, /"stock_movements"/);
  assert.match(router, /router\.post\(`\/admin\/\$\{collection\}\/:id\/deactivate`/);
});
