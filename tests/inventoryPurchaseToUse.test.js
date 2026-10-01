import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  recordStockMovement, createStockItem, getStockMovements, getStockItemMovements,
  getInventoryReconciliation, getLowStockReport
} from "../src/controllers/inventoryController.js";
import { addMaterialUsage } from "../src/controllers/dispatchController.js";
import { buildReconciliation, RECEIPT_REQUIRES_SOURCE_DOCUMENT } from "../src/inventoryLedger.js";

// Task 02 - inventory purchase-to-use traceability. Fictional data only.
// Handlers are called directly (same style as inventoryController.test.js), so
// these run without express/jwt/bcrypt installed.

const ROLES = ["Admin", "Management", "Sales", "Operations", "Technician", "Supervisor", "Finance", "Client Viewer"];

function res() {
  return { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function world(extra = {}) {
  let n = 0;
  const users = ROLES.map((role) => ({ id: `u-${role.replace(" ", "-")}`, role, name: `${role} User`, is_active: true, client_id: role === "Client Viewer" ? "c-1" : null }));
  const db = {
    users,
    clients: [{ id: "c-1", name: "Fictional Mine A" }, { id: "c-2", name: "Fictional Mine B" }],
    suppliers: [{ id: "sup-1", name: "Fictional Supplies Ltd" }],
    quotes: [{ id: "q-1", client_id: "c-1", equipment_tag_id: null }],
    dispatch_cards: [{ id: "d-1", dispatch_number: "JOB-0001", quotation_id: "q-1", assigned_technician_id: "u-Technician" }],
    material_usage: [],
    stock_items: [{ id: "si-1", catalog_item_id: "cat-1", item_code: "GSK-1", item_name: "Gasket", unit_of_measure: "each", quantity_on_hand: 10, reorder_level: 2 }],
    stock_movements: [],
    ...extra
  };
  const store = { id: (p) => `${p}-${++n}`, audit: () => {}, recalculateVariance: () => {} };
  return { db, store };
}
const as = (w, role, req = {}) => ({ user: { id: `u-${role.replace(" ", "-")}` }, db: w.db, store: w.store, params: {}, query: {}, headers: {}, ...req });
const receiptBody = (o = {}) => ({ stock_item_id: "si-1", movement_type: "in", quantity: 5, reason: "Delivery received", reference_type: "supplier", reference_id: "sup-1", source_document_ref: "DN-7781", ...o });
const post = (w, role, body, headers = {}) => { const r = res(); recordStockMovement(as(w, role, { body, headers }), r); return r; };
const materials = (w, role, body, headers = {}) => { const r = res(); addMaterialUsage(as(w, role, { params: { id: "d-1" }, body, headers }), r); return r; };
const usageBody = (o = {}) => ({ catalog_item_id: "cat-1", description: "Gasket", quantity_used: 2, unit_cost: 5, ...o });

// ── Receipt ──────────────────────────────────────────────────────────────────
test("receipt: cites a registered supplier and a source document, raises stock once, and records actor and before/after", () => {
  const w = world();
  const r = post(w, "Operations", receiptBody());
  assert.equal(r.statusCode, 200);
  const m = r.body.data.movement;
  assert.equal(m.quantity, 5);
  assert.equal(m.quantity_before, 10);
  assert.equal(m.quantity_after, 15);
  assert.equal(m.unit_of_measure, "each");
  assert.equal(m.reference_type, "supplier");
  assert.equal(m.reference_label, "Supplier receipt — Fictional Supplies Ltd");
  assert.equal(m.source_document_ref, "DN-7781");
  assert.equal(m.actor_id, "u-Operations");
  assert.ok(m.created_at);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 15);
  assert.equal(w.db.stock_movements.length, 1);
  assert.equal("idempotency_fingerprint" in m, false, "internal bookkeeping never leaves the API");
});

test("receipt without any source is refused and changes nothing", () => {
  const w = world();
  const r = post(w, "Operations", receiptBody({ reference_type: undefined, reference_id: undefined, source_document_ref: undefined }));
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /supplier and a source document/);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(w.db.stock_movements.length, 0);
});

