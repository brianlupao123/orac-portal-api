// Real PostgreSQL release evidence for the V5 writer. These tests are skipped
// unless an explicitly local, disposable test database is supplied.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import pg from "pg";

import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/postgresStore.js";
import { generateToken } from "../src/middleware/auth.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";
import { call, contactBody, database, paperBody } from "./helpers/v5SignatureFixture.js";

const connectionString = process.env.ORAC_TEST_DATABASE_URL;
const skip = connectionString ? false : "ORAC_TEST_DATABASE_URL is not set; real PostgreSQL V5 writer tests were not executed.";

function assertDisposableTarget(url) {
  const parsed = new URL(url);
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  const remoteNeonAcknowledged = process.env.ORAC_TEST_DATABASE_ALLOW_REMOTE === "ORAC_V5_DISPOSABLE_ONLY";
  assert.match(parsed.pathname.slice(1), /test/i, "refusing a PostgreSQL database whose name does not contain 'test'");
  if (local) return;
  assert.equal(remoteNeonAcknowledged, true, "refusing a remote database without ORAC_TEST_DATABASE_ALLOW_REMOTE=ORAC_V5_DISPOSABLE_ONLY");
  assert.match(parsed.hostname, /\.neon\.tech$/i, "the remote test target must be a dedicated Neon database");
}

function rememberWriterEnvironment() {
  return {
    commercial: process.env.ORAC_V5_COMMERCIAL_WORKFLOW,
    writer: process.env.ORAC_V5_INVOICE_WRITER,
    json: process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS
  };
}

async function withWriter(run) {
  const prior = rememberWriterEnvironment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  delete process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries({
      ORAC_V5_COMMERCIAL_WORKFLOW: prior.commercial,
      ORAC_V5_INVOICE_WRITER: prior.writer,
      ORAC_V5_INVOICE_JSON_SINGLE_PROCESS: prior.json
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function scenario() {
  const db = database();
  Object.assign(db.quotes[0], { currency: "USD", tax_status: "unconfigured", commercial_acceptance_po_id: "po-pg" });
  Object.assign(db.quote_lines[0], { quantity: 16, unit_price_cents: 2500, currency: "USD" });
  db.purchase_orders = [{ id: "po-pg", po_reference: "PO-PG", po_amount: 1000, status: "verified" }];
  db.dispatch_cards[0].purchase_order_id = "po-pg";
  db.users.push(
    { id: "finance-pg-1", email: "finance-one@fixture.invalid", role: "Finance", is_active: true },
    { id: "finance-pg-2", email: "finance-two@fixture.invalid", role: "Finance", is_active: true },
    { id: "admin-pg", email: "admin@fixture.invalid", role: "Admin", is_active: true }
  );
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) }).statusCode, 201);
  const signature = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: signature.evidence.id, hours_hash: signature.current_hash, attest: true } }).statusCode, 201);
  return db;
}

const user = (id, role) => ({ id, email: `${id}@fixture.invalid`, role, is_active: true });
const financeOne = user("finance-pg-1", "Finance");
const financeTwo = user("finance-pg-2", "Finance");
const admin = user("admin-pg", "Admin");
const newPool = () => new pg.Pool({ connectionString, max: 6 });

function makeNode(pool) {
  const store = createStore(null, pool);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message || "Internal server error." }));
  return { app, store };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function callApi(baseUrl, path, actor, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${generateToken(actor)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

const draftBody = (quantity, key = randomUUID()) => ({
  idempotency_key: key,
  lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity }] }]
});

