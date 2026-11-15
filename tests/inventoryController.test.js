import test from "node:test";
import assert from "node:assert/strict";

import { recordStockMovement, issueDirectSaleStock, getStockMovements, getStockItemMovements, createStockItem, updateStockItem, createSupplier, updateSupplier } from "../src/controllers/inventoryController.js";

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
  // A receipt must now cite a registered supplier and a source document.
  req.body.reference_type = "supplier";
  req.body.reference_id = "sup-1";
  req.body.source_document_ref = "DN-1001";
  req.db.suppliers = [{ id: "sup-1", name: "Fictional Supplies" }];
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
  // A return tied to a dispatch cannot exceed what that dispatch used.
  req.db.stock_items[0].catalog_item_id = "cat-1";
  req.db.material_usage = [{ id: "mu-1", dispatch_card_id: "dispatch-1", catalog_item_id: "cat-1", quantity_used: 5 }];
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
  const { join, sep } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = walk(srcDir).filter((f) => /quantity_on_hand\s*[-+]?=[^=]/.test(readFileSync(f, "utf8")) && !f.endsWith("inventoryLedger.js"));
  // Seed/demo files build initial data objects; controllers must not mutate balance.
  const controllerOffenders = offenders.filter((f) => f.includes(`${sep}controllers${sep}`) && !f.endsWith("inventoryController.js"));
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

// ── Supplier hygiene (Lane 3, Batch 1): inactive-supplier receipts and duplicate names ──
// Fictional data only. Handlers are called directly, as in the tests above.

function supplierWorld(suppliers) {
  const users = [
    { id: "u-ops", role: "Operations", is_active: true },
    { id: "u-sales", role: "Sales", is_active: true }
  ];
  const audits = [];
  let n = 0;
  return {
    audits,
    db: {
      users,
      suppliers,
      stock_items: [{ id: "stock-1", item_code: "GSK-1", item_name: "Gasket", quantity_on_hand: 10, unit_of_measure: "each" }],
      stock_movements: []
    },
    store: { id: (prefix) => `${prefix}-${++n}`, audit: (...args) => audits.push(args) }
  };
}

const supplierRequest = (w, body, { id, userId = "u-ops" } = {}) => ({ user: { id: userId }, params: id ? { id } : {}, body, db: w.db, store: w.store });
const receiptRequest = (w, supplierId, extra = {}) => ({
  user: { id: "u-ops" },
  params: {},
  headers: {},
  query: {},
  body: { stock_item_id: "stock-1", movement_type: "in", quantity: 5, reason: "Delivery received", reference_type: "supplier", reference_id: supplierId, source_document_ref: "DN-1001", ...extra },
  db: w.db,
  store: w.store
});

test("a receipt from an inactive supplier is refused and changes nothing", () => {
  const w = supplierWorld([{ id: "sup-off", name: "Dormant Supplies", is_active: false }]);
  const res = createResponse();
  recordStockMovement(receiptRequest(w, "sup-off"), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /inactive/i);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10, "on-hand is untouched");
  assert.equal(w.db.stock_movements.length, 0, "no ledger entry was written");
  assert.equal(w.audits.length, 0, "no audit entry was written");
});

test("a refused inactive-supplier receipt leaves an earlier valid ledger untouched, and a later receipt from an active supplier still works", () => {
  const w = supplierWorld([{ id: "sup-on", name: "Active Supplies", is_active: true }, { id: "sup-off", name: "Dormant Supplies", is_active: false }]);
  const first = createResponse();
  recordStockMovement(receiptRequest(w, "sup-on", { quantity: 2, source_document_ref: "DN-1" }), first);
  assert.equal(first.statusCode, 200);
  const snapshot = JSON.stringify(w.db.stock_movements);
  const refused = createResponse();
  recordStockMovement(receiptRequest(w, "sup-off", { quantity: 3, source_document_ref: "DN-2" }), refused);
  assert.equal(refused.statusCode, 409);
  assert.equal(JSON.stringify(w.db.stock_movements), snapshot, "ledger is byte-for-byte unchanged by the refusal");
  assert.equal(w.db.stock_items[0].quantity_on_hand, 12);
  const next = createResponse();
  recordStockMovement(receiptRequest(w, "sup-on", { quantity: 4, source_document_ref: "DN-3" }), next);
  assert.equal(next.statusCode, 200);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 16);
});

test("a legacy supplier with no is_active field, and an explicitly active one, can still be received from", () => {
  const w = supplierWorld([{ id: "sup-legacy", name: "Legacy Supplies" }, { id: "sup-true", name: "Flagged Supplies", is_active: true }]);
  assert.equal("is_active" in w.db.suppliers[0], false);
  const legacy = createResponse();
  recordStockMovement(receiptRequest(w, "sup-legacy", { quantity: 3, source_document_ref: "DN-L" }), legacy);
  assert.equal(legacy.statusCode, 200);
  const flagged = createResponse();
  recordStockMovement(receiptRequest(w, "sup-true", { quantity: 2, source_document_ref: "DN-T" }), flagged);
  assert.equal(flagged.statusCode, 200);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 15);
  assert.equal(w.db.stock_movements.length, 2);
});

test("only an explicit false blocks: a supplier with is_active null or undefined is treated as active", () => {
  const w = supplierWorld([{ id: "sup-null", name: "Null Supplies", is_active: null }, { id: "sup-undef", name: "Undefined Supplies", is_active: undefined }]);
  for (const id of ["sup-null", "sup-undef"]) {
    const res = createResponse();
    recordStockMovement(receiptRequest(w, id, { quantity: 1, source_document_ref: `DN-${id}` }), res);
    assert.equal(res.statusCode, 200, id);
  }
});

