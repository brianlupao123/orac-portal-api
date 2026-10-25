import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";
import { TRAIL_FLAG } from "../src/recordTrail.js";

const userList = [
  { id: "u_admin", email: "admin@example.invalid", role: "Admin", is_active: true },
  { id: "u_management", email: "management@example.invalid", role: "Management", is_active: true },
  { id: "u_sales", email: "sales@example.invalid", role: "Sales", is_active: true },
  { id: "u_ops", email: "ops@example.invalid", role: "Operations", is_active: true },
  { id: "u_finance", email: "finance@example.invalid", role: "Finance", is_active: true },
  { id: "u_client", email: "client@example.invalid", role: "Client Viewer", client_id: "c1", is_active: true }
];

function withFlag(value, fn) {
  const before = process.env[TRAIL_FLAG];
  if (value === undefined) delete process.env[TRAIL_FLAG]; else process.env[TRAIL_FLAG] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (before === undefined) delete process.env[TRAIL_FLAG]; else process.env[TRAIL_FLAG] = before;
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orac-trail-http-"));
  const file = join(dir, "db.json");
  return { dir, file, store: createStore(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function seed(store) {
  const { db, release } = await store.read();
  db.users = structuredClone(userList);
  db.clients = [
    { id: "c1", name: "Fictional Client One", is_active: true },
    { id: "c2", name: "Fictional Client Two", is_active: true }
  ];
  db.leads = [
    { id: "lead1", company_name: "Fictional Client One", contact_name: "Test Contact", email: "contact@example.invalid", service_need: "Test service", client_id: "c1", status: "New", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "lead2", company_name: "Fictional Client Two", contact_name: "Other Contact", email: "other@example.invalid", service_need: "Other service", client_id: "c2", status: "New", created_at: "2026-01-01T00:00:00.000Z" }
  ];
  db.quotes = [];
  db.quote_lines = [];
  db.purchase_orders = [];
  db.dispatch_cards = [];
  db.worksheet_registers = [];
  db.service_requests = [];
  db.mine_sites = [{ id: "site1", client_id: "c1", name: "Private Synthetic Site" }];
  db.equipment_tags = [{ id: "eq1", client_id: "c1", tag_code: "PRIVATE-SYN-EQUIPMENT" }];
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

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try { await fn(`http://127.0.0.1:${server.address().port}/api`); }
  finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, path, user, { method = "GET", body, headers: extraHeaders = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${generateToken(user)}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

test("public keyed lead replay links once into a Sales quote and the scoped record trail", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      await withServer(appFor(t.store), async (base) => {
        const sales = userList.find((user) => user.role === "Sales");
        const admin = userList.find((user) => user.role === "Admin");
        const key = randomUUID();
        const leadBody = {
          company_name: "Fictional Service Client",
          contact_name: "Test Contact",
          email: "test-contact@example.invalid",
          service_need: "Synthetic pump inspection request",
          urgency: "standard"
        };
        const created = await call(base, "/leads", null, {
          method: "POST", body: leadBody, headers: { "Idempotency-Key": key }
        });
        const replay = await call(base, "/leads", null, {
          method: "POST", body: leadBody, headers: { "Idempotency-Key": key }
        });
        assert.equal(created.status, 200);
        assert.equal(replay.status, 200);
        assert.equal(replay.body.idempotent_replay, true);
        assert.equal(replay.body.data.id, created.body.data.id);

        const quote = await call(base, "/quotes", sales, {
          method: "POST",
          body: {
            client_id: "c1",
            source_lead_id: created.body.data.id,
            lines: [{ description: "Synthetic inspection", quantity: 1, unit_price: 100 }]
          }
        });
        assert.equal(quote.status, 200);
        assert.equal(quote.body.data.source_lead_id, created.body.data.id);

        const persisted = readFileSync(t.file);
        const db = JSON.parse(persisted);
        assert.equal(db.leads.filter((item) => item.id === created.body.data.id).length, 1);
        assert.equal(db.idempotency_keys.length, 1);
        assert.equal(db.audit_logs.filter((row) => row.entity_type === "lead" && row.entity_id === created.body.data.id).length, 1);

        const trail = await call(base, `/trail/quotes/${quote.body.data.id}`, admin);
        assert.equal(trail.status, 200);
        assert.equal(trail.body.data.stages.find((stage) => stage.stage === "lead").ref.id, created.body.data.id);
        assert.ok(trail.body.data.events.some((event) => event.entity === "lead" && event.entity_id === created.body.data.id));
        assert.deepEqual(readFileSync(t.file), persisted, "the read-only trail must not mutate the store");
      });
    } finally { t.cleanup(); }
  });
});

test("authenticated trail and lead-link HTTP flow uses role guards and performs read-only GET", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      await withServer(appFor(t.store), async (base) => {
        const sales = userList.find((user) => user.role === "Sales");
        const admin = userList.find((user) => user.role === "Admin");
        const ops = userList.find((user) => user.role === "Operations");
        const finance = userList.find((user) => user.role === "Finance");
        const client = userList.find((user) => user.role === "Client Viewer");
        const quoteBody = { client_id: "c1", lines: [{ description: "Fictional service", quantity: 1, unit_price: 100 }] };

        const unlinked = await call(base, "/quotes", sales, { method: "POST", body: quoteBody });
        assert.equal(unlinked.status, 200);
        assert.equal(Object.hasOwn(unlinked.body.data, "source_lead_id"), false);

        const linked = await call(base, "/quotes", sales, { method: "POST", body: { ...quoteBody, source_lead_id: "lead1" } });
        assert.equal(linked.status, 200);
        assert.equal(linked.body.data.source_lead_id, "lead1");
        const mismatched = await call(base, "/quotes", sales, { method: "POST", body: { ...quoteBody, source_lead_id: "lead2" } });
        assert.equal(mismatched.status, 409);

        const quoteId = linked.body.data.id;
        const { db, release } = await t.store.read();
        const quote = db.quotes.find((item) => item.id === quoteId);
        quote.status = "Field_Dispatch";
        db.purchase_orders.push({ id: "po1", quotation_id: quoteId, status: "verified", po_reference: "PO-TEST", po_amount: 100 });
        db.dispatch_cards.push({ id: "job1", quotation_id: quoteId, status: "active", dispatch_number: "JOB-TEST", assigned_technician_ids: ["tech1"] });
        t.store.write(db, release);

        assert.equal((await call(base, `/trail/quotes/${quoteId}`, null)).status, 401);
        const beforeGet = readFileSync(t.file);
        const salesTrail = await call(base, `/trail/quotes/${quoteId}`, sales);
        const afterGet = readFileSync(t.file);
        assert.equal(salesTrail.status, 200);
        assert.deepEqual(salesTrail.body.data.stages.map((stage) => stage.stage), ["lead", "quote"]);
        assert.equal(salesTrail.body.data.event_history.status, "not_available_to_role");
        assert.deepEqual(afterGet, beforeGet, "GET trail must not rewrite the persistent aggregate");

        const opsTrail = await call(base, `/trail/quotes/${quoteId}`, ops);
        assert.deepEqual(opsTrail.body.data.stages.map((stage) => stage.stage), ["quote", "po", "dispatch"]);
        const financeTrail = await call(base, `/trail/quotes/${quoteId}`, finance);
        assert.deepEqual(financeTrail.body.data.stages.map((stage) => stage.stage), ["quote", "po"]);
        assert.ok(Array.isArray(financeTrail.body.data.events));
        assert.equal((await call(base, `/trail/quotes/${quoteId}?event_cursor=not-a-cursor`, finance)).status, 400);
        assert.equal((await call(base, `/trail/quotes/${quoteId}`, admin)).body.data.stages.length, 4);
        assert.equal((await call(base, `/trail/quotes/${quoteId}`, client)).status, 404);
      });
    } finally { t.cleanup(); }
  });
});

