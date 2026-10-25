import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { issueLegacyInvoice, transitionQuote } from "../src/stateMachine.js";
import { permissions } from "../src/permissions.js";
import { recordStockMovement } from "../src/controllers/inventoryController.js";

// SEAM GUARD for the unresolved "direct client stock sale" workflow.
// ORAC has no such module today. Commercial (Chat C) and inventory-ledger
// (Chat G) work must land as ONE joined workflow, defined in
// DIRECT_STOCK_SALE_JOINT_CONTRACT.md, not as two partial implementations.
// These tests pin today's behaviour so that nobody fakes a sale through the
// service-work path, and so that adding a sale concept forces the contract to
// be updated deliberately. If one fails because the joined workflow was
// implemented on purpose, update the contract and this file together.

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function makeDb() {
  const store = createStore(":memory:");
  const db = {
    users: [
      { id: "u_admin", role: "Admin", is_active: true },
      { id: "u_ops", role: "Operations", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client" }],
    quote_lines: [{ id: "l1", quotation_id: "q1", description: "50 x bearing units (goods only)", quantity: 50, unit_price: 10, line_total: 500 }],
    quotes: [{ id: "q1", quote_number: "Q-1", client_id: "c1", status: "Draft", total_amount: 500 }],
    purchase_orders: [], dispatch_cards: [], field_worksheets: [], timesheets: [], material_usage: [],
    invoices: [], invoice_lines: [], audit_logs: [], stock_movements: [],
    stock_items: [{ id: "si1", item_code: "BRG-1", quantity_on_hand: 100, unit_of_measure: "each", reorder_level: 10 }]
  };
  return { db, store };
}

test("a goods-only quote cannot be invoiced: the invoice gate needs a dispatch card and an approved worksheet", () => {
  const { db, store } = makeDb();
  const admin = db.users[0];
  transitionQuote(db, store, "q1", "Sent", {}, admin);
  transitionQuote(db, store, "q1", "Approved_Pending_PO", {}, admin);
  db.purchase_orders.push({ id: "po1", quotation_id: "q1", po_reference: "PO-1", po_amount: 500, status: "verified", requires_amendment: false });
  transitionQuote(db, store, "q1", "PO_Verified", {}, admin);
  assert.throws(() => issueLegacyInvoice(db, store, "q1", admin), /Illegal transition/, "no shortcut from PO_Verified to Invoiced");
  // The only way forward is a service dispatch, and even then the invoice is
  // blocked until a supervisor approves a field worksheet. A goods-only sale
  // has neither, which is exactly the gap the joint contract must close.
  transitionQuote(db, store, "q1", "Field_Dispatch", {}, db.users[1]);
  assert.throws(() => issueLegacyInvoice(db, store, "q1", admin), /supervisor-approved worksheet is required/);
  assert.equal(db.invoices.length, 0);
});

test("recording a stock movement never creates or changes a quote, PO, dispatch or invoice", () => {
  const { db, store } = makeDb();
  const before = JSON.stringify({ q: db.quotes, po: db.purchase_orders, d: db.dispatch_cards, i: db.invoices });
  let payload;
  recordStockMovement(
    { db, store, user: { id: "u_ops" }, body: { stock_item_id: "si1", movement_type: "out", quantity: 5, reason: "Issued to client", reference_id: "q1" } },
    { json: (value) => { payload = value; }, status() { return this; } }
  );
  assert.equal(payload.success, true);
  assert.equal(db.stock_items[0].quantity_on_hand, 95);
  assert.equal(db.stock_movements[0].reference_id, "q1", "reference_id is only a label today");
  assert.equal(JSON.stringify({ q: db.quotes, po: db.purchase_orders, d: db.dispatch_cards, i: db.invoices }), before);
});

test("no active sale, delivery or collection workflow exists; the legacy direct-sale stock endpoint remains explicitly dormant", () => {
  const banned = /sales?_order|stock_sale|delivery_note|collection_note|goods_issue|counter_sale/i;
  assert.equal(Object.keys(permissions).some((key) => banned.test(key)), false, "a sale permission appeared: update DIRECT_STOCK_SALE_JOINT_CONTRACT.md");
  for (const file of ["src/router.js", "src/schemas.js", "src/controllers/coreController.js"]) {
    assert.doesNotMatch(read(file), banned, `${file} gained a sale concept: implement it as the single joined workflow and update the contract`);
  }
  const inventory = read("src/controllers/inventoryController.js");
  assert.match(inventory, /process\.env\.ENABLE_DIRECT_SALE_STOCK_ISSUE !== "true"/);
  assert.match(inventory, /not enabled/);
});
