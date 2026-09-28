import test from "node:test";
import assert from "node:assert/strict";

import { recordStockMovement, issueDirectSaleStock, getStockMovements, getStockItemMovements, createStockItem, updateStockItem } from "../src/controllers/inventoryController.js";

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

// ── Ledger fact completeness ──────────────────────────────────────────────────
// Every movement must be self-explaining: balance either side of the change,
// which way it moved, and (when given) what it is linked to — without having
// to replay the whole ledger to know what happened.

test("a recorded movement carries quantity_before, quantity_after and direction", () => {
  const req = createRequest({ quantity: -3 });
  const res = createResponse();

  recordStockMovement(req, res);

  const { movement } = res.body.data;
  assert.equal(movement.quantity_before, 10);
  assert.equal(movement.quantity_after, 7);
  assert.equal(movement.direction, "decrease");
  assert.equal(movement.unit_of_measure, "each");
});

test("an increasing movement is recorded with direction 'increase'", () => {
  const req = createRequest({ quantity: 5, movementType: "in" });
  const res = createResponse();

  recordStockMovement(req, res);

  const { movement } = res.body.data;
  assert.equal(movement.quantity_before, 10);
  assert.equal(movement.quantity_after, 15);
  assert.equal(movement.direction, "increase");
});

test("a dispatch-linked movement resolves a readable reference label from real source records only", () => {
  const req = createRequest({ quantity: -3 });
  req.body.reference_id = "dispatch-1";
  req.body.reference_type = "dispatch_card";
  req.db.dispatch_cards = [{ id: "dispatch-1", dispatch_number: "JOB-0007", quotation_id: "quote-1" }];
  req.db.quotes = [{ id: "quote-1", client_id: "client-1", equipment_tag_id: null }];
  req.db.clients = [{ id: "client-1", name: "Zimplats" }];
  const res = createResponse();

  recordStockMovement(req, res);

  const { movement } = res.body.data;
  assert.equal(movement.reference_type, "dispatch_card");
  assert.equal(movement.reference_label, "Dispatch JOB-0007 — Zimplats");
});

test("a reference to a record that does not exist is labelled, never fabricated or hidden", () => {
  const req = createRequest({ quantity: -3 });
  req.body.reference_id = "dispatch-missing";
  req.body.reference_type = "dispatch_card";
  req.db.dispatch_cards = [];
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.body.data.movement.reference_label, "Dispatch dispatch-missing (not found)");
});

test("no reference_id/type means no invented reference label", () => {
  const req = createRequest({ quantity: -3 });
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.body.data.movement.reference_id, null);
  assert.equal(res.body.data.movement.reference_type, null);
  assert.equal(res.body.data.movement.reference_label, null);
});

// ── Movement history endpoints ────────────────────────────────────────────────

function historyRequest({ role = "Operations", query = {}, params = {} } = {}) {
  const user = { id: "user-1", role, is_active: true };
  const movements = [
    { id: "smv-1", stock_item_id: "stock-1", movement_type: "in", direction: "increase", quantity: 10, quantity_before: 0, quantity_after: 10, unit_of_measure: "each", reason: "Initial receipt", reference_id: null, reference_type: null, reference_label: null, override_negative: false, actor_id: "user-1", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "smv-2", stock_item_id: "stock-1", movement_type: "out", direction: "decrease", quantity: -4, quantity_before: 10, quantity_after: 6, unit_of_measure: "each", reason: "Issued to job", reference_id: null, reference_type: null, reference_label: null, override_negative: false, actor_id: "user-1", created_at: "2026-01-02T00:00:00.000Z" },
    { id: "smv-3", stock_item_id: "stock-2", movement_type: "in", direction: "increase", quantity: 5, quantity_before: 0, quantity_after: 5, unit_of_measure: "set", reason: "Other item", reference_id: null, reference_type: null, reference_label: null, override_negative: false, actor_id: "user-1", created_at: "2026-01-03T00:00:00.000Z" }
  ];
  return {
    user,
    query,
    params,
    db: {
      users: [user],
      stock_items: [
        { id: "stock-1", item_code: "RUB-LINING", item_name: "Rubber Lining", quantity_on_hand: 6, unit_of_measure: "each" },
        { id: "stock-2", item_code: "FAST-M16", item_name: "Fastener Kit", quantity_on_hand: 5, unit_of_measure: "set" }
      ],
      stock_movements: movements
    }
  };
}

