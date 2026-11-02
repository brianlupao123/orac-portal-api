import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { createStore } from "../src/store.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { generateToken } from "../src/middleware/auth.js";

test("Job Card route authenticates, scopes access, and performs no workflow write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orac-job-card-http-"));
  const store = createStore(join(dir, "db.json"));
  const management = { id: "manager-job-card", email: "manager@fixture.invalid", role: "Management", is_active: true, name: "Manager" };
  const outsider = { id: "outsider-job-card", email: "outsider@fixture.invalid", role: "Technician", is_active: true, name: "Outsider" };
  try {
    const { db, release } = await store.read();
    db.users = [management, outsider];
    db.clients = [{ id: "client-job-card", name: "Evidence Client" }];
    db.quotes = [{ id: "quote-job-card", quote_number: "Q-JOB-1", client_id: "client-job-card", status: "Field_Dispatch" }];
    db.purchase_orders = [{ id: "po-job-card", quotation_id: "quote-job-card", po_reference: "PO-JOB-1", status: "verified", po_amount: 100 }];
    db.dispatch_cards = [{ id: "dispatch-job-card", dispatch_number: "JOB-1", quotation_id: "quote-job-card", purchase_order_id: "po-job-card", status: "Active" }];
    db.field_worksheets = []; db.material_usage = []; db.stock_items = []; db.timesheets = []; db.invoices = []; db.audit_logs = [];
    store.write(db, release);

    const app = express();
    app.use(express.json());
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/dispatch_cards/dispatch-job-card/job-card`;
      const allowed = await fetch(base, { headers: { Authorization: `Bearer ${generateToken(management)}` } });
      assert.equal(allowed.status, 200);
      const payload = await allowed.json();
      assert.equal(payload.data.identity.dispatch_number, "JOB-1");
      assert.equal(payload.data.workflow.purchase_order.po_amount, undefined);
      const readiness = await fetch(`${base.replace("/job-card", "")}/invoice-readiness`, { headers: { Authorization: `Bearer ${generateToken(management)}` } });
      assert.equal(readiness.status, 200);
      const readinessPayload = await readiness.json();
      assert.equal(readinessPayload.data.commercial.currency, "USD");
      const denied = await fetch(base, { headers: { Authorization: `Bearer ${generateToken(outsider)}` } });
      assert.equal(denied.status, 403);
      const readinessDenied = await fetch(`${base.replace("/job-card", "")}/invoice-readiness`, { headers: { Authorization: `Bearer ${generateToken(outsider)}` } });
      assert.equal(readinessDenied.status, 403);
      const after = await store.read();
      assert.equal(after.db.invoices.length, 0);
      assert.equal(after.db.dispatch_cards.length, 1);
      after.release();
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