test("receipt naming an unknown supplier, or lacking the source document, is refused", () => {
  const w = world();
  assert.equal(post(w, "Operations", receiptBody({ reference_id: "sup-missing" })).statusCode, 400);
  assert.equal(RECEIPT_REQUIRES_SOURCE_DOCUMENT, true);
  assert.equal(post(w, "Operations", receiptBody({ source_document_ref: "   " })).statusCode, 400);
  assert.equal(w.db.stock_movements.length, 0);
});

test("a CLIENT purchase order is never accepted as supplier purchase evidence for a receipt", () => {
  const w = world({ purchase_orders: [{ id: "po-1", po_reference: "CLIENT-PO-1", quotation_id: "q-1" }] });
  const r = post(w, "Operations", receiptBody({ reference_type: "purchase_order", reference_id: "po-1" }));
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /Client purchase orders are not supplier purchase evidence/);
  assert.equal(w.db.stock_movements.length, 0);
});

test("a stock increase cannot masquerade as scrap, a dispatch issue or worksheet use", () => {
  const w = world();
  for (const reference_type of ["scrap", "dispatch_card", "material_usage"]) {
    const r = post(w, "Operations", receiptBody({ reference_type, reference_id: "d-1" }));
    assert.ok([400, 409].includes(r.statusCode), reference_type);
  }
  assert.equal(w.db.stock_movements.length, 0);
});

// ── Issue / use ──────────────────────────────────────────────────────────────
test("issue: a manual issue decreases stock with a negative signed quantity in the item's unit", () => {
  const w = world();
  const r = post(w, "Operations", { stock_item_id: "si-1", movement_type: "out", quantity: 3, reason: "Issued to workshop" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.data.movement.quantity, -3);
  assert.equal(r.body.data.movement.direction, "decrease");
  assert.equal(w.db.stock_items[0].quantity_on_hand, 7);
});

test("manual movements can never claim worksheet material usage as their reference", () => {
  const w = world();
  const r = post(w, "Operations", { stock_item_id: "si-1", movement_type: "out", quantity: 1, reason: "fake use", reference_type: "material_usage", reference_id: "mu-x" });
  assert.equal(r.statusCode, 409);
  assert.equal(w.db.stock_movements.length, 0);
});

test("use on a dispatch: exactly one deduction, linked to the usage record, labelled with the dispatch (not '(not found)')", () => {
  const w = world();
  const r = materials(w, "Technician", usageBody({ quantity_used: 2 }));
  assert.equal(r.statusCode, 200);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 8);
  assert.equal(w.db.stock_movements.length, 1);
  const m = w.db.stock_movements[0];
  assert.equal(m.reference_type, "material_usage");
  assert.equal(m.reference_id, w.db.material_usage[0].id);
  assert.equal(m.reference_label, "Material usage on dispatch JOB-0001");
  assert.equal(m.quantity, -2);
  assert.equal(m.actor_id, "u-Technician");
});

// ── Return ───────────────────────────────────────────────────────────────────
test("return: increases stock, links to the dispatch, and cannot exceed what that dispatch used", () => {
  const w = world();
  materials(w, "Technician", usageBody({ quantity_used: 4 }));
  const ok = post(w, "Operations", { stock_item_id: "si-1", movement_type: "in", quantity: 3, reason: "Unused, returned", reference_type: "return", reference_id: "d-1" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.movement.quantity, 3);
  assert.equal(ok.body.data.movement.reference_label, "Return — Dispatch JOB-0001 — Fictional Mine A");
  const tooMuch = post(w, "Operations", { stock_item_id: "si-1", movement_type: "in", quantity: 2, reason: "second return", reference_type: "return", reference_id: "d-1" });
  assert.equal(tooMuch.statusCode, 409);
  assert.match(tooMuch.body.message, /used 4, already returned 3/);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10 - 4 + 3);
});

test("return of an item that was never used on that dispatch is refused", () => {
  const w = world();
  const r = post(w, "Operations", { stock_item_id: "si-1", movement_type: "in", quantity: 1, reason: "return", reference_type: "return", reference_id: "d-1" });
  assert.equal(r.statusCode, 409);
});