test("getStockMovements returns the full ledger newest-first, decorated with item and actor names", () => {
  const req = historyRequest();
  const res = createResponse();

  getStockMovements(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 3);
  assert.deepEqual(res.body.data.map((m) => m.id), ["smv-3", "smv-2", "smv-1"]);
  assert.equal(res.body.data[1].item_code, "RUB-LINING");
  assert.equal(res.body.data[1].actor_name, null); // fixture user has no `name` field
});

test("getStockMovements filters to one stock_item_id when given", () => {
  const req = historyRequest({ query: { stock_item_id: "stock-1" } });
  const res = createResponse();

  getStockMovements(req, res);

  assert.equal(res.body.data.length, 2);
  assert.ok(res.body.data.every((m) => m.stock_item_id === "stock-1"));
});

test("getStockMovements denies a role outside manageInventory", () => {
  // requirePermission() throws (status 403) rather than writing to res; the
  // real server's error middleware turns this into a 403 response. Asserting
  // the throw here matches how every other permission check in this
  // controller already behaves (see recordStockMovement/getStockItems above).
  const req = historyRequest({ role: "Technician" });
  const res = createResponse();

  assert.throws(() => getStockMovements(req, res), /cannot perform manageInventory/);
});

test("getStockItemMovements returns one item's history newest-first with the item echoed back", () => {
  const req = historyRequest({ params: { id: "stock-1" } });
  const res = createResponse();

  getStockItemMovements(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.stock_item.id, "stock-1");
  assert.deepEqual(res.body.data.movements.map((m) => m.id), ["smv-2", "smv-1"]);
});

test("getStockItemMovements 404s for an unknown stock item", () => {
  const req = historyRequest({ params: { id: "does-not-exist" } });
  const res = createResponse();

  getStockItemMovements(req, res);

  assert.equal(res.statusCode, 404);
});

test("getStockMovements filters by reference_type and client_id and decorates client_name", () => {
  const req = historyRequest({ query: { reference_type: "direct_sale", client_id: "client-1" } });
  req.db.clients = [{ id: "client-1", name: "Walk-in Client" }, { id: "client-2", name: "Other Client" }];
  req.db.stock_movements.push(
    { id: "smv-4", stock_item_id: "stock-1", movement_type: "out", direction: "decrease", quantity: -1, quantity_before: 6, quantity_after: 5, unit_of_measure: "each", reason: "Sale A", reference_id: "sale-1", reference_type: "direct_sale", client_id: "client-1", created_at: "2026-01-04T00:00:00.000Z" },
    { id: "smv-5", stock_item_id: "stock-1", movement_type: "out", direction: "decrease", quantity: -1, quantity_before: 5, quantity_after: 4, unit_of_measure: "each", reason: "Sale B", reference_id: "sale-2", reference_type: "direct_sale", client_id: "client-2", created_at: "2026-01-05T00:00:00.000Z" }
  );
  const res = createResponse();

  getStockMovements(req, res);

  assert.equal(res.body.count, 1);
  assert.equal(res.body.data[0].id, "smv-4");
  assert.equal(res.body.data[0].client_name, "Walk-in Client");
});