test("trail remains unavailable when the flag is off and client-supplied links are refused", async () => {
  await withFlag(undefined, async () => {
    const t = fixture();
    try {
      await seed(t.store);
      await withServer(appFor(t.store), async (base) => {
        const sales = userList.find((user) => user.role === "Sales");
        const body = { client_id: "c1", lines: [{ description: "Fictional service", quantity: 1, unit_price: 100 }], source_lead_id: "lead1" };
        assert.equal((await call(base, "/quotes", sales, { method: "POST", body })).status, 409);
        assert.equal((await call(base, "/trail/quotes/q1", sales)).status, 404);
      });
    } finally { t.cleanup(); }
  });
});

test("invoice record analysis enforces the existing invoice scope and audits only safe projections", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.quotes = [
        { id: "q1", quote_number: "Q-SYN-1", client_id: "c1", status: "Field_Dispatch" },
        { id: "q2", quote_number: "Q-SYN-2", client_id: "c2", status: "Field_Dispatch" }
      ];
      db.dispatch_cards = [
        { id: "d1", quotation_id: "q1", dispatch_number: "JOB-SYN-1" },
        { id: "d2", quotation_id: "q2", dispatch_number: "JOB-SYN-2" }
      ];
      db.purchase_orders = [{ id: "po1", quotation_id: "q1", status: "verified", po_amount: 8000 }];
      db.invoices = [
        { id: "inv1", invoice_number: "INV-SYN-1", dispatch_card_id: "d1", purchase_order_id: "po1", total_amount: 7000, status: "sent", generated_at: "2026-01-02T00:00:00Z", void_reason: "private" },
        { id: "inv2", invoice_number: "INV-SYN-2", dispatch_card_id: "d2", total_amount: 100, status: "sent" }
      ];
      db.invoice_payments = [{ id: "pay1", invoice_id: "inv1", amount: 2500, currency: "USD", payment_method: "bank_transfer", reference: "PRIVATE-RECEIPT", received_on: "2026-01-03", idempotency_key: "PRIVATE-KEY", request_hash: "PRIVATE-HASH" }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const admin = userList.find((user) => user.role === "Admin");
        const finance = userList.find((user) => user.role === "Finance");
        const client = userList.find((user) => user.role === "Client Viewer");
        const body = { record_type: "invoice", record_id: "inv1" };
        const financeResult = await call(base, "/ai/record-analysis", finance, { method: "POST", body });
        assert.equal(financeResult.status, 200);
        assert.equal(financeResult.body.data.payment_assessment, "not_determined");
        assert.deepEqual(financeResult.body.data.settlement, { status: "recorded_manual_ledger", currency: "USD", total_amount: 7000, paid_amount: 2500, outstanding_amount: 4500, payment_count: 1 });
        const serialized = JSON.stringify(financeResult.body.data);
        for (const secret of ["8000", "private", "po_amount", "PRIVATE-KEY", "PRIVATE-HASH"]) assert.equal(serialized.includes(secret), false, secret);
        const clientResult = await call(base, "/ai/record-analysis", client, { method: "POST", body });
        assert.equal(clientResult.status, 200);
        assert.deepEqual(clientResult.body.data.settlement, { status: "not_available_to_role" });
        assert.equal((await call(base, "/ai/record-analysis", client, { method: "POST", body: { ...body, record_id: "inv2" } })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", admin, { method: "POST", body: { ...body, record_id: "unknown" } })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.entity_type === "ai_request");
        assert.equal(audit.new_values.record_type, "invoice");
        assert.equal(JSON.stringify(audit.new_values).includes("7000"), false);
        assert.equal(JSON.stringify(audit.new_values).includes("private"), false);
      });
    } finally { t.cleanup(); }
  });
});

