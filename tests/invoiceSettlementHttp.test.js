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
  admin: { id: "settlement-admin", email: "admin@fixture.invalid", role: "Admin", is_active: true },
  finance: { id: "settlement-finance", email: "finance@fixture.invalid", role: "Finance", is_active: true },
  management: { id: "settlement-management", email: "management@fixture.invalid", role: "Management", is_active: true },
  sales: { id: "settlement-sales", email: "sales@fixture.invalid", role: "Sales", is_active: true }
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orac-invoice-settlement-http-"));
  const file = join(dir, "db.json");
  return { dir, store: createStore(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function seed(store) {
  const { db, release } = await store.read();
  db.users = Object.values(users);
  db.invoices = [{ id: "settlement-invoice", invoice_number: "INV-FIXTURE-001", status: "sent", total_amount: 100 }];
  db.invoice_payments = [];
  db.audit_logs = [];
  store.write(db, release);
}

function appFor(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (_req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." }));
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(base, path, user, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${generateToken(user)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("real router scopes settlement evidence and keeps receipt idempotency internals private", async () => {
  const t = fixture();
  try {
    await seed(t.store);
    await withServer(appFor(t.store), async (base) => {
      const key = randomUUID();
      const recorded = await request(base, "/invoices/settlement-invoice/payments", users.finance, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          amount: 40,
          payment_method: "bank_transfer",
          reference: "FIXTURE-RECEIPT-001",
          received_on: "2026-10-20"
        }
      });
      assert.equal(recorded.status, 201);
      assert.equal(recorded.body.settlement.outstanding_amount, 60);

      const financeView = await request(base, "/invoices/settlement-invoice/settlement", users.finance);
      assert.equal(financeView.status, 200);
      assert.equal(financeView.body.data.settlement.outstanding_amount, 60);
      assert.equal(financeView.body.data.payments.length, 1);
      assert.equal(financeView.body.data.payments[0].idempotency_key, undefined);
      assert.equal(financeView.body.data.payments[0].request_hash, undefined);

      const managementView = await request(base, "/invoices/settlement-invoice/settlement", users.management);
      assert.equal(managementView.status, 200);

      const salesView = await request(base, "/invoices/settlement-invoice/settlement", users.sales);
      assert.equal(salesView.status, 403);

      const managementWrite = await request(base, "/invoices/settlement-invoice/payments", users.management, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          amount: 1,
          payment_method: "cash",
          reference: "FORBIDDEN-MANAGEMENT-WRITE",
          received_on: "2026-10-20"
        }
      });
      assert.equal(managementWrite.status, 403);
    });
  } finally {
    t.cleanup();
  }
});
