import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

const financeOne = { id: "phase5-finance-one", email: "phase5.one@fixture.invalid", role: "Finance", is_active: true };
const financeTwo = { id: "phase5-finance-two", email: "phase5.two@fixture.invalid", role: "Finance", is_active: true };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orac-phase5-"));
  return { dir, store: createStore(join(dir, "db.json")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function seed(store) {
  const { db, release } = await store.read();
  db.users = [financeOne, financeTwo];
  db.quotes = [{ id: "phase5-quote", status: "Field_Dispatch", total_amount: 800 }];
  db.purchase_orders = [{ id: "phase5-po", quotation_id: "phase5-quote", po_reference: "PO-PHASE5", po_amount: 1000, status: "verified", requires_amendment: false }];
  db.dispatch_cards = [{ id: "phase5-dispatch", quotation_id: "phase5-quote", purchase_order_id: "phase5-po", dispatch_number: "JOB-PHASE5" }];
  db.field_worksheets = [{ id: "phase5-sheet", dispatch_card_id: "phase5-dispatch", technician_id: "phase5-tech", status: "Supervisor_Approved", hours: 8 }];
  db.timesheets = [{ id: "phase5-time", dispatch_card_id: "phase5-dispatch", user_id: "phase5-tech", source_worksheet_id: "phase5-sheet", hours_logged: 8, hourly_rate: 100 }];
  db.material_usage = []; db.invoices = []; db.invoice_lines = []; db.invoice_payments = []; db.audit_logs = [];
  db.legacy_invoice_drafts = []; db.legacy_invoice_idempotency = [];
  store.write(db, release);
}
function app(store) { const value = express(); value.use(express.json()); value.use("/api", persistenceMiddleware(store)); value.use("/api", apiRouter); value.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, code: err.code, message: err.message })); return value; }
async function withServer(value, run) { const server = await new Promise((resolve) => { const instance = value.listen(0, "127.0.0.1", () => resolve(instance)); }); try { await run(`http://127.0.0.1:${server.address().port}/api`); } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } }
async function request(base, path, user, { method = "GET", body, headers = {} } = {}) { const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${generateToken(user)}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; }

test("Phase 5 commercial lifecycle enforces maker-checker, settlement, reversal, and paid-void refusal", async () => {
  const t = setup();
  try {
    await seed(t.store);
    await withServer(app(t.store), async (base) => {
      const draft = await request(base, "/dispatch_cards/phase5-dispatch/legacy-invoice-drafts", financeOne, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(draft.status, 201);
      const selfIssue = await request(base, `/legacy-invoice-drafts/${draft.body.data.id}/issue`, financeOne, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(selfIssue.status, 403);
      const issue = await request(base, `/legacy-invoice-drafts/${draft.body.data.id}/issue`, financeTwo, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(issue.status, 201);
      const invoiceId = issue.body.data.id;
      const first = await request(base, `/invoices/${invoiceId}/payments`, financeOne, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: { amount: 300, payment_method: "bank_transfer", reference: "PHASE5-RECEIPT-1", received_on: "2026-10-25" } });
      assert.equal(first.status, 201);
      const second = await request(base, `/invoices/${invoiceId}/payments`, financeOne, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: { amount: 500, payment_method: "bank_transfer", reference: "PHASE5-RECEIPT-2", received_on: "2026-10-25" } });
      assert.equal(second.status, 201);
      const settlement = await request(base, `/invoices/${invoiceId}/settlement`, financeTwo);
      assert.equal(settlement.body.data.settlement.outstanding_amount, 0);
      const paidVoid = await request(base, `/invoices/${invoiceId}/void`, financeOne, { method: "POST", body: { reason: "not permitted" } });
      assert.equal(paidVoid.status, 409);
      const reversal = await request(base, `/invoices/${invoiceId}/payments/${second.body.data.id}/void`, financeTwo, { method: "POST", body: { reason: "bank reversal" } });
      assert.equal(reversal.status, 200);
      const afterReversal = await request(base, `/invoices/${invoiceId}/settlement`, financeOne);
      assert.equal(afterReversal.body.data.settlement.outstanding_amount, 500);
    });
  } finally { t.cleanup(); }
});