test("a failed direct-sale issue leaves both balance and ledger untouched, and a successful one adds exactly one ledger entry", () => {
  const failing = directSaleRequest({ quantity: 999 });
  issueDirectSaleStock(failing, createResponse());
  assert.equal(failing.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(failing.db.stock_movements.length, 0);

  const ok = directSaleRequest({ quantity: 1 });
  issueDirectSaleStock(ok, createResponse());
  assert.equal(ok.db.stock_items[0].quantity_on_hand, 9);
  assert.equal(ok.db.stock_movements.length, 1);
});

// ── Direct-sale stock issue (Chat C contract) ─────────────────────────────────
// This endpoint owns only stock mechanics. It must go through the exact same
// applyStockChange() as every other movement — proven below by asserting the
// resulting movement has the identical shape (quantity_before/after,
// direction) as a manual movement, plus the direct_sale-specific fields.

process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE = "true"; // endpoint ships dormant; tests below opt in explicitly

function directSaleRequest({ role = "Operations", quantity = 4, clientId = "client-1", saleReferenceId = "sale-9001", overrideNegative = false } = {}) {
  const user = { id: "ops-1", role, is_active: true };
  return {
    user,
    body: {
      stock_item_id: "stock-1",
      quantity,
      reason: "Counter sale — walk-in client",
      client_id: clientId,
      sale_reference_id: saleReferenceId,
      override_negative: overrideNegative
    },
    db: {
      users: [user],
      clients: [{ id: "client-1", name: "Walk-in Client" }],
      stock_items: [{ id: "stock-1", item_code: "RUB-LINING", item_name: "Rubber Lining", quantity_on_hand: 10, unit_of_measure: "each" }],
      stock_movements: []
    },
    store: {
      id: () => "smv-direct-1",
      audit: () => {}
    }
  };
}

test("a direct-sale issue deducts stock through the shared ledger with a resolved client label", () => {
  const req = directSaleRequest({ quantity: 4 });
  const res = createResponse();

  issueDirectSaleStock(req, res);

  assert.equal(res.statusCode, 200);
  const { movement, stock_item } = res.body.data;
  assert.equal(stock_item.quantity_on_hand, 6);
  assert.equal(movement.quantity, -4);
  assert.equal(movement.quantity_before, 10);
  assert.equal(movement.quantity_after, 6);
  assert.equal(movement.direction, "decrease");
  assert.equal(movement.reference_type, "direct_sale");
  assert.equal(movement.reference_id, "sale-9001");
  assert.equal(movement.client_id, "client-1");
  assert.equal(movement.reference_label, "Direct sale issue — sale sale-9001 — Walk-in Client");
});

test("a direct-sale issue for an unresolved client says so instead of guessing a name", () => {
  const req = directSaleRequest({ clientId: "client-missing" });
  const res = createResponse();

  issueDirectSaleStock(req, res);

  assert.equal(res.body.data.movement.reference_label, "Direct sale issue — sale sale-9001 (client client-missing not found)");
});

test("a direct-sale issue past on-hand stock is blocked exactly like a manual movement", () => {
  const req = directSaleRequest({ quantity: 100 });
  const res = createResponse();

  issueDirectSaleStock(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(req.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(req.db.stock_movements.length, 0);
});

test("a direct-sale issue denies a role outside manageInventory", () => {
  const req = directSaleRequest({ role: "Sales" });
  const res = createResponse();

  assert.throws(() => issueDirectSaleStock(req, res), /cannot perform manageInventory/);
  // Logged as an owner decision in CHAT_C_DIRECT_SALE_STOCK_ISSUE_CONTRACT.md,
  // not assumed here: whether Sales/Finance should call this directly, or a
  // manageInventory-holding role issues on their behalf.
});

// ── "return" and "scrap" reference categories ─────────────────────────────────

test("a return without a matching dispatch or PO says so plainly rather than guessing a link", () => {
  const req = createRequest({ quantity: 2, movementType: "in" });
  req.body.reference_type = "return";
  req.body.reference_id = "no-such-record";
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.body.data.movement.reference_label, "Return — reference no-such-record (not matched to a known dispatch or purchase order)");
});

test("a return against a real dispatch resolves through the same dispatch label logic", () => {
  const req = createRequest({ quantity: 2, movementType: "in" });
  req.body.reference_type = "return";
  req.body.reference_id = "dispatch-1";
  req.db.dispatch_cards = [{ id: "dispatch-1", dispatch_number: "JOB-0042", quotation_id: null }];
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.body.data.movement.reference_label, "Return — Dispatch JOB-0042");
});

test("scrap never claims a linked business record it cannot prove", () => {
  const req = createRequest({ quantity: -1, movementType: "adjustment" });
  req.body.reference_type = "scrap";
  const res = createResponse();

  recordStockMovement(req, res);

  assert.equal(res.body.data.movement.reference_label, "Scrap / write-off");
});

// ── Registration lifecycle and unit safety ────────────────────────────────────

function registrationRequest(body) {
  const user = { id: "ops-1", role: "Operations", is_active: true };
  return {
    user,
    body,
    params: {},
    db: { users: [user], stock_items: [], stock_movements: [] },
    store: { id: () => "si-new", audit: () => {} }
  };
}

test("registering an item with an opening balance writes a ledger entry so no stock is unexplained", () => {
  const req = registrationRequest({ item_code: "NEW-1", item_name: "New item", unit_of_measure: "kg", quantity_on_hand: 12 });
  const res = createResponse();

  createStockItem(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.db.stock_movements.length, 1);
  const m = req.db.stock_movements[0];
  assert.equal(m.quantity_before, 0);
  assert.equal(m.quantity_after, 12);
  assert.equal(m.direction, "increase");
  assert.equal(m.reference_type, "opening_balance");
  assert.equal(m.reference_label, "Opening balance at registration");
  assert.equal(m.unit_of_measure, "kg");
});

test("registering an item with zero balance writes no ledger entry", () => {
  const req = registrationRequest({ item_code: "NEW-2", item_name: "Empty item", unit_of_measure: "each" });
  createStockItem(req, createResponse());
  assert.equal(req.db.stock_movements.length, 0);
});

test("unit of measure cannot change once movements exist, but can before", () => {
  const item = { id: "stock-1", item_code: "A", item_name: "A", unit_of_measure: "each", quantity_on_hand: 5 };
  const user = { id: "ops-1", role: "Operations", is_active: true };
  const base = (movements) => ({
    user, params: { id: "stock-1" }, body: { unit_of_measure: "kg" },
    db: { users: [user], stock_items: [{ ...item }], stock_movements: movements },
    store: { audit: () => {} }
  });

  const blocked = base([{ id: "m1", stock_item_id: "stock-1" }]);
  const blockedRes = createResponse();
  updateStockItem(blocked, blockedRes);
  assert.equal(blockedRes.statusCode, 409);
  assert.equal(blocked.db.stock_items[0].unit_of_measure, "each");

  const allowed = base([]);
  const allowedRes = createResponse();
  updateStockItem(allowed, allowedRes);
  assert.equal(allowedRes.statusCode, 200);
  assert.equal(allowed.db.stock_items[0].unit_of_measure, "kg");
});

test("quantity_on_hand is mutated in exactly one place in backend source (applyStockChange)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
  const srcDir = new URL("../src", import.meta.url).pathname;
  const offenders = walk(srcDir).filter((f) => /quantity_on_hand\s*[-+]?=[^=]/.test(readFileSync(f, "utf8")) && !f.endsWith("inventoryLedger.js"));
  // Seed/demo files build initial data objects; controllers must not mutate balance.
  const controllerOffenders = offenders.filter((f) => f.includes("/controllers/") && !f.endsWith("inventoryController.js"));
  assert.deepEqual(controllerOffenders, []);
});