test("worksheet-register analysis is authenticated, role-scoped and audits only source identifiers", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.worksheet_registers = [{
        id: "wr1", reference: "REG-SYN-1", status: "Approved",
        roster: [{ key: "t_u_tech", technician_id: "u_tech", display_name: "Private Worker Name" }],
        lines: [{ roster_key: "t_u_tech", date: "2026-09-01", normal: 8, ot_15: 1, ot_20: 0, sources: [{ source_type: "daily_timesheet", record_id: "dts1", row_index: 0 }] }]
      }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const management = userList.find((user) => user.role === "Management");
        const finance = userList.find((user) => user.role === "Finance");
        const sales = userList.find((user) => user.role === "Sales");
        const body = { record_type: "worksheet_register", record_id: "wr1" };
        const result = await call(base, "/ai/record-analysis", management, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.data.evidence.covered_worker_dates, [{ worker_ref: "u_tech", date: "2026-09-01" }]);
        assert.equal(JSON.stringify(result.body).includes("Private Worker Name"), false);
        assert.equal(JSON.stringify(result.body).includes("normal"), false);
        assert.equal((await call(base, "/ai/record-analysis", finance, { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", sales, { method: "POST", body })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.new_values.record_type === "worksheet_register");
        assert.deepEqual(audit.new_values.target_ids, ["wr1", "dts1"]);
        assert.equal(JSON.stringify(audit.new_values).includes("Private Worker Name"), false);
        assert.equal(JSON.stringify(audit.new_values).includes("2026-09-01"), false);
      });
    } finally { t.cleanup(); }
  });
});

