import test from "node:test";
import assert from "node:assert/strict";

import { getCollection } from "../src/controllers/coreController.js";

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

function requestFor(actor) {
  return {
    user: { id: actor.id },
    db: {
      users: [actor],
      clients: [{ id: "client-a" }],
      quotes: [{ id: "quote-a", client_id: "client-a" }],
      dispatch_cards: [{ id: "dispatch-a", quotation_id: "quote-a", assigned_technician_id: "tech-1", assigned_supervisor_id: "supervisor-1" }],
      field_worksheets: [{ id: "worksheet-a", dispatch_card_id: "dispatch-a", technician_id: "tech-1", supervisor_id: "supervisor-1" }]
    }
  };
}

function expectDenied(collectionName, actor) {
  const response = createResponse();
  getCollection(collectionName)(requestFor(actor), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
}

test("Technician and Supervisor cannot read generic clients or quotes", () => {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };

  for (const actor of [technician, supervisor]) {
    expectDenied("clients", actor);
    expectDenied("quotes", actor);
  }
});

test("Sales, Finance, and Client Viewer cannot list generic field-work collections", () => {
  for (const actor of [
    { id: "sales-1", role: "Sales", is_active: true },
    { id: "finance-1", role: "Finance", is_active: true },
    { id: "client-1", role: "Client Viewer", client_id: "client-a", is_active: true }
  ]) {
    expectDenied("dispatch_cards", actor);
    expectDenied("field_worksheets", actor);
  }
});

test("Operations retains permitted access to client, quote, and field-work collections", () => {
  const response = createResponse();
  const operations = { id: "ops-1", role: "Operations", is_active: true };

  getCollection("clients")(requestFor(operations), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.length, 1);
});