// ── Route/schema wiring (source inspection: zod is not installable offline) ───

test("router and schemas wire the direct-sale endpoint and expose no edit/delete route for movements", async () => {
  const { readFileSync } = await import("node:fs");
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  const schemas = readFileSync(new URL("../src/schemas.js", import.meta.url), "utf8");
  assert.match(router, /router\.post\("\/inventory\/movements\/direct-sale", validate\(DirectSaleStockIssueSchema\), issueDirectSaleStock\)/);
  assert.match(router, /router\.get\("\/inventory\/movements", getStockMovements\)/);
  assert.match(router, /router\.get\("\/inventory\/stock_items\/:id\/movements", getStockItemMovements\)/);
  assert.doesNotMatch(router, /router\.(patch|put|delete)\("\/(inventory\/)?(movements|stock_movements)/);
  assert.match(schemas, /export const DirectSaleStockIssueSchema/);
  assert.match(schemas, /quantity: z\.number\(\)\.positive/);
  // direct_sale is only reachable via its own endpoint, not the generic movement schema
  const generic = schemas.slice(schemas.indexOf("export const StockMovementSchema"), schemas.indexOf("export const DirectSaleStockIssueSchema"));
  const enumLine = generic.split(/\r?\n/).find((l) => l.includes("reference_type: z.enum"));
  assert.ok(enumLine, "reference_type enum line not found");
  assert.doesNotMatch(enumLine, /direct_sale/);
  assert.doesNotMatch(enumLine, /opening_balance/);
  assert.match(enumLine, /"return"/);
  assert.match(enumLine, /"scrap"/);
});

test("direct-sale issue is dormant by default: 404, and neither balance nor ledger changes", () => {
  const previous = process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE;
  delete process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE;
  try {
    const req = directSaleRequest({ quantity: 1 });
    const res = createResponse();
    issueDirectSaleStock(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(req.db.stock_items[0].quantity_on_hand, 10);
    assert.equal(req.db.stock_movements.length, 0);
  } finally {
    process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE = previous;
  }
});