test("a return can only increase stock", () => {
  const w = world();
  assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "out", quantity: 1, reason: "x", reference_type: "return", reference_id: "d-1" }).statusCode, 400);
  assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "adjustment", quantity: -1, reason: "x", reference_type: "return", reference_id: "d-1" }).statusCode, 400);
});

// ── Scrap and correction ─────────────────────────────────────────────────────
test("scrap: must decrease stock, as out or as a negative correction, and never as an increase", () => {
  const w = world();
  assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "out", quantity: 1, reason: "Damaged", reference_type: "scrap" }).statusCode, 200);
  const viaAdj = post(w, "Operations", { stock_item_id: "si-1", movement_type: "adjustment", quantity: -1, reason: "Damaged", reference_type: "scrap" });
  assert.equal(viaAdj.statusCode, 200);
  assert.equal(viaAdj.body.data.movement.reference_label, "Scrap / write-off");
  assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "adjustment", quantity: 2, reason: "up", reference_type: "scrap" }).statusCode, 400);
  assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "in", quantity: 2, reason: "up", reference_type: "scrap" }).statusCode, 400);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 8);
});

test("correction: a signed adjustment is a new movement and earlier history is untouched", () => {
  const w = world();
  post(w, "Operations", receiptBody());
  const before = JSON.stringify(w.db.stock_movements[0]);
  const r = post(w, "Operations", { stock_item_id: "si-1", movement_type: "adjustment", quantity: -2, reason: "Recount found 2 fewer" });
  assert.equal(r.statusCode, 200);
  assert.equal(w.db.stock_movements.length, 2);
  assert.equal(JSON.stringify(w.db.stock_movements[0]), before);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 13);
});

test("a correction cannot be labelled as a receipt, return or client PO", () => {
  const w = world();
  for (const reference_type of ["supplier", "return", "purchase_order"]) {
    assert.equal(post(w, "Operations", { stock_item_id: "si-1", movement_type: "adjustment", quantity: 1, reason: "x", reference_type, reference_id: "sup-1" }).statusCode, 400, reference_type);
  }
});

// ── Insufficient stock and override ──────────────────────────────────────────
test("insufficient stock: refused with no balance or ledger change, for both manual and worksheet paths", () => {
  const w = world();
  const manual = post(w, "Operations", { stock_item_id: "si-1", movement_type: "out", quantity: 11, reason: "too many" });
  assert.equal(manual.statusCode, 409);
  const use = materials(w, "Technician", usageBody({ quantity_used: 11 }));
  assert.equal(use.statusCode, 409);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(w.db.stock_movements.length, 0);
  assert.equal(w.db.material_usage.length, 0, "no orphan usage record is left behind");
});

test("unauthorized override: only Admin or Operations may force negative stock, on both paths", () => {
  const w0 = world();
  const mgmt = post(w0, "Management", { stock_item_id: "si-1", movement_type: "out", quantity: 11, reason: "force", override_negative: true });
  assert.equal(mgmt.statusCode, 403, "Management holds manageInventory but not the override");
  assert.equal(w0.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(w0.db.stock_movements.length, 0);
  assert.throws(() => post(w0, "Supervisor", { stock_item_id: "si-1", movement_type: "out", quantity: 11, reason: "force", override_negative: true }), (e) => e.status === 403);
  const w = world();
  assert.equal(materials(w, "Technician", usageBody({ quantity_used: 11, override_negative: true })).statusCode, 403);
  assert.equal(w.db.stock_movements.length, 0);
  const admin = post(world(), "Admin", { stock_item_id: "si-1", movement_type: "out", quantity: 11, reason: "authorised", override_negative: true });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.body.data.movement.override_negative, true);
  assert.equal(admin.body.data.movement.quantity_after, -1);
});

// ── Duplicate submission ─────────────────────────────────────────────────────
test("duplicate submission: same key and payload records ONE movement; a different payload with the same key is refused", () => {
  const w = world();
  const key = "key-receipt-0001";
  const first = post(w, "Operations", { ...receiptBody(), idempotency_key: key });
  const again = post(w, "Operations", { ...receiptBody(), idempotency_key: key });
  assert.equal(first.statusCode, 200);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.idempotent_replay, true);
  assert.equal(again.body.data.movement.id, first.body.data.movement.id);
  assert.equal(w.db.stock_movements.length, 1);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 15);
  const different = post(w, "Operations", { ...receiptBody({ quantity: 9 }), idempotency_key: key });
  assert.equal(different.statusCode, 409);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 15);
});

