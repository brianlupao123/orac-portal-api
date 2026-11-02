import test from "node:test";
import assert from "node:assert/strict";
import { createStore, normalizeDb } from "../src/store.js";
import {
  acknowledgeInternalWorkRequest, createInternalWorkRequest, listInternalWorkRequestInbox, listInternalWorkRequestOutbox, transitionInternalWorkRequest
} from "../src/controllers/internalWorkRequestsController.js";

// Runs the workflow against the real in-memory store: real seed data, the real
// central audit() and whatever audit-triggered behaviour notifications.js has.
// It proves the request produces audit events plus exactly the expected
// content-free notifications (Task 01 owner decision), and nothing else.

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function call(handler, db, store, userId, { body, params, query } = {}) {
  const res = response();
  handler({ db, store, user: { id: userId }, body, params: params || {}, query: query || {} }, res);
  return res;
}

test("full workflow on the seeded ORAC data writes the central audit trail, exactly the expected notifications, and nothing else", async () => {
  const store = createStore(":memory:");
  const { db, release } = await store.read();
  try {
    assert.ok(Array.isArray(db.internal_work_requests), "the store seeds an empty collection");
    const sales = db.users.find((user) => user.role === "Sales");
    const operations = db.users.find((user) => user.role === "Operations");
    const finance = db.users.find((user) => user.role === "Finance");
    assert.ok(sales && operations && finance, "seed must provide Sales, Operations and Finance users");

    // Seed has no quotes; add one and a stock item snapshot to prove they are untouched.
    db.quotes.push({ id: "q_real", quote_number: "Q-0001", client_id: db.clients[0].id, status: "Sent", sales_owner_id: sales.id });
    const stockBefore = JSON.stringify(db.stock_items);
    const before = {
      notifications: db.notifications.length, quotes: JSON.stringify(db.quotes), purchase_orders: db.purchase_orders.length,
      dispatch_cards: db.dispatch_cards.length, invoices: db.invoices.length, leads: db.leads.length, stock_movements: db.stock_movements.length,
      timesheets: db.timesheets.length, audits: db.audit_logs.length
    };

    const created = call(createInternalWorkRequest, db, store, sales.id, {
      body: { request_type: "STOCK_AVAILABILITY", subject: "Availability for Q-0001", description: "Need 10 m2 of rubber lining.", recipient_role: "Operations", related_entity_type: "quote", related_entity_id: "q_real" }
    });
    assert.equal(created.statusCode, 201);
    const id = created.body.data.id;
    assert.match(id, /^iwr_/);

    assert.equal(call(listInternalWorkRequestInbox, db, store, operations.id).body.data.length, 1);
    assert.equal(call(listInternalWorkRequestOutbox, db, store, sales.id).body.data.length, 1);
    assert.equal(call(acknowledgeInternalWorkRequest, db, store, operations.id, { params: { id } }).statusCode, 200);
    assert.equal(call(transitionInternalWorkRequest, db, store, operations.id, { params: { id }, body: { action: "start" } }).statusCode, 200);
    assert.equal(call(transitionInternalWorkRequest, db, store, operations.id, { params: { id }, body: { action: "complete", note: "48 m2 on hand - reserve confirmed." } }).statusCode, 200);

    assert.deepEqual(db.audit_logs.slice(before.audits).map((entry) => entry.action), [
      "INTERNAL_WORK_REQUEST_CREATED", "INTERNAL_WORK_REQUEST_ACKNOWLEDGED", "INTERNAL_WORK_REQUEST_STARTED", "INTERNAL_WORK_REQUEST_COMPLETED"
    ]);
    assert.ok(db.audit_logs.slice(before.audits).every((entry) => /^audit_/.test(entry.id) && entry.entity_id === id && entry.created_at));
    // Task 01: created -> Operations inbox (role copy, requester excluded); acknowledge, start
    // and complete -> the requester only. Nothing carries subject, description or note text.
    const added = db.notifications.slice(before.notifications);
    assert.equal(added.length, 4);
    assert.deepEqual(added[0].target_roles, ["Operations"]);
    assert.deepEqual(added[0].exclude_user_ids, [sales.id]);
    assert.deepEqual(added.slice(1).map((item) => item.user_id), [sales.id, sales.id, sales.id]);
    assert.ok(added.every((item) => item.destination?.kind === "internal_work_request" && item.destination.id === id));
    const serialisedNotifications = JSON.stringify(added);
    for (const secret of ["Need 10 m2", "reserve confirmed", "Availability for Q-0001"]) {
      assert.equal(serialisedNotifications.includes(secret), false, `notification must not copy "${secret}"`);
    }
    assert.equal(JSON.stringify(db.stock_items), stockBefore, "stock is never moved");
    assert.equal(JSON.stringify(db.quotes), before.quotes, "the quote is never edited");
    for (const key of ["purchase_orders", "dispatch_cards", "invoices", "leads", "stock_movements", "timesheets"]) assert.equal(db[key].length, before[key], `${key} must not change`);
    const serialised = JSON.stringify(db.audit_logs.slice(before.audits));
    assert.equal(serialised.includes("Need 10 m2"), false);
    assert.equal(serialised.includes("reserve confirmed"), false);
  } finally {
    store.release(release);
  }
});

test("the persisted aggregate gains an empty internal_work_requests array without touching existing data", () => {
  const fresh = normalizeDb({ users: [] });
  assert.ok(Array.isArray(fresh.internal_work_requests));
  assert.equal(fresh.internal_work_requests.length, 0);

  const existing = { id: "iwr_keep", request_type: "STOCK_AVAILABILITY", status: "Acknowledged" };
  const kept = normalizeDb({ users: [], internal_work_requests: [existing] });
  assert.deepEqual(kept.internal_work_requests, [existing]);

  const repaired = normalizeDb({ users: [], internal_work_requests: "corrupt" });
  assert.deepEqual(repaired.internal_work_requests, []);
  assert.ok(Array.isArray(normalizeDb({ users: [] }).service_requests), "the client service request collection is unaffected");
});