async function createDraft(baseUrl, quantity, actor = financeOne) {
  const response = await callApi(baseUrl, "/dispatch_cards/job-1/v5-invoice-drafts", actor, { method: "POST", body: draftBody(quantity) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.id;
}

const issue = (baseUrl, draftId, actor, key = randomUUID()) => callApi(baseUrl, `/v5-invoice-drafts/${draftId}/issue`, actor, { method: "POST", body: { idempotency_key: key } });

async function withPostgresHarness(run) {
  assertDisposableTarget(connectionString);
  const pools = [newPool(), newPool(), newPool()];
  const control = pools[2];
  await control.query("CREATE TABLE IF NOT EXISTS store (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  await control.query("ALTER TABLE store DROP CONSTRAINT IF EXISTS no_v5_invoice");
  await control.query("DELETE FROM store");
  const initialData = await withWriter(async () => scenario());
  await control.query("INSERT INTO store (id, data) VALUES ('main', $1)", [initialData]);
  const nodes = [await listen(makeNode(pools[0]).app), await listen(makeNode(pools[1]).app)];
  try {
    return await withWriter(() => run({ bases: nodes.map((node) => node.baseUrl), control }));
  } finally {
    await Promise.all(nodes.map((node) => node.close()));
    await control.query("ALTER TABLE store DROP CONSTRAINT IF EXISTS no_v5_invoice").catch(() => {});
    await Promise.all(pools.map((pool) => pool.end()));
  }
}

async function rowData(pool) {
  return (await pool.query("SELECT data FROM store WHERE id = 'main'"))?.rows[0]?.data;
}

test("PG: V5 invoice writing accepts PostgreSQL without JSON acknowledgement", { skip }, async () => {
  await withPostgresHarness(async ({ bases, control }) => {
    const id = await createDraft(bases[0], 3);
    const result = await issue(bases[1], id, financeTwo);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const data = await rowData(control);
    assert.equal(data.v5_invoices.length, 1);
    assert.equal(data.v5_invoice_source_consumption[0].quantity_micro_units, 3_000_000);
  });
});

test("PG: a failed V5 invoice write rolls back the invoice, consumption, idempotency and number", { skip }, async () => {
  await withPostgresHarness(async ({ bases, control }) => {
    const id = await createDraft(bases[0], 3);
    const before = JSON.stringify(await rowData(control));
    const key = randomUUID();
    await control.query("ALTER TABLE store ADD CONSTRAINT no_v5_invoice CHECK (jsonb_array_length(COALESCE(data->'v5_invoices', '[]'::jsonb)) = 0)");
    const failed = await issue(bases[0], id, financeTwo, key);
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(await rowData(control)), before);
    await control.query("ALTER TABLE store DROP CONSTRAINT no_v5_invoice");
    const retry = await issue(bases[1], id, financeTwo, key);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.match(retry.body.data.invoice_number, /^V5-INV-\d{4}-00001$/);
  });
});

test("PG: concurrent V5 issues with the same idempotency key create one invoice", { skip }, async () => {
  await withPostgresHarness(async ({ bases, control }) => {
    const id = await createDraft(bases[0], 3);
    const key = randomUUID();
    const results = await Promise.all([
      issue(bases[0], id, financeTwo, key), issue(bases[1], id, admin, key),
      issue(bases[0], id, financeTwo, key), issue(bases[1], id, admin, key)
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 200, 201]);
    assert.equal(new Set(results.map((result) => result.body.data.invoice_number)).size, 1);
    const data = await rowData(control);
    assert.equal(data.v5_invoices.length, 1);
    assert.equal(data.v5_invoice_source_consumption.length, 1);
  });
});

test("PG: competing V5 drafts cannot overconsume the same verified source", { skip }, async () => {
  await withPostgresHarness(async ({ bases, control }) => {
    const first = await createDraft(bases[0], 5);
    const second = await createDraft(bases[1], 5);
    const results = await Promise.all([issue(bases[0], first, financeTwo), issue(bases[1], second, admin)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    const data = await rowData(control);
    assert.equal(data.v5_invoices.length, 1);
    assert.ok(data.v5_invoice_source_consumption.reduce((sum, item) => sum + item.quantity_micro_units, 0) <= 9_000_000);
  });
});