test("service request analysis respects client ownership, triage roles and records a linked Lead", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.service_requests = [
        { id: "sr1", client_id: "c1", status: "Converted_To_Lead", urgency: "standard", title: "Private title", service_need: "PRIVATE REQUEST DETAIL", triage_note: "PRIVATE INTERNAL NOTE", requested_date: "2026-10-20", mine_site_id: "site1", equipment_tag_id: "eq1", converted_lead_id: "lead_sr1" },
        { id: "sr2", client_id: "c2", status: "Submitted", urgency: "standard" }
      ];
      db.leads.push({ id: "lead_sr1", lead_number: "L-SYN-1", service_request_id: "sr1" });
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const client = userList.find((user) => user.role === "Client Viewer");
        const sales = userList.find((user) => user.role === "Sales");
        const finance = userList.find((user) => user.role === "Finance");
        const body = { record_type: "service_request", record_id: "sr1" };
        const clientResult = await call(base, "/ai/record-analysis", client, { method: "POST", body });
        assert.equal(clientResult.status, 200);
        assert.equal(Object.hasOwn(clientResult.body.data.evidence, "conversion"), false);
        assert.equal((await call(base, "/ai/record-analysis", client, { method: "POST", body: { ...body, record_id: "sr2" } })).status, 404);
        const salesResult = await call(base, "/ai/record-analysis", sales, { method: "POST", body });
        assert.equal(salesResult.status, 200);
        assert.equal(salesResult.body.data.evidence.conversion.status, "linked");
        assert.equal(salesResult.body.data.evidence.conversion.lead_ref.id, "lead_sr1");
        assert.equal((await call(base, "/ai/record-analysis", finance, { method: "POST", body })).status, 404);
        const serialized = JSON.stringify(salesResult.body.data);
        for (const secret of ["PRIVATE REQUEST DETAIL", "PRIVATE INTERNAL NOTE", "Private title", "Private Synthetic Site", "PRIVATE-SYN-EQUIPMENT"]) assert.equal(serialized.includes(secret), false, secret);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_sales" && item.new_values.record_type === "service_request");
        assert.deepEqual(audit.new_values.target_ids, ["sr1", "site1", "eq1", "lead_sr1"]);
        assert.equal(JSON.stringify(audit.new_values).includes("PRIVATE REQUEST DETAIL"), false);
      });
    } finally { t.cleanup(); }
  });
});

test("purchase-order analysis is limited to PO readers and audits references without commercial values", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.quotes = [{ id: "q_po", quote_number: "Q-SYN-PO", client_id: "c1", status: "Approved_Pending_PO" }];
      db.purchase_orders = [{
        id: "po_analysis", quotation_id: "q_po", status: "verified", po_reference: "PRIVATE-PO-REF", po_amount: 765432,
        verified_at: "2026-10-01T00:00:00.000Z", requires_amendment: true
      }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const admin = userList.find((user) => user.role === "Admin");
        const operations = userList.find((user) => user.role === "Operations");
        const sales = userList.find((user) => user.role === "Sales");
        const body = { record_type: "purchase_order", record_id: "po_analysis" };
        const result = await call(base, "/ai/record-analysis", operations, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.evidence.purchase_order.amendment_required, true);
        assert.ok(result.body.data.findings.some((item) => item.code === "PO_AMENDMENT_REQUIRED"));
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-PO-REF", "765432", "po_amount"]) assert.equal(serialized.includes(secret), false, secret);
        assert.equal(serialized.includes('"c1"'), false, "the client id must not be returned as a data value");
        assert.equal((await call(base, "/ai/record-analysis", sales, { method: "POST", body })).status, 404);
        const adminResult = await call(base, "/ai/record-analysis", admin, { method: "POST", body });
        assert.equal(adminResult.status, 200);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_ops" && item.new_values.record_type === "purchase_order");
        assert.deepEqual(audit.new_values.target_ids, ["po_analysis", "q_po"]);
        assert.equal(JSON.stringify(audit.new_values).includes("765432"), false);
      });
    } finally { t.cleanup(); }
  });
});

