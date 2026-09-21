import assert from "node:assert/strict";
import test from "node:test";
import { getPastelReviewQuotes, previewLeadImport, commitLeadImport, getOperationalAnalytics } from "../src/controllers/operationalDataController.js";

function res() { return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, header(key, value) { this.headers[key] = value; return this; }, send(body) { this.body = body; return this; } }; }
function db(role = "Finance") { return { users: [{ id: "actor", role, is_active: true }], leads: [{ email: "already@example.test" }], quotes: [{ id: "q2", quote_number: "Q-2", client_id: "=client", status: "Draft", total_amount: 1 }, { id: "q1", quote_number: "Q-1", client_id: "c1", status: "Approved", total_amount: 50 }], dispatch_cards: [{ id: "d1", assigned_technician_id: "actor", status: "Open", created_at: "2026-09-20" }], field_worksheets: [{ id: "w1", dispatch_card_id: "d1", technician_id: "actor", status: "Submitted", work_date: "2026-09-20" }], invoices: [], purchase_orders: [] }; }

test("Pastel review export is Finance-only, deterministic, and formula-safe", () => {
  const database = db(); const response = res();
  getPastelReviewQuotes({ db: database, user: { id: "actor" } }, response);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /^quote_number,client_id,status,total_amount\nQ-1/);
  assert.match(response.body, /'=client/);
});

test("lead import preview validates without mutating leads", () => {
  const database = db("Sales"); const response = res();
  previewLeadImport({ db: database, user: { id: "actor" }, body: { csv_content: "company_name,contact_name,email,service_need\nExample,Jane,jane@example.test,Inspection\nAgain,Joe,already@example.test,Repair" } }, response);
  assert.equal(response.body.preview_only, true);
  assert.equal(response.body.valid_rows, 1);
  assert.equal(response.body.invalid_rows, 1);
  assert.equal(database.leads.length, 1);
});

test("lead import commit requires confirmation, revalidates rows, and audits the batch", () => {
  const database = db("Sales"); const audits = []; const response = res();
  const store = { id: (prefix) => `${prefix}-${audits.length + 1}`, audit: (...args) => audits.push(args) };
  commitLeadImport({ db: database, store, user: { id: "actor" }, body: { confirmation: "IMPORT_LEADS", csv_content: "company_name,contact_name,email,service_need\nExample,Jane,jane@example.test,Inspection" } }, response);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.data.imported_count, 1);
  assert.equal(database.leads.length, 2);
  assert.equal(audits[0][4], "LEAD_IMPORT_COMMITTED");
});

test("operational analytics rejects unbounded requests and scopes Technician data", () => {
  const database = db("Technician"); const bad = res();
  getOperationalAnalytics({ db: database, user: { id: "actor" }, query: {} }, bad);
  assert.equal(bad.statusCode, 400);
  const good = res();
  getOperationalAnalytics({ db: database, user: { id: "actor" }, query: { from: "2026-09-01", to: "2026-09-30" } }, good);
  assert.equal(good.body.data.dispatches.total, 1);
  assert.equal("invoice_ready" in good.body.data, false);
});
