import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import {
  createServiceRequest, listOwnServiceRequests, listServiceRequestTriageQueue,
  triageServiceRequest, convertServiceRequestToLead
} from "../src/controllers/serviceRequestsController.js";

// Runs the full workflow against the real in-memory store: real seed data and
// the real central audit(), including whatever audit-triggered behaviour
// notifications.js implements. It proves audit events and the seeded
// mine-site -> plant -> section -> equipment hierarchy, and that the workflow
// produces no notifications and no other business documents.

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function call(handler, db, store, userId, { body, params, query } = {}) {
  const res = response();
  handler({ db, store, user: { id: userId }, body, params: params || {}, query: query || {} }, res);
  return res;
}

test("full workflow on the seeded ORAC data writes the central audit trail and triggers nothing else", async () => {
  const store = createStore(":memory:");
  const { db, release } = await store.read();
  try {
    const client = db.users.find((user) => user.role === "Client Viewer" && user.client_id);
    const sales = db.users.find((user) => user.role === "Sales");
    const operations = db.users.find((user) => user.role === "Operations");
    assert.ok(client && sales && operations, "seed must provide a scoped Client Viewer, Sales and Operations");

    const site = db.mine_sites.find((item) => item.client_id === client.client_id);
    const plant = db.plants.find((item) => item.mine_site_id === site.id);
    const section = db.plant_sections.find((item) => item.plant_id === plant.id);
    const tag = db.equipment_tags.find((item) => item.plant_section_id === section.id);
    const otherSite = db.mine_sites.find((item) => item.client_id !== client.client_id);

    const before = {
      notifications: db.notifications.length, quotes: db.quotes.length, purchase_orders: db.purchase_orders.length,
      dispatch_cards: db.dispatch_cards.length, invoices: db.invoices.length, leads: db.leads.length, audits: db.audit_logs.length
    };

    const crossClient = call(createServiceRequest, db, store, client.id, { body: { title: "Bad", service_need: "Bad", mine_site_id: otherSite.id } });
    assert.equal(crossClient.statusCode, 400);

    const created = call(createServiceRequest, db, store, client.id, {
      body: { title: "Seeded request", service_need: "Inspect seeded equipment.", urgency: "urgent_downtime", mine_site_id: site.id, equipment_tag_id: tag.id, requested_date: "2026-10-05" }
    });
    assert.equal(created.statusCode, 201);
    const id = created.body.data.id;
    assert.match(id, /^sr_/);

    assert.equal(call(listOwnServiceRequests, db, store, client.id).body.data.length, 1);
    assert.equal(call(listServiceRequestTriageQueue, db, store, sales.id, { query: { status: "Submitted" } }).body.data.length, 1);
    assert.equal(call(triageServiceRequest, db, store, sales.id, { params: { id }, body: { decision: "acknowledge" } }).statusCode, 200);
    assert.equal(call(triageServiceRequest, db, store, operations.id, { params: { id }, body: { decision: "accept" } }).statusCode, 200);
    const converted = call(convertServiceRequestToLead, db, store, sales.id, { params: { id } });
    assert.equal(converted.statusCode, 201);
    assert.equal(call(convertServiceRequestToLead, db, store, sales.id, { params: { id } }).statusCode, 409);

    assert.equal(db.leads.length, before.leads + 1);
    assert.equal(db.leads.at(-1).service_request_id, id);
    assert.deepEqual(db.audit_logs.slice(before.audits).map((entry) => entry.action), [
      "SERVICE_REQUEST_CREATED", "SERVICE_REQUEST_ACKNOWLEDGED", "SERVICE_REQUEST_ACCEPTED",
      "SERVICE_REQUEST_CONVERTED_TO_LEAD", "LEAD_CREATED_FROM_SERVICE_REQUEST"
    ]);
    for (const key of ["quotes", "purchase_orders", "dispatch_cards", "invoices"]) assert.equal(db[key].length, before[key], `${key} must not change`);
    assert.equal(db.notifications.length, before.notifications, "no notification may be produced by any service-request audit event");
  } finally {
    store.release(release);
  }
});