test("stock-item analysis returns ledger reconciliation only to inventory readers and never mutates stock", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.stock_items = [{ id: "stock1", item_code: "SYN-GASKET", item_name: "Synthetic Gasket", unit_of_measure: "each", quantity_on_hand: 5, reorder_level: 2 }];
      db.stock_movements = [{ id: "move1", stock_item_id: "stock1", movement_type: "in", quantity: 5, quantity_before: 0, quantity_after: 5, unit_of_measure: "each", direction: "increase", reference_type: "opening_balance", created_at: "2026-01-01T00:00:00.000Z" }];
      db.material_usage = [];
      t.store.write(db, release);
      const before = readFileSync(t.file, "utf8");
      await withServer(appFor(t.store), async (base) => {
        const operations = userList.find((user) => user.role === "Operations");
        const management = userList.find((user) => user.role === "Management");
        const finance = userList.find((user) => user.role === "Finance");
        const body = { record_type: "stock_item", record_id: "stock1" };
        const result = await call(base, "/ai/record-analysis", operations, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.evidence.reconciliation_status, "reconciled");
        assert.equal(result.body.data.stockItem.quantity_on_hand, 5);
        assert.deepEqual(result.body.data.evidenceRefs.map((ref) => ref.targetId), ["stock1", "move1"]);
        assert.equal(JSON.stringify(result.body.data).includes("actor_id"), false);
        assert.equal((await call(base, "/ai/record-analysis", management, { method: "POST", body })).status, 200);
        assert.equal((await call(base, "/ai/record-analysis", finance, { method: "POST", body })).status, 404);
        const saved = readFileSync(t.file, "utf8");
        const persisted = JSON.parse(saved);
        const audit = persisted.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_ops" && item.new_values.record_type === "stock_item");
        assert.deepEqual(audit.new_values.target_ids, ["stock1", "move1"]);
        assert.deepEqual(persisted.stock_items, JSON.parse(before).stock_items);
        assert.deepEqual(JSON.parse(saved).stock_movements, JSON.parse(before).stock_movements);
      });
    } finally { t.cleanup(); }
  });
});

test("catalog-item analysis is Admin/Management-only, returns bounded commercial fields and audits only linked IDs", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.catalog_items = [{ id: "cat1", item_code: "SYN-CAT", item_name: "Synthetic Part", category: "Wear", unit_of_measure: "each", unit_price: 12.5, material_grade: "grade A", dimensions: "10mm", private_note: "PRIVATE-CATALOG-NOTE" }];
      db.stock_items = [{ id: "stock1", catalog_item_id: "cat1", item_code: "SYN-STOCK", supplier_id: "supplier-private", quantity_on_hand: 20, unit_cost: 6 }];
      t.store.write(db, release);
      const before = JSON.parse(readFileSync(t.file, "utf8"));
      await withServer(appFor(t.store), async (base) => {
        const admin = userList.find((user) => user.role === "Admin");
        const management = userList.find((user) => user.role === "Management");
        const operations = userList.find((user) => user.role === "Operations");
        const body = { record_type: "catalog_item", record_id: "cat1" };
        const result = await call(base, "/ai/record-analysis", management, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.catalogItem.unit_price, 12.5);
        assert.deepEqual(result.body.data.evidenceRefs.map((ref) => ref.targetId), ["cat1", "stock1"]);
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-CATALOG-NOTE", "supplier-private", "unit_cost", "quantity_on_hand"]) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await call(base, "/ai/record-analysis", admin, { method: "POST", body })).status, 200);
        assert.equal((await call(base, "/ai/record-analysis", operations, { method: "POST", body })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_management" && item.new_values.record_type === "catalog_item");
        assert.deepEqual(audit.new_values.target_ids, ["cat1", "stock1"]);
        assert.equal(JSON.stringify(audit.new_values).includes("12.5"), false);
        assert.deepEqual(saved.catalog_items, before.catalog_items);
        assert.deepEqual(saved.stock_items, before.stock_items);
      });
    } finally { t.cleanup(); }
  });
});