test("the Idempotency-Key header works, keys are per user, and a malformed key is rejected", () => {
  const w = world();
  const a = post(w, "Operations", receiptBody(), { "idempotency-key": "hdr-key-000001" });
  const b = post(w, "Operations", receiptBody(), { "idempotency-key": "hdr-key-000001" });
  assert.equal(b.body.idempotent_replay, true);
  assert.equal(w.db.stock_movements.length, 1);
  const other = post(w, "Admin", receiptBody(), { "idempotency-key": "hdr-key-000001" });
  assert.notEqual(other.body.idempotent_replay, true, "another user's key is a different request");
  assert.equal(w.db.stock_movements.length, 2);
  assert.equal(post(w, "Operations", { ...receiptBody(), idempotency_key: "short" }).statusCode, 400);
  assert.ok(a.body.success);
});

test("duplicate worksheet submission with the same key deducts stock and records usage once", () => {
  const w = world();
  const key = "usage-key-000001";
  const first = materials(w, "Technician", usageBody({ idempotency_key: key }));
  const again = materials(w, "Technician", usageBody({ idempotency_key: key }));
  assert.equal(first.statusCode, 200);
  assert.equal(again.body.idempotent_replay, true);
  assert.equal(again.body.data.id, first.body.data.id);
  assert.equal(w.db.material_usage.length, 1);
  assert.equal(w.db.stock_movements.length, 1);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 8);
  assert.equal("idempotency_fingerprint" in again.body.data, false);
  assert.equal(materials(w, "Technician", usageBody({ idempotency_key: key, quantity_used: 5 })).statusCode, 409);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 8);
});

test("Chat D worksheet deduction and the Chat G ledger compose without double deduction", () => {
  const w = world();
  materials(w, "Technician", usageBody({ quantity_used: 3 }));
  assert.equal(w.db.stock_items[0].quantity_on_hand, 7);
  const rec = buildReconciliation(w.db);
  assert.equal(rec.items[0].status, "reconciled");
  assert.equal(rec.items[0].by_category.worksheet_use.count, 1);
  assert.equal(rec.items[0].by_category.worksheet_use.net_quantity, -3);
  assert.equal(rec.system_exceptions.length, 0);
});

test("worksheet usage with a unit that differs from the stock item's unit is refused; the same unit is accepted", () => {
  const w = world();
  const bad = materials(w, "Technician", usageBody({ unit_of_measure: "kg" }));
  assert.equal(bad.statusCode, 409);
  assert.match(bad.body.message, /never converted/);
  assert.equal(w.db.stock_items[0].quantity_on_hand, 10);
  assert.equal(materials(w, "Technician", usageBody({ unit_of_measure: "Each" })).statusCode, 200);
});

// ── Per-item history, opening balance ────────────────────────────────────────
test("per-item history returns only that item's movements with every traceability field", () => {
  const w = world();
  w.db.stock_items.push({ id: "si-2", catalog_item_id: null, item_code: "BLT-1", item_name: "Bolt", unit_of_measure: "kg", quantity_on_hand: 4, reorder_level: 0 });
  post(w, "Operations", receiptBody());
  post(w, "Operations", { stock_item_id: "si-2", movement_type: "out", quantity: 1, reason: "other item" });
  materials(w, "Technician", usageBody());
  const r = res();
  getStockItemMovements(as(w, "Operations", { params: { id: "si-1" } }), r);
  const rows = r.body.data.movements;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((m) => m.stock_item_id === "si-1"));
  for (const m of rows) {
    for (const f of ["item_code", "item_name", "movement_type", "quantity", "unit_of_measure", "quantity_before", "quantity_after", "created_at", "actor_id", "actor_name", "reason", "reference_type", "reference_id", "reference_label"]) {
      assert.ok(m[f] !== undefined && m[f] !== null && m[f] !== "", `history row missing ${f}`);
    }
  }
  const chain = [...rows].reverse();
  assert.equal(chain[0].quantity_after, chain[1].quantity_before, "before/after chain is continuous");
});

