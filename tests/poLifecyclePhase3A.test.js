import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

const testUsers = [
  { id: "u_client1", email: "client1@example.invalid", role: "Client Viewer", client_id: "c_zimplats", is_active: true },
  { id: "u_client2", email: "client2@example.invalid", role: "Client Viewer", client_id: "c_mimosa", is_active: true },
  { id: "u_sales", email: "sales@example.invalid", role: "Sales", is_active: true },
  { id: "u_finance", email: "finance@example.invalid", role: "Finance", is_active: true },
  { id: "u_ops", email: "ops@example.invalid", role: "Operations", is_active: true },
  { id: "u_admin", email: "admin@example.invalid", role: "Admin", is_active: true },
  { id: "u_tech", email: "tech@example.invalid", role: "Technician", is_active: true },
  { id: "u_sup", email: "sup@example.invalid", role: "Supervisor", is_active: true }
];

async function post(base, user, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${generateToken(user)}`,
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, user, path) {
  const response = await fetch(`${base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${generateToken(user)}`
    }
  });
  return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text(), headers: response.headers };
}

test("Phase 3A: Authoritative Purchase Order Lifecycle Test Suite", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orac-po-phase3a-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  let server;

  try {
    const { db, release } = await store.read();
    db.users = structuredClone(testUsers);
    db.clients = [
      { id: "c_zimplats", name: "Zimplats Mining", is_active: true },
      { id: "c_mimosa", name: "Mimosa Mining", is_active: true },
      { id: "c_inactive", name: "Inactive Corp", is_active: false }
    ];
    db.quotes = [
      {
        id: "q_active_zim",
        quote_number: "Q-2026-ZIM-001",
        client_id: "c_zimplats",
        status: "Approved_Pending_PO",
        total_amount: 5000,
        grand_total_cents: 500000,
        sent_at: new Date(Date.now() - 5 * 86400000).toISOString(),
        validity_days: 30,
        created_by: "u_sales"
      },
      {
        id: "q_active_mim",
        quote_number: "Q-2026-MIM-001",
        client_id: "c_mimosa",
        status: "Approved_Pending_PO",
        total_amount: 3200,
        grand_total_cents: 320000,
        sent_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        validity_days: 30,
        created_by: "u_sales"
      },
      {
        id: "q_expired",
        quote_number: "Q-2026-EXP-001",
        client_id: "c_zimplats",
        status: "Approved_Pending_PO",
        total_amount: 1500,
        grand_total_cents: 150000,
        sent_at: new Date(Date.now() - 35 * 86400000).toISOString(), // 35 days ago
        validity_days: 30,
        created_by: "u_sales"
      },
      {
        id: "q_draft",
        quote_number: "Q-2026-DFT-001",
        client_id: "c_zimplats",
        status: "Draft",
        total_amount: 2000,
        grand_total_cents: 200000,
        created_by: "u_sales"
      }
    ];
    db.quote_lines = [
      { id: "ql_zim_1", quotation_id: "q_active_zim", description: "Ceramic tile lining", quantity: 10, unit_price: 500, line_total: 5000 }
    ];
    db.purchase_orders = [];
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

    const client1 = testUsers[0];
    const client2 = testUsers[1];
    const sales = testUsers[2];
    const finance = testUsers[3];
    const ops = testUsers[4];
    const admin = testUsers[5];
    const tech = testUsers[6];
    const sup = testUsers[7];

    await t.test("1. client submission and idempotent retry", async () => {
      const res = await post(base, client1, "/quotes/q_active_zim/client-po", {
        po_reference: "PO-ZIM-2026-001",
        po_amount: 5000,
        document_reference: "DOC-REF-ZIM-001"
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, "pending");
      assert.equal(res.body.data.po_reference, "PO-ZIM-2026-001");
      assert.equal(res.body.data.po_amount, 5000);
      assert.equal(res.body.data.po_amount_cents, 500000);
      assert.equal(res.body.data.currency, "USD");
      assert.equal(res.body.data.document_reference, "DOC-REF-ZIM-001");
      assert.equal(res.body.data.verified_by, null);

      // Idempotent retry with same payload
      const retry = await post(base, client1, "/quotes/q_active_zim/client-po", {
        po_reference: "PO-ZIM-2026-001",
        po_amount: 5000,
        document_reference: "DOC-REF-ZIM-001"
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent, true);
      assert.equal(retry.body.data.id, res.body.data.id);
    });

    await t.test("2. client tenant isolation", async () => {
      // client2 (Mimosa) attempts to submit PO for Zimplats quote
      const crossTenant = await post(base, client2, "/quotes/q_active_zim/client-po", {
        po_reference: "PO-ILLEGAL-001",
        po_amount: 5000
      });
      assert.equal(crossTenant.status, 403);
      assert.match(crossTenant.body.message, /another client's quote/i);
    });

    await t.test("3. duplicate reference rejection across client quotes", async () => {
      // Create a second Zimplats quote
      const { db: freshDb, release: rel } = await store.read();
      freshDb.quotes.push({
        id: "q_active_zim_2",
        quote_number: "Q-2026-ZIM-002",
        client_id: "c_zimplats",
        status: "Approved_Pending_PO",
        total_amount: 5000,
        grand_total_cents: 500000,
        sent_at: new Date().toISOString(),
        validity_days: 30,
        created_by: "u_sales"
      });
      await store.write(freshDb, rel);

      // Try to submit with same reference (case-insensitive after normalization: " po-zim-2026-001 ")
      const dup = await post(base, client1, "/quotes/q_active_zim_2/client-po", {
        po_reference: " po-zim-2026-001 ",
        po_amount: 5000
      });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, "DUPLICATE_PO_REFERENCE");
      assert.match(dup.body.message, /already in use/i);
    });

    await t.test("4. exact-match verification", async () => {
      // Submit PO for Mimosa quote
      const sub = await post(base, client2, "/quotes/q_active_mim/client-po", {
        po_reference: "PO-MIM-2026-001",
        po_amount: 3200
      });
      assert.equal(sub.status, 200);

      // Finance verifies with exact match (3200)
      const verifyRes = await post(base, finance, "/quotes/q_active_mim/po", {
        po_reference: "PO-MIM-2026-001",
        po_amount: 3200
      });
      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.body.data.status, "verified");
      assert.equal(verifyRes.body.data.verified_by, finance.id);
      assert.equal(verifyRes.body.data.po_amount_cents, 320000);
      assert.equal(verifyRes.body.quote.status, "PO_Verified");
    });

    await t.test("5. under-value and over-value rejection", async () => {
      // Try to verify with under-value (e.g. 4999 instead of 5000)
      const under = await post(base, finance, "/quotes/q_active_zim/po", {
        po_reference: "PO-ZIM-2026-001",
        po_amount: 4999
      });
      assert.equal(under.status, 400);
      assert.equal(under.body.code, "PO_UNDER_VALUE");
      assert.match(under.body.message, /Under-value POs cannot be verified/i);

      // Try to verify with over-value (e.g. 5001 instead of 5000)
      const over = await post(base, finance, "/quotes/q_active_zim/po", {
        po_reference: "PO-ZIM-2026-001",
        po_amount: 5001
      });
      assert.equal(over.status, 400);
      assert.equal(over.body.code, "PO_OVER_VALUE");
      assert.match(over.body.message, /Over-value POs cannot be verified as contingency buffer/i);
    });

    await t.test("6. quote validity expiry rejection (calculated from sent_at)", async () => {
      // Quote q_expired was sent 35 days ago (validity: 30 days)
      const exp = await post(base, client1, "/quotes/q_expired/client-po", {
        po_reference: "PO-ZIM-EXP-001",
        po_amount: 1500
      });
      assert.equal(exp.status, 400);
      assert.equal(exp.body.code, "QUOTE_VALIDITY_EXPIRED");
      assert.match(exp.body.message, /Quotation validity expired on/i);
    });

    await t.test("7. rejected PO retained plus resubmission creates a new record", async () => {
      // Finance rejects pending PO on q_active_zim
      const rejectRes = await post(base, finance, "/quotes/q_active_zim/reject-po", {
        reason: "PO missing authorized commercial signatory."
      });
      assert.equal(rejectRes.status, 200);
      assert.equal(rejectRes.body.data.status, "rejected");
      assert.equal(rejectRes.body.data.rejection_reason, "PO missing authorized commercial signatory.");
      assert.equal(rejectRes.body.data.rejected_by, finance.id);

      const rejectedPoId = rejectRes.body.data.id;

      // Client resubmits corrected PO with reference PO-ZIM-2026-001-REV
      const resubmit = await post(base, client1, "/quotes/q_active_zim/client-po", {
        po_reference: "PO-ZIM-2026-001-REV",
        po_amount: 5000,
        document_reference: "DOC-REF-ZIM-001-REV"
      });
      assert.equal(resubmit.status, 200);
      assert.notEqual(resubmit.body.data.id, rejectedPoId, "resubmission must create a new PO record");
      assert.equal(resubmit.body.data.status, "pending");

      // Verify that rejected PO is still retained in database
      const { db: checkDb, release: rel2 } = await store.read();
      const oldPo = checkDb.purchase_orders.find(p => p.id === rejectedPoId);
      assert.ok(oldPo, "rejected PO must be retained");
      assert.equal(oldPo.status, "rejected");
      assert.equal(oldPo.rejection_reason, "PO missing authorized commercial signatory.");
      rel2();
    });

    await t.test("8. PO verification authority: strictly Finance & Admin; Operations, Sales, Tech, Supervisor, Client blocked with 403", async () => {
      // 1. Direct HTTP tests proving Operations, Sales, Technician, Supervisor, and Client Viewer receive HTTP 403 for verify attempts
      const unauthorizedForVerify = [
        { user: ops, name: "Operations" },
        { user: sales, name: "Sales" },
        { user: tech, name: "Technician" },
        { user: sup, name: "Supervisor" },
        { user: client1, name: "Client Viewer" }
      ];

      for (const { user, name } of unauthorizedForVerify) {
        const verifyAttempt = await post(base, user, "/quotes/q_active_zim/po", {
          po_reference: "PO-ZIM-2026-001-REV",
          po_amount: 5000
        });
        assert.equal(verifyAttempt.status, 403, `${name} must receive 403 on verify attempt`);
        assert.match(verifyAttempt.body.message, /cannot perform verifyPo|Forbidden/i);
      }

      // 2. Direct HTTP tests proving Operations, Sales, Technician, Supervisor, and Client Viewer receive HTTP 403 for reject attempts
      for (const { user, name } of unauthorizedForVerify) {
        const rejectAttempt = await post(base, user, "/quotes/q_active_zim/reject-po", {
          reason: "Unauthorized attempt to reject"
        });
        assert.equal(rejectAttempt.status, 403, `${name} must receive 403 on reject attempt`);
        assert.match(rejectAttempt.body.message, /cannot perform rejectPo|Forbidden/i);
      }

      // 3. Sales may record a PO on behalf of a client but cannot verify it
      const salesRecord = await post(base, sales, "/quotes/q_active_zim_2/record-po", {
        po_reference: "PO-SALES-RECORD-001",
        po_amount: 5000,
        document_reference: "DOC-SALES-001"
      });
      assert.equal(salesRecord.status, 200, "Sales can record a PO on behalf of client");
      assert.equal(salesRecord.body.data.status, "pending");

      // Sales tries to verify the PO they just recorded -> 403
      const salesVerifyOwn = await post(base, sales, "/quotes/q_active_zim_2/po", {
        po_reference: "PO-SALES-RECORD-001",
        po_amount: 5000
      });
      assert.equal(salesVerifyOwn.status, 403, "Sales cannot verify the recorded PO");

      // 4. Admin can reject a PO
      const adminReject = await post(base, admin, "/quotes/q_active_zim_2/reject-po", {
        reason: "Administrative commercial correction needed."
      });
      assert.equal(adminReject.status, 200, "Admin can reject a PO");
      assert.equal(adminReject.body.data.status, "rejected");

      // 5. Finance can verify
      const financeVerify = await post(base, finance, "/quotes/q_active_zim/po", {
        po_reference: "PO-ZIM-2026-001-REV",
        po_amount: 5000
      });
      assert.equal(financeVerify.status, 200, "Finance can verify a PO");
      assert.equal(financeVerify.body.data.status, "verified");
      assert.equal(financeVerify.body.data.verified_by, finance.id);
      assert.equal(financeVerify.body.quote.status, "PO_Verified");
    });

    await t.test("9. transition to PO_Verified", async () => {
      // Quote q_active_zim was explicitly transitioned to PO_Verified upon Finance verification
      const { db: quoteDb, release: rel3 } = await store.read();
      const quote = quoteDb.quotes.find(q => q.id === "q_active_zim");
      assert.equal(quote.status, "PO_Verified");
      rel3();
    });

    await t.test("10. transition boundaries: dispatch blocked until PO_Verified and pre-PO urgent bypass rejected", async () => {
      // Transition Boundary 1: Approved_Pending_PO cannot transition to Field_Dispatch directly
      const pendingDispatch = await post(base, ops, "/quotes/q_active_zim_2/transition", {
        target_state: "Field_Dispatch"
      });
      assert.equal(pendingDispatch.status, 400);
      assert.match(pendingDispatch.body.message, /Illegal transition: Approved_Pending_PO -> Field_Dispatch/);

      // Verify no dispatch card was created and quote status is not auto-advanced
      const { db: boundaryDb, release: relB } = await store.read();
      const quotePending = boundaryDb.quotes.find(q => q.id === "q_active_zim_2");
      assert.equal(quotePending.status, "Approved_Pending_PO", "Quote must not silently auto-advance");
      relB();

      // Quote q_draft is in Draft status
      const draftDispatch = await post(base, ops, "/quotes/q_draft/transition", {
        target_state: "Field_Dispatch"
      });
      assert.equal(draftDispatch.status, 400);

      // Operations tries urgent bypass on verified quote -> rejected
      const urgentBypass = await post(base, ops, "/quotes/q_active_zim/transition", {
        target_state: "Field_Dispatch",
        started_before_po: true,
        urgent_reason: "Plant down"
      });
      assert.equal(urgentBypass.status, 400);
      assert.match(urgentBypass.body.message, /Urgent pre-PO dispatch is not permitted/i);

      // Transition Boundary 2: Operations dispatches against verified quote in PO_Verified status
      const validDispatch = await post(base, ops, "/quotes/q_active_zim/transition", {
        target_state: "Field_Dispatch"
      });
      assert.equal(validDispatch.status, 200);
      assert.equal(validDispatch.body.data.created.dispatch_number.startsWith("JOB-"), true);
      assert.equal(validDispatch.body.data.quote.status, "Field_Dispatch");
    });

  } finally {
    server?.closeAllConnections?.();
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