test("supplier analysis is limited to inventory readers and returns safe linked receipt evidence", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.suppliers = [{ id: "sup1", name: "Synthetic Supplier", contact_person: "PRIVATE-CONTACT", email: "private@example.invalid", phone: "555-0100", lead_time_days: 7, note: "PRIVATE-SUPPLIER-NOTE" }];
      db.stock_items = [{ id: "stock1", supplier_id: "sup1", item_code: "SYN-BOLT", item_name: "Synthetic bolt", unit_of_measure: "each", quantity_on_hand: 4 }];
      db.stock_movements = [{ id: "move1", stock_item_id: "stock1", movement_type: "in", quantity: 4, quantity_before: 0, quantity_after: 4, unit_of_measure: "each", direction: "increase", reference_type: "supplier", reference_id: "sup1", source_document_ref: "PRIVATE-DN-001", created_at: "2026-01-01T00:00:00.000Z" }];
      db.material_usage = [];
      t.store.write(db, release);
      const before = JSON.parse(readFileSync(t.file, "utf8"));
      await withServer(appFor(t.store), async (base) => {
        const operations = userList.find((user) => user.role === "Operations");
        const management = userList.find((user) => user.role === "Management");
        const finance = userList.find((user) => user.role === "Finance");
        const body = { record_type: "supplier", record_id: "sup1" };
        const result = await call(base, "/ai/record-analysis", operations, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.supplier.lead_time_days, 7);
        assert.equal(result.body.data.evidence.receipt_count, 1);
        assert.deepEqual(result.body.data.evidenceRefs.map((ref) => ref.targetId), ["sup1", "stock1", "move1"]);
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-CONTACT", "private@example.invalid", "555-0100", "PRIVATE-SUPPLIER-NOTE", "PRIVATE-DN-001", "supplier_id"]) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await call(base, "/ai/record-analysis", management, { method: "POST", body })).status, 200);
        assert.equal((await call(base, "/ai/record-analysis", finance, { method: "POST", body })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_ops" && item.new_values.record_type === "supplier");
        assert.deepEqual(audit.new_values.target_ids, ["sup1", "stock1", "move1"]);
        assert.deepEqual(saved.suppliers, before.suppliers);
        assert.deepEqual(saved.stock_items, before.stock_items);
        assert.deepEqual(saved.stock_movements, before.stock_movements);
      });
    } finally { t.cleanup(); }
  });
});

test("maintenance schedule analysis applies the existing contract/client scope and audits only linked IDs", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.contracts = [{ id: "contract1", client_id: "c1", contract_number: "CTR-0001", status: "Active", start_date: "2026-01-01", end_date: "2026-12-31", total_value: 900, created_by_user_id: "PRIVATE-STAFF" }];
      db.maintenance_schedules = [{ id: "schedule1", contract_id: "contract1", equipment_tag_id: "tag1", frequency: "Quarterly", next_due_date: "2026-10-30", notes: "PRIVATE-SCHEDULE-NOTE", created_by_user_id: "PRIVATE-STAFF" }];
      db.equipment_tags = [{ id: "tag1", tag_code: "SYN-TAG", plant_section_id: "section1", is_active: true }];
      db.plant_sections = [{ id: "section1", plant_id: "plant1" }];
      db.plants = [{ id: "plant1", mine_site_id: "site1" }];
      db.mine_sites = [{ id: "site1", client_id: "c1" }];
      t.store.write(db, release);
      const before = JSON.parse(readFileSync(t.file, "utf8"));
      await withServer(appFor(t.store), async (base) => {
        const client = userList.find((user) => user.role === "Client Viewer");
        const admin = userList.find((user) => user.role === "Admin");
        const sales = userList.find((user) => user.role === "Sales");
        const body = { record_type: "maintenance_schedule", record_id: "schedule1" };
        const result = await call(base, "/ai/record-analysis", client, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.maintenance_schedule.next_due_date, "2026-10-30");
        assert.deepEqual(result.body.data.evidenceRefs.map((ref) => ref.targetId), ["schedule1", "contract1", "tag1"]);
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-SCHEDULE-NOTE", "PRIVATE-STAFF", "total_value", '"c1"']) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await call(base, "/ai/record-analysis", admin, { method: "POST", body })).status, 200);
        assert.equal((await call(base, "/ai/record-analysis", sales, { method: "POST", body })).status, 404);
        const crossClient = { ...body, record_id: "foreign_schedule" };
        const { db: changedDb, release: changedRelease } = await t.store.read();
        changedDb.contracts.push({ id: "contract2", client_id: "c2", contract_number: "CTR-0002", status: "Active", start_date: "2026-01-01", end_date: "2026-12-31" });
        changedDb.maintenance_schedules.push({ id: "foreign_schedule", contract_id: "contract2", next_due_date: "2026-10-30", frequency: "Monthly" });
        t.store.write(changedDb, changedRelease);
        assert.equal((await call(base, "/ai/record-analysis", client, { method: "POST", body: crossClient })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === "u_client" && item.new_values.record_type === "maintenance_schedule");
        assert.deepEqual(audit.new_values.target_ids, ["schedule1", "contract1", "tag1"]);
        assert.deepEqual(saved.maintenance_schedules, [...before.maintenance_schedules, { id: "foreign_schedule", contract_id: "contract2", next_due_date: "2026-10-30", frequency: "Monthly" }]);
      });
    } finally { t.cleanup(); }
  });
});