test("opening balance is its own movement type, has no supplier or source document, and is not a purchase", () => {
  const w = world({ stock_items: [], stock_movements: [] });
  const r = res();
  createStockItem(as(w, "Operations", { body: { item_code: "NEW-1", item_name: "New", unit_of_measure: "each", quantity_on_hand: 6 } }), r);
  assert.equal(r.statusCode, 200);
  const m = w.db.stock_movements[0];
  assert.equal(m.reference_type, "opening_balance");
  assert.equal(m.reference_label, "Opening balance at registration");
  assert.equal(m.source_document_ref, null);
  assert.equal(m.quantity_before, 0);
  const rec = buildReconciliation(w.db);
  assert.equal(rec.items[0].by_category.opening_balance.net_quantity, 6);
  assert.equal(rec.items[0].by_category.supplier_receipt, undefined, "an opening balance is not counted as a purchase receipt");
  assert.equal(rec.items[0].status, "reconciled");
  const forged = post(w, "Operations", { stock_item_id: w.db.stock_items[0].id, movement_type: "in", quantity: 1, reason: "x", reference_type: "opening_balance" });
  assert.notEqual(forged.statusCode, 200, "opening balances cannot be posted through the manual endpoint");
});

// ── Reconciliation ───────────────────────────────────────────────────────────
test("reconciliation reports drift, unexplained stock, unsourced receipts and unmatched returns without repairing anything", () => {
  const w = world();
  w.db.stock_movements.push(
    { id: "m1", stock_item_id: "si-1", movement_type: "in", direction: "increase", quantity: 10, quantity_before: 0, quantity_after: 10, unit_of_measure: "each", reason: "legacy", reference_type: null, reference_id: null, override_negative: false, actor_id: "u-Admin", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", stock_item_id: "si-1", movement_type: "in", direction: "increase", quantity: 1, quantity_before: 10, quantity_after: 11, unit_of_measure: "each", reason: "ret", reference_type: "return", reference_id: "nowhere", override_negative: false, actor_id: "u-Admin", created_at: "2026-01-02T00:00:00Z" }
  );
  w.db.stock_items.push({ id: "si-3", item_code: "X", item_name: "Loose", unit_of_measure: "each", quantity_on_hand: 5, reorder_level: 0 });
  const snapshot = JSON.stringify(w.db);
  const r = res();
  getInventoryReconciliation(as(w, "Operations"), r);
  const codes = (id) => r.body.data.items.find((i) => i.stock_item_id === id).exceptions.map((e) => e.code);
  assert.ok(codes("si-1").includes("ONHAND_DRIFT"));
  assert.ok(codes("si-1").includes("UNSOURCED_RECEIPT"));
  assert.ok(codes("si-1").includes("UNMATCHED_RETURN"));
  assert.ok(codes("si-3").includes("UNEXPLAINED_STOCK"));
  assert.equal(JSON.stringify(w.db), snapshot, "reconciliation is read-only");
});

test("reconciliation never sums across units: mixed units are flagged and totals kept per unit", () => {
  const w = world();
  w.db.stock_movements.push(
    { id: "m1", stock_item_id: "si-1", movement_type: "in", direction: "increase", quantity: 10, quantity_before: 0, quantity_after: 10, unit_of_measure: "each", reason: "r", reference_type: "opening_balance", override_negative: false, actor_id: "u-Admin", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", stock_item_id: "si-1", movement_type: "out", direction: "decrease", quantity: -500, quantity_before: 10, quantity_after: -490, unit_of_measure: "g", reason: "r", reference_type: null, override_negative: true, actor_id: "u-Admin", created_at: "2026-01-02T00:00:00Z" }
  );
  const item = buildReconciliation(w.db).items[0];
  assert.ok(item.exceptions.some((e) => e.code === "MIXED_UNITS"));
  assert.ok(item.exceptions.some((e) => e.code === "UNIT_MISMATCH"));
  assert.deepEqual(item.by_unit, { each: 10, g: -500 });
  assert.equal(item.movement_sum, 10, "only movements in the item's own unit are summed");
});

test("reconciliation flags a duplicated worksheet deduction and usage that never reached the ledger", () => {
  const w = world();
  w.db.material_usage.push({ id: "mu-1", dispatch_card_id: "d-1", catalog_item_id: "cat-1", quantity_used: 1 }, { id: "mu-2", dispatch_card_id: "d-1", catalog_item_id: "cat-1", quantity_used: 1 });
  const mv = (id, before, after) => ({ id, stock_item_id: "si-1", movement_type: "out", direction: "decrease", quantity: -1, quantity_before: before, quantity_after: after, unit_of_measure: "each", reason: "u", reference_type: "material_usage", reference_id: "mu-1", override_negative: false, actor_id: "u-Admin", created_at: `2026-01-0${before}T00:00:00Z` });
  w.db.stock_movements.push(mv("a", 1, 0));
  w.db.stock_movements[0].quantity_before = 10; w.db.stock_movements[0].quantity_after = 9;
  w.db.stock_movements.push({ ...mv("b", 2, 0), quantity_before: 9, quantity_after: 8 });
  w.db.stock_items[0].quantity_on_hand = 8;
  const rec = buildReconciliation(w.db);
  assert.ok(rec.items[0].exceptions.some((e) => e.code === "DOUBLE_DEDUCTION"));
  assert.ok(rec.system_exceptions.some((e) => e.code === "USAGE_WITHOUT_MOVEMENT" && e.material_usage_id === "mu-2"));
});

test("reconciliation can be scoped to one item and 404s for an unknown item", () => {
  const w = world();
  const ok = res(); getInventoryReconciliation(as(w, "Operations", { query: { stock_item_id: "si-1" } }), ok);
  assert.equal(ok.body.data.items.length, 1);
  const missing = res(); getInventoryReconciliation(as(w, "Operations", { query: { stock_item_id: "nope" } }), missing);
  assert.equal(missing.statusCode, 404);
});

// ── Client isolation and role scope ──────────────────────────────────────────
test("client isolation: Client Viewer and every non-inventory role are refused on every stock endpoint, whatever ids they send", () => {
  const w = world();
  post(w, "Operations", receiptBody());
  const denied = ["Client Viewer", "Sales", "Finance", "Technician", "Supervisor"];
  const calls = {
    record: (role) => recordStockMovement(as(w, role, { body: receiptBody() }), res()),
    create: (role) => createStockItem(as(w, role, { body: { item_code: "Z", item_name: "Z", unit_of_measure: "each" } }), res()),
    ledger: (role) => getStockMovements(as(w, role, { query: { client_id: "c-2" } }), res()),
    history: (role) => getStockItemMovements(as(w, role, { params: { id: "si-1" } }), res()),
    reconciliation: (role) => getInventoryReconciliation(as(w, role), res()),
    lowStock: (role) => getLowStockReport(as(w, role), res())
  };
  for (const role of denied) for (const [name, call] of Object.entries(calls)) {
    assert.throws(call.bind(null, role), (e) => e.status === 403, `${role} must be refused on ${name}`);
  }
  assert.equal(w.db.stock_movements.length, 1, "refused calls wrote nothing");
});

test("inactive inventory users are refused, and Management may read but its override is still refused", () => {
  const w = world();
  w.db.users.find((u) => u.role === "Operations").is_active = false;
  assert.throws(() => recordStockMovement(as(w, "Operations", { body: receiptBody() }), res()), (e) => e.status === 403);
  const r = res(); getInventoryReconciliation(as(w, "Management"), r);
  assert.equal(r.statusCode, 200);
});

// ── Source-level guards ──────────────────────────────────────────────────────
test("the reconciliation route is wired, read-only, and no route edits or deletes a movement", () => {
  const router = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");
  assert.match(router, /router\.get\("\/inventory\/reconciliation", getInventoryReconciliation\)/);
  assert.doesNotMatch(router, /router\.(patch|put|delete)\("\/inventory\/(movements|reconciliation)/);
});

test("quantity_on_hand is still mutated only inside applyStockChange (Task 02 added no second path)", () => {
  for (const file of ["src/inventoryLedger.js", "src/controllers/inventoryController.js", "src/controllers/dispatchController.js"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const writes = text.match(/\.quantity_on_hand\s*(=[^=]|\+=|-=)/g) || [];
    if (file === "src/inventoryLedger.js") assert.equal(writes.length, 1, "only applyStockChange assigns quantity_on_hand");
    else if (file === "src/controllers/inventoryController.js") assert.equal(writes.length, 0, "createStockItem sets the opening quantity in an object literal, not by assignment");
    else assert.equal(writes.length, 0);
  }
});

// ── Added in continuation: audit hygiene, legacy data, generic reads ─────────
import { getCollection } from "../src/controllers/coreController.js";
import { buildCuratedDemoData } from "../src/curatedDemoData.js";

test("audit entries never carry the internal payload fingerprint (manual movement and worksheet usage)", () => {
  const w = world();
  const audits = [];
  // audit(db, actor, entity, id, action, old, new): skip the db argument, which legitimately holds the stored records.
  w.store.audit = (_db, ...args) => audits.push(args);
  post(w, "Operations", { ...receiptBody(), idempotency_key: "audit-key-0001" });
  materials(w, "Technician", usageBody({ idempotency_key: "audit-key-0002" }));
  assert.ok(audits.length >= 3);
  assert.equal(JSON.stringify(audits).includes("idempotency_fingerprint"), false);
  assert.equal(JSON.stringify(audits).includes("audit-key-0001"), true, "the readable key is kept for traceability");
});

test("the generic stock_movements read never exposes the fingerprint, and Client Viewer/field roles are still refused", () => {
  const w = world();
  post(w, "Operations", { ...receiptBody(), idempotency_key: "read-key-0001" });
  const ok = res();
  getCollection("stock_movements")(as(w, "Operations"), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.length, 1);
  assert.equal(JSON.stringify(ok.body).includes("idempotency_fingerprint"), false);
  for (const role of ["Client Viewer", "Sales", "Finance", "Technician", "Supervisor"]) {
    const r = res();
    getCollection("stock_movements")(as(w, role), r);
    assert.equal(r.statusCode, 403, role);
  }
});

test("reconciliation reports pre-ledger (legacy) records as incomplete instead of inventing balances or units", () => {
  const demo = buildCuratedDemoData([]);
  const snapshot = JSON.stringify(demo.stock_movements);
  const rec = buildReconciliation(demo);
  const legacy = rec.items.filter((i) => i.exceptions.some((e) => e.code === "LEGACY_INCOMPLETE_MOVEMENT"));
  assert.ok(legacy.length >= 1);
  for (const item of rec.items) {
    assert.equal(item.exceptions.some((e) => ["UNIT_MISMATCH", "SUM_MISMATCH", "BALANCE_MATH", "CHAIN_BREAK"].includes(e.code)), false, `${item.item_code}: no false arithmetic findings on legacy data`);
  }
  assert.ok(rec.items.some((i) => i.exceptions.some((e) => e.code === "UNEXPLAINED_STOCK")), "stock with no movement is still reported");
  assert.equal(JSON.stringify(demo.stock_movements), snapshot, "reconciliation never edits records");
});

test("a Client Viewer asking for another client's history by id, query or reference gets nothing (403) and the ledger is unchanged", () => {
  const w = world();
  materials(w, "Technician", usageBody());
  const before = JSON.stringify(w.db);
  for (const query of [{ client_id: "c-2" }, { client_id: "c-1" }, { stock_item_id: "si-1" }, { reference_type: "material_usage" }]) {
    assert.throws(() => getStockMovements(as(w, "Client Viewer", { query }), res()), (e) => e.status === 403);
  }
  assert.throws(() => getStockItemMovements(as(w, "Client Viewer", { params: { id: "si-1" } }), res()), (e) => e.status === 403);
  assert.equal(JSON.stringify(w.db), before);
});

test("a receipt on an item whose unit differs from earlier movements is not silently summed in reconciliation", () => {
  const w = world();
  post(w, "Operations", receiptBody());
  w.db.stock_items[0].unit_of_measure = "kg"; // simulates a unit edit that bypassed the controller guard
  const item = buildReconciliation(w.db).items[0];
  assert.ok(item.exceptions.some((e) => e.code === "UNIT_MISMATCH"));
  assert.equal(item.movement_sum, 0, "movements in another unit are not added to the item's own total");
});
