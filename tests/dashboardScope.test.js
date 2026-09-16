import test from "node:test";
import assert from "node:assert/strict";

import { getCollection, getSummary } from "../src/controllers/coreController.js";

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

function createDatabase(users) {
  return {
    users,
    clients: [{ id: "client-a" }, { id: "client-b" }],
    quotes: [
      { id: "quote-a", client_id: "client-a", status: "PO_Verified" },
      { id: "quote-b", client_id: "client-b", status: "Invoiced" }
    ],
    purchase_orders: [{ id: "po-a", quotation_id: "quote-a", requires_amendment: true }],
    invoices: [{ id: "invoice-b", dispatch_card_id: "dispatch-b" }],
    dispatch_cards: [
      { id: "dispatch-a", quotation_id: "quote-a", assigned_technician_id: "tech-1", assigned_supervisor_id: "supervisor-1", status: "In_Progress" },
      { id: "dispatch-b", quotation_id: "quote-b", assigned_technician_id: "tech-2", assigned_supervisor_id: "supervisor-2", status: "In_Progress" }
    ],
    field_worksheets: [
      { id: "worksheet-a", dispatch_card_id: "dispatch-a", technician_id: "tech-1", supervisor_id: "supervisor-1", status: "Submitted" },
      { id: "worksheet-b", dispatch_card_id: "dispatch-b", technician_id: "tech-2", supervisor_id: "supervisor-2", status: "Returned_For_Correction" }
    ]
  };
}

test("Technician dashboard summary and operational collections are limited to assigned work", () => {
  const technician = { id: "tech-1", role: "Technician", is_active: true };
  const req = { user: { id: technician.id }, db: createDatabase([technician]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.clients, 0);
  assert.equal(summaryResponse.body.data.quotes, 0);
  assert.equal(summaryResponse.body.data.invoices, 0);
  assert.equal(summaryResponse.body.data.dispatches, 1);
  assert.equal(summaryResponse.body.data.worksheets, 1);

  const dispatchResponse = createResponse();
  getCollection("dispatch_cards")(req, dispatchResponse);
  assert.deepEqual(dispatchResponse.body.data.map((dispatch) => dispatch.id), ["dispatch-a"]);
});

test("Supervisor dashboard summary and operational collections are limited to review scope", () => {
  const supervisor = { id: "supervisor-1", role: "Supervisor", is_active: true };
  const req = { user: { id: supervisor.id }, db: createDatabase([supervisor]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.clients, 0);
  assert.equal(summaryResponse.body.data.quotes, 0);
  assert.equal(summaryResponse.body.data.invoices, 0);
  assert.equal(summaryResponse.body.data.dispatches, 1);
  assert.equal(summaryResponse.body.data.pending_review, 1);

  const worksheetResponse = createResponse();
  getCollection("field_worksheets")(req, worksheetResponse);
  assert.deepEqual(worksheetResponse.body.data.map((worksheet) => worksheet.id), ["worksheet-a"]);
});

test("Client Viewer summary counts only worksheets linked to their own client", () => {
  const clientViewer = { id: "client-user-1", role: "Client Viewer", client_id: "client-a", is_active: true };
  const req = { user: { id: clientViewer.id }, db: createDatabase([clientViewer]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.clients, 1);
  assert.equal(summaryResponse.body.data.quotes, 1);
  assert.equal(summaryResponse.body.data.dispatches, 1);
  assert.equal(summaryResponse.body.data.invoices, 0);
  assert.equal(summaryResponse.body.data.worksheets, 1);
  assert.equal(summaryResponse.body.data.pending_review, 1);
  assert.equal(summaryResponse.body.data.returned_for_correction, 0);
  assert.equal(summaryResponse.body.data.blocked_amendments, 0);
});

test("Sales dashboard summary excludes aggregates from denied operational and financial collections", () => {
  const sales = { id: "sales-1", role: "Sales", is_active: true };
  const req = { user: { id: sales.id }, db: createDatabase([sales]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.clients, 2);
  assert.equal(summaryResponse.body.data.quotes, 2);
  assert.equal(summaryResponse.body.data.pending_po, 0);
  assert.equal(summaryResponse.body.data.dispatches, 0);
  assert.equal(summaryResponse.body.data.worksheets, 0);
  assert.equal(summaryResponse.body.data.pending_review, 0);
  assert.equal(summaryResponse.body.data.returned_for_correction, 0);
  assert.equal(summaryResponse.body.data.invoices, 0);
  assert.equal(summaryResponse.body.data.blocked_amendments, 0);
});

test("Finance dashboard summary excludes aggregates from denied field-work collections", () => {
  const finance = { id: "finance-1", role: "Finance", is_active: true };
  const req = { user: { id: finance.id }, db: createDatabase([finance]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.quotes, 2);
  assert.equal(summaryResponse.body.data.invoices, 1);
  assert.equal(summaryResponse.body.data.dispatches, 0);
  assert.equal(summaryResponse.body.data.worksheets, 0);
  assert.equal(summaryResponse.body.data.pending_review, 0);
  assert.equal(summaryResponse.body.data.returned_for_correction, 0);
  assert.equal(summaryResponse.body.data.blocked_amendments, 1);
});

test("Operations dashboard summary excludes aggregates from denied invoice collections", () => {
  const operations = { id: "operations-1", role: "Operations", is_active: true };
  const req = { user: { id: operations.id }, db: createDatabase([operations]) };
  const summaryResponse = createResponse();

  getSummary(req, summaryResponse);

  assert.equal(summaryResponse.body.data.clients, 2);
  assert.equal(summaryResponse.body.data.quotes, 2);
  assert.equal(summaryResponse.body.data.dispatches, 2);
  assert.equal(summaryResponse.body.data.worksheets, 2);
  assert.equal(summaryResponse.body.data.invoices, 0);
  assert.equal(summaryResponse.body.data.pending_review, 1);
  assert.equal(summaryResponse.body.data.returned_for_correction, 1);
  assert.equal(summaryResponse.body.data.blocked_amendments, 1);
});