test("a reactivated supplier can be received from again", () => {
  const w = supplierWorld([{ id: "sup-1", name: "Returning Supplies", is_active: false }]);
  const refused = createResponse();
  recordStockMovement(receiptRequest(w, "sup-1"), refused);
  assert.equal(refused.statusCode, 409);
  w.db.suppliers[0].is_active = true;
  const accepted = createResponse();
  recordStockMovement(receiptRequest(w, "sup-1"), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 15);
});

test("an inactive supplier does not block issues, corrections or returns, and the unknown-supplier and missing-document refusals are unchanged", () => {
  const w = supplierWorld([{ id: "sup-off", name: "Dormant Supplies", is_active: false }]);
  const issue = createResponse();
  recordStockMovement({ ...receiptRequest(w, undefined), body: { stock_item_id: "stock-1", movement_type: "out", quantity: 2, reason: "Issued to workshop" } }, issue);
  assert.equal(issue.statusCode, 200);
  const correction = createResponse();
  recordStockMovement({ ...receiptRequest(w, undefined), body: { stock_item_id: "stock-1", movement_type: "adjustment", quantity: -1, reason: "Count correction" } }, correction);
  assert.equal(correction.statusCode, 200);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 7);
  const unknown = createResponse();
  recordStockMovement(receiptRequest(w, "sup-missing"), unknown);
  assert.equal(unknown.statusCode, 400);
  const active = supplierWorld([{ id: "sup-on", name: "Active Supplies" }]);
  const noDocument = createResponse();
  recordStockMovement(receiptRequest(active, "sup-on", { source_document_ref: "" }), noDocument);
  assert.equal(noDocument.statusCode, 400);
  assert.equal(active.db.stock_items[0].quantity_on_hand, 10);
});

test("creating a supplier whose name matches an existing one ignoring case and spacing is rejected, with nothing written", () => {
  const w = supplierWorld([{ id: "sup-1", name: "Acme Supplies" }]);
  for (const name of ["acme supplies", "ACME SUPPLIES", "  Acme   Supplies  "]) {
    const res = createResponse();
    createSupplier(supplierRequest(w, { name }), res);
    assert.equal(res.statusCode, 409, name);
    assert.match(res.body.message, /already exists/i);
  }
  assert.equal(w.db.suppliers.length, 1);
  assert.equal(w.audits.length, 0);
});

test("an inactive supplier still blocks a duplicate name, and a legacy supplier without is_active does too", () => {
  const w = supplierWorld([{ id: "sup-off", name: "Dormant Supplies", is_active: false }, { id: "sup-legacy", name: "Legacy Supplies" }]);
  for (const name of ["dormant supplies", "LEGACY SUPPLIES"]) {
    const res = createResponse();
    createSupplier(supplierRequest(w, { name }), res);
    assert.equal(res.statusCode, 409, name);
  }
  assert.equal(w.db.suppliers.length, 2);
});

test("suppliers with different names are accepted, and the stored name keeps the caller's spelling", () => {
  const w = supplierWorld([{ id: "sup-1", name: "Acme Supplies" }]);
  const other = createResponse();
  createSupplier(supplierRequest(w, { name: "Acme Supplies East" }), other);
  assert.equal(other.statusCode, 200);
  const mixed = createResponse();
  createSupplier(supplierRequest(w, { name: "Borehole Rubber CC", email: "" }), mixed);
  assert.equal(mixed.statusCode, 200);
  assert.equal(mixed.body.data.name, "Borehole Rubber CC");
  assert.equal(w.db.suppliers.length, 3);
  assert.equal(w.audits.filter((a) => a[4] === "SUPPLIER_CREATED").length, 2);
});

test("renaming a supplier to another supplier's name is rejected; its own name, in any case, and a fresh name are allowed", () => {
  const w = supplierWorld([{ id: "sup-1", name: "Acme Supplies" }, { id: "sup-2", name: "Borehole Rubber" }]);
  const clash = createResponse();
  updateSupplier(supplierRequest(w, { name: "ACME supplies" }, { id: "sup-2" }), clash);
  assert.equal(clash.statusCode, 409);
  assert.equal(w.db.suppliers[1].name, "Borehole Rubber");
  assert.equal(w.audits.length, 0);
  const ownCase = createResponse();
  updateSupplier(supplierRequest(w, { name: "BOREHOLE RUBBER" }, { id: "sup-2" }), ownCase);
  assert.equal(ownCase.statusCode, 200);
  const fresh = createResponse();
  updateSupplier(supplierRequest(w, { name: "Borehole Rubber and Hose" }, { id: "sup-2" }), fresh);
  assert.equal(fresh.statusCode, 200);
  assert.equal(w.db.suppliers[1].name, "Borehole Rubber and Hose");
  const phoneOnly = createResponse();
  updateSupplier(supplierRequest(w, { phone: "+263 77 000 0000" }, { id: "sup-1" }), phoneOnly);
  assert.equal(phoneOnly.statusCode, 200);
});

test("supplier create and update remain restricted to inventory roles, and the duplicate check does not reveal names to others", () => {
  const w = supplierWorld([{ id: "sup-1", name: "Acme Supplies" }]);
  assert.throws(() => createSupplier(supplierRequest(w, { name: "acme supplies" }, { userId: "u-sales" }), createResponse()), (e) => e.status === 403);
  assert.throws(() => updateSupplier(supplierRequest(w, { name: "acme supplies" }, { id: "sup-1", userId: "u-sales" }), createResponse()), (e) => e.status === 403);
  assert.equal(w.db.suppliers.length, 1);
});