test("equipment tag analysis returns linked hierarchy to asset roles and audits only IDs", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const { db, release } = await t.store.read();
      db.equipment_tags = [{ id: "tag1", tag_code: "SYN-TAG", equipment_name: "Pump A", criticality: "high", status: "active", plant_section_id: "section1", notes: "PRIVATE-EQUIPMENT-NOTE", is_active: true }];
      db.plant_sections = [{ id: "section1", name: "Pumps", plant_id: "plant1", is_active: true }];
      db.plants = [{ id: "plant1", name: "Process Plant", mine_site_id: "site1", is_active: true }];
      db.mine_sites = [{ id: "site1", name: "North Site", client_id: "c1", is_active: true }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const ops = userList.find((user) => user.role === "Operations");
        const admin = userList.find((user) => user.role === "Admin");
        const sales = userList.find((user) => user.role === "Sales");
        const body = { record_type: "equipment_tag", record_id: "tag1" };
        const result = await call(base, "/ai/record-analysis", ops, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.equipment_tag.tag_code, "SYN-TAG");
        assert.deepEqual(result.body.data.evidenceRefs.map((item) => item.targetId), ["tag1", "site1", "plant1", "section1"]);
        assert.equal(JSON.stringify(result.body.data).includes("PRIVATE-EQUIPMENT-NOTE"), false);
        assert.equal((await call(base, "/ai/record-analysis", admin, { method: "POST", body })).status, 200);
        assert.equal((await call(base, "/ai/record-analysis", sales, { method: "POST", body })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === ops.id && item.new_values.record_type === "equipment_tag");
        assert.deepEqual(audit.new_values.target_ids, ["tag1", "site1", "plant1", "section1"]);
        assert.equal(JSON.stringify(audit).includes("Pump A"), false);
        assert.deepEqual(saved.equipment_tags, db.equipment_tags);
      });
    } finally { t.cleanup(); }
  });
});

test("material usage analysis enforces assigned-dispatch access and audits no costs or descriptions", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const tech = { id: "u_tech_assigned", email: "tech@example.invalid", role: "Technician", is_active: true };
      const otherTech = { id: "u_tech_other", email: "other-tech@example.invalid", role: "Technician", is_active: true };
      const { db, release } = await t.store.read();
      db.users.push(tech, otherTech);
      db.dispatch_cards = [{ id: "job1", dispatch_number: "JOB-0001", assigned_technician_id: tech.id, quotation_id: "quote1" }];
      db.material_usage = [{ id: "usage1", dispatch_card_id: "job1", catalog_item_id: "cat1", quantity_used: 3, unit_cost: 99, total_cost: 297, description: "PRIVATE-DESCRIPTION", created_by: tech.id, idempotency_key: "PRIVATE-KEY" }];
      db.stock_items = [{ id: "stock1", catalog_item_id: "cat1", item_code: "SYN-CAT", unit_of_measure: "each" }];
      db.stock_movements = [{ id: "move1", stock_item_id: "stock1", reference_type: "material_usage", reference_id: "usage1", movement_type: "out", quantity: -3 }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const body = { record_type: "material_usage", record_id: "usage1" };
        const result = await call(base, "/ai/record-analysis", tech, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.material_usage.stock_ledger_status, "matched");
        assert.deepEqual(result.body.data.evidenceRefs.map((item) => item.targetId), ["usage1", "job1", "stock1", "move1"]);
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-DESCRIPTION", "PRIVATE-KEY", "unit_cost", "total_cost", "created_by"]) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await call(base, "/ai/record-analysis", otherTech, { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", userList.find((user) => user.role === "Sales"), { method: "POST", body })).status, 404);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === tech.id && item.new_values.record_type === "material_usage");
        assert.deepEqual(audit.new_values.target_ids, ["usage1", "job1", "stock1", "move1"]);
        assert.deepEqual(audit.new_values.finding_codes, []);
      });
    } finally { t.cleanup(); }
  });
});

