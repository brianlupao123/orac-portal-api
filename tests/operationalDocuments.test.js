import assert from "node:assert/strict";
import test from "node:test";
import { getDailyTaskReport, getClientCompletionRecord, getInvoiceReadySummary } from "../src/controllers/operationalDocumentsController.js";

function res() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function db(role = "Technician") { return { users: [{ id: "tech", role, is_active: true, client_id: role === "Client Viewer" ? "c1" : undefined }], clients: [{ id: "c1", name: "Client" }], quotes: [{ id: "q1", client_id: "c1" }], dispatch_cards: [{ id: "d1", quotation_id: "q1", assigned_technician_id: "tech" }], field_worksheets: [{ id: "w1", dispatch_card_id: "d1", technician_id: "tech", status: "Supervisor_Approved" }], invoices: [], purchase_orders: [{ quotation_id: "q1", status: "verified", requires_amendment: false }] }; }

test("daily task report returns only Technician-assigned work", () => {
  const database = db(); const response = res();
  getDailyTaskReport({ db: database, user: { id: "tech" } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.dispatches.length, 1);
});

test("client completion record requires approval and enforces client isolation", () => {
  const database = db("Client Viewer"); const response = res();
  getClientCompletionRecord({ db: database, user: { id: "tech" }, params: { id: "w1" } }, response);
  assert.equal(response.statusCode, 200);
  database.users[0].client_id = "other"; const denied = res();
  getClientCompletionRecord({ db: database, user: { id: "tech" }, params: { id: "w1" } }, denied);
  assert.equal(denied.statusCode, 403);
});

test("invoice-ready summary remains Finance-only", () => {
  const database = db(); const response = res();
  getInvoiceReadySummary({ db: database, user: { id: "tech" } }, response);
  assert.equal(response.statusCode, 403);
});
