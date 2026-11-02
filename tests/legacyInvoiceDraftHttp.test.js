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

const users = {
  financeOne: { id: "legacy-finance-one", email: "finance.one@fixture.invalid", role: "Finance", is_active: true },
  financeTwo: { id: "legacy-finance-two", email: "finance.two@fixture.invalid", role: "Finance", is_active: true },
  sales: { id: "legacy-sales", email: "sales@fixture.invalid", role: "Sales", is_active: true }
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orac-legacy-invoice-draft-"));
  return { dir, store: createStore(join(dir, "db.json")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function seed(store, { v5 = false } = {}) {
  const { db, release } = await store.read();
  db.users = Object.values(users);
  db.quotes = [{ id: "legacy-quote", status: "Field_Dispatch", total_amount: 800, ...(v5 ? { v5_commercial_workflow: true } : {}) }];
  db.purchase_orders = [{ id: "legacy-po", quotation_id: "legacy-quote", status: "verified", po_reference: "PO-LEGACY-001", po_amount: 1000, requires_amendment: false }];
  db.dispatch_cards = [{ id: "legacy-dispatch", quotation_id: "legacy-quote", purchase_order_id: "legacy-po", dispatch_number: "JOB-LEGACY-001", status: "active" }];
  db.field_worksheets = [{ id: "legacy-worksheet", dispatch_card_id: "legacy-dispatch", technician_id: "legacy-tech", status: "Supervisor_Approved", hours: 8 }];
  db.timesheets = [{ id: "legacy-timesheet", dispatch_card_id: "legacy-dispatch", user_id: "legacy-tech", source_worksheet_id: "legacy-worksheet", hours_logged: 8, hourly_rate: 100 }];
  db.material_usage = [];
  db.invoices = [];
  db.invoice_lines = [];
  db.audit_logs = [];
  db.legacy_invoice_drafts = [];
  db.legacy_invoice_idempotency = [];
  store.write(db, release);
}

function appFor(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, code: err.code, message: err.message }));
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}

async function request(base, path, user, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${generateToken(user)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

test("legacy invoice draft is non-financial, idempotent, and needs a different Finance issuer", async () => {
  const t = fixture();
  try {
    await seed(t.store);
    await withServer(appFor(t.store), async (base) => {
      const refusedDirectIssue = await request(base, "/quotes/legacy-quote/transition", users.financeOne, { method: "POST", body: { target_state: "Invoiced" } });
      assert.equal(refusedDirectIssue.status, 409);
      assert.equal(refusedDirectIssue.body.code, "LEGACY_INVOICE_DRAFT_REQUIRED");
      const beforeDraft = await t.store.read();
      assert.equal(beforeDraft.db.quotes[0].status, "Field_Dispatch");
      assert.equal(beforeDraft.db.invoices.length, 0);
      beforeDraft.release();

      const draftKey = randomUUID();
      const prepared = await request(base, "/dispatch_cards/legacy-dispatch/legacy-invoice-drafts", users.financeOne, { method: "POST", body: { idempotency_key: draftKey } });
      assert.equal(prepared.status, 201);
      assert.equal(prepared.body.data.status, "prepared");
      assert.equal(prepared.body.data.candidate.total, 800);

      const replay = await request(base, "/dispatch_cards/legacy-dispatch/legacy-invoice-drafts", users.financeOne, { method: "POST", body: { idempotency_key: draftKey } });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.idempotent_replay, true);

      const { db, release } = await t.store.read();
      assert.equal(db.invoices.length, 0);
      assert.equal(db.invoice_lines.length, 0);
      assert.equal(db.quotes[0].status, "Field_Dispatch");
      storeWriteRelease(t.store, db, release);

      const selfIssue = await request(base, `/legacy-invoice-drafts/${prepared.body.data.id}/issue`, users.financeOne, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(selfIssue.status, 403);
      assert.equal(selfIssue.body.code, "LEGACY_INVOICE_TWO_PERSON_REQUIRED");

      const issued = await request(base, `/legacy-invoice-drafts/${prepared.body.data.id}/issue`, users.financeTwo, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(issued.status, 201);
      assert.equal(issued.body.data.status, "sent");

      const after = await t.store.read();
      assert.equal(after.db.invoices.length, 1);
      assert.equal(after.db.invoice_lines.length, 1);
      assert.equal(after.db.quotes[0].status, "Invoiced");
      after.release();
    });
  } finally { t.cleanup(); }
});

test("legacy draft refuses V5 work and stale evidence without creating an invoice", async () => {
  const t = fixture();
  try {
    await seed(t.store, { v5: true });
    await withServer(appFor(t.store), async (base) => {
      const v5 = await request(base, "/dispatch_cards/legacy-dispatch/legacy-invoice-drafts", users.financeOne, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(v5.status, 409);
      assert.equal(v5.body.code, "V5_INVOICE_PATH_REQUIRED");
    });
    await seed(t.store);
    await withServer(appFor(t.store), async (base) => {
      const prepared = await request(base, "/dispatch_cards/legacy-dispatch/legacy-invoice-drafts", users.financeOne, { method: "POST", body: { idempotency_key: randomUUID() } });
      const { db, release } = await t.store.read();
      db.timesheets[0].hours_logged = 7;
      storeWriteRelease(t.store, db, release);
      const issue = await request(base, `/legacy-invoice-drafts/${prepared.body.data.id}/issue`, users.financeTwo, { method: "POST", body: { idempotency_key: randomUUID() } });
      assert.equal(issue.status, 409);
      assert.equal(issue.body.code, "LEGACY_INVOICE_DRAFT_STALE");
      const after = await t.store.read();
      assert.equal(after.db.invoices.length, 0);
      after.release();
    });
  } finally { t.cleanup(); }
});

function storeWriteRelease(store, db, release) {
  store.write(db, release);
}