test("field worksheet analysis is authenticated, owner/assignment scoped, rate-free and audits IDs only", async () => {
  await withFlag("enabled", async () => {
    const t = fixture();
    try {
      await seed(t.store);
      const tech = { id: "u_tech_assigned", email: "tech@example.invalid", role: "Technician", is_active: true };
      const otherTech = { id: "u_tech_other", email: "other-tech@example.invalid", role: "Technician", is_active: true };
      const supervisor = { id: "u_supervisor", email: "supervisor@example.invalid", role: "Supervisor", is_active: true };
      const otherSupervisor = { id: "u_supervisor_other", email: "other-supervisor@example.invalid", role: "Supervisor", is_active: true };
      const { db, release } = await t.store.read();
      db.users.push(tech, otherTech, supervisor, otherSupervisor);
      db.dispatch_cards = [{ id: "job1", dispatch_number: "JOB-0001", assigned_technician_ids: [tech.id], assigned_supervisor_id: supervisor.id }];
      db.field_worksheets = [{
        id: "ws1", dispatch_card_id: "job1", technician_id: tech.id, supervisor_id: supervisor.id,
        status: "Supervisor_Approved", work_date: "2026-10-12", timesheet_version: 2, hours: 8, hours_breakdown: { normal: 8, ot_15: 0, ot_20: 0 },
        signatures: { employee: { name: "PRIVATE-WORKER", date: "2026-10-12", method: "on_device", attested_at: "2026-10-12T10:00:00Z" } },
        signed_copy_image: "PRIVATE-SIGNATURE", client_acknowledgement: { acknowledged_at: "2026-10-12T11:00:00Z", signer_name: "PRIVATE-CLIENT" },
        approved_by: "PRIVATE-SUPERVISOR", approved_at: "2026-10-12T12:00:00Z", supervisor_comment: "PRIVATE-COMMENT", hourly_rate: 99
      }];
      t.store.write(db, release);
      await withServer(appFor(t.store), async (base) => {
        const body = { record_type: "field_worksheet", record_id: "ws1" };
        const result = await call(base, "/ai/record-analysis", tech, { method: "POST", body });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.field_worksheet.state, "Supervisor_Approved");
        assert.equal(result.body.data.field_worksheet.daily_source_eligibility, "eligible_under_current_rules");
        assert.equal(result.body.data.field_worksheet.hours_total, 8);
        assert.deepEqual(result.body.data.field_worksheet.hours_breakdown, { normal: 8, ot_15: 0, ot_20: 0 });
        assert.equal(result.body.data.evidence.hours_total, 8);
        assert.equal(result.body.data.evidence.signoff.complete, true);
        assert.deepEqual(result.body.data.evidenceRefs.map((item) => item.targetId), ["ws1", "job1"]);
        const serialized = JSON.stringify(result.body.data);
        for (const secret of ["PRIVATE-WORKER", "PRIVATE-SIGNATURE", "PRIVATE-CLIENT", "PRIVATE-SUPERVISOR", "PRIVATE-COMMENT", "hourly_rate"]) assert.equal(serialized.includes(secret), false, secret);
        assert.equal((await call(base, "/ai/record-analysis", otherTech, { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", otherSupervisor, { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", userList.find((user) => user.role === "Client Viewer"), { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", userList.find((user) => user.role === "Sales"), { method: "POST", body })).status, 404);
        assert.equal((await call(base, "/ai/record-analysis", supervisor, { method: "POST", body })).status, 200);
        const saved = JSON.parse(readFileSync(t.file, "utf8"));
        const audit = saved.audit_logs.find((item) => item.action === "AI_RECORD_ANALYSIS" && item.actor_id === tech.id && item.new_values.record_type === "field_worksheet");
        assert.deepEqual(audit.new_values.target_ids, ["ws1", "job1"]);
        assert.equal(JSON.stringify(audit).includes("PRIVATE"), false);
      });
    } finally { t.cleanup(); }
  });
});
