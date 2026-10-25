import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

const users = [
  { id: "u_sales", email: "sales@example.invalid", role: "Sales", is_active: true },
  { id: "u_finance", email: "finance@example.invalid", role: "Finance", is_active: true },
  { id: "u_operations", email: "operations@example.invalid", role: "Operations", is_active: true },
  { id: "u_technician", email: "technician@example.invalid", role: "Technician", is_active: true }
];

async function request(base, user, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${generateToken(user)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test("real router requires Finance-verified PO before Operations dispatch and rejects urgent, Sales-verify or unauthorized paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orac-dispatch-po-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  let server;

  try {
    const { db, release } = await store.read();
    db.users = structuredClone(users);
    db.clients = [{ id: "client-fictional", name: "Fictional Service Client", is_active: true }];
    db.quotes = [{
      id: "quote-fictional", quote_number: "Q-TEST-001", client_id: "client-fictional",
      status: "Approved_Pending_PO", total_amount: 100, created_by: "u_sales"
    }];
    db.quote_lines = [{ id: "line-fictional", quotation_id: "quote-fictional", description: "Synthetic work", quantity: 1, unit_price: 100, line_total: 100 }];
    db.purchase_orders = [{
      id: "po-fictional", quotation_id: "quote-fictional", po_reference: "PO-PENDING-001",
      po_amount: 100, status: "pending", requires_amendment: false
    }];
    db.dispatch_cards = [];
    db.audit_logs = [];
    await store.write(db, release);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", apiRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const sales = users[0];
    const finance = users[1];
    const operations = users[2];
    const technician = users[3];
    const path = "/quotes/quote-fictional/transition";

    // Transition boundary 1: Direct transition from Approved_Pending_PO to Field_Dispatch is blocked
    const pending = await request(base, operations, path, { target_state: "Field_Dispatch" });
    assert.equal(pending.status, 400);
    assert.match(pending.body.message, /Illegal transition: Approved_Pending_PO -> Field_Dispatch/);

    let persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.dispatch_cards.length, 0, "refused requests must not create a dispatch");

    // Operations cannot verify POs
    const opsBlocked = await request(base, operations, "/quotes/quote-fictional/po", {
      po_reference: "PO-VERIFIED-001", po_amount: 100
    });
    assert.equal(opsBlocked.status, 403, "Operations cannot verify POs");

    // Sales cannot verify POs
    const salesBlocked = await request(base, sales, "/quotes/quote-fictional/po", {
      po_reference: "PO-VERIFIED-001", po_amount: 100
    });
    assert.equal(salesBlocked.status, 403, "Sales cannot verify POs");

    // Finance verifies PO, which explicitly advances quote to PO_Verified
    const verified = await request(base, finance, "/quotes/quote-fictional/po", {
      po_reference: "PO-VERIFIED-001", po_amount: 100
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.data.status, "verified");
    assert.equal(verified.body.data.verified_by, finance.id);
    assert.equal(verified.body.quote.status, "PO_Verified");

    // Urgent pre-PO dispatch bypass is rejected
    const urgent = await request(base, operations, path, {
      target_state: "Field_Dispatch", started_before_po: true, urgent_reason: "Synthetic plant stoppage"
    });
    assert.equal(urgent.status, 400);
    assert.match(urgent.body.message, /urgent pre-PO dispatch is not permitted/i);

    // Unauthorized technician cannot dispatch
    const unauthorized = await request(base, technician, path, { target_state: "Field_Dispatch" });
    assert.equal(unauthorized.status, 403);

    // Transition boundary 2: Operations transitions PO_Verified to Field_Dispatch successfully
    const dispatched = await request(base, operations, path, { target_state: "Field_Dispatch" });
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.body.data.created.purchase_order_id, "po-fictional");
    assert.equal(dispatched.body.data.created.started_before_po, false);

    persisted = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(persisted.dispatch_cards.length, 1);
    assert.equal(persisted.purchase_orders[0].verified_by, finance.id);
  } finally {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
