import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { createStore } from "../src/store.js";
import { createStore as createPostgresStore } from "../src/postgresStore.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { generateToken } from "../src/middleware/auth.js";
import { database, call, contactBody, paperBody } from "./helpers/v5SignatureFixture.js";
import { createV5ClientSupervisorContact, recordV5PaperSignature, confirmV5Timesheet } from "../src/controllers/v5SignatureController.js";
import { v5SignatureState } from "../src/v5SignatureEvidence.js";

async function withApi(callback) {
  const directory = mkdtempSync(join(tmpdir(), "orac-v5-writer-http-"));
  const store = createStore(join(directory, "db.json"));
  const finance = { id: "finance-http", email: "finance@fixture.invalid", role: "Finance", is_active: true };
  const sales = { id: "sales-http", email: "sales@fixture.invalid", role: "Sales", is_active: true };
  const { db, release } = await store.read();
  db.users = [finance, sales];
  db.dispatch_cards = [{ id: "dispatch-http" }];
  store.write(db, release);
  const app = express();
  app.use(express.json());
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback({
      finance,
      sales,
      store,
      url: `http://127.0.0.1:${server.address().port}/api/dispatch_cards/dispatch-http/v5-invoice-drafts`
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

function rememberV5Environment() {
  return {
    commercial: process.env.ORAC_V5_COMMERCIAL_WORKFLOW,
    writer: process.env.ORAC_V5_INVOICE_WRITER,
    json: process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS
  };
}

function restoreV5Environment(previous) {
  for (const [key, value] of Object.entries({
    ORAC_V5_COMMERCIAL_WORKFLOW: previous.commercial,
    ORAC_V5_INVOICE_WRITER: previous.writer,
    ORAC_V5_INVOICE_JSON_SINGLE_PROCESS: previous.json
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

const draftBody = {
  idempotency_key: "v5-http-draft-0001",
  lines: [{ quote_line_id: "line-http", sources: [{ source_type: "field_worksheet", source_id: "sheet-http", quantity: 1 }] }]
};

async function withInvoiceReadyApi(callback, prepareDb = null, storeFactory = null) {
  const directory = mkdtempSync(join(tmpdir(), "orac-v5-writer-ready-http-"));
  const finance = { id: "finance-http", email: "finance@fixture.invalid", role: "Finance", is_active: true };
  const admin = { id: "admin-http", email: "admin@fixture.invalid", role: "Admin", is_active: true };
  const management = { id: "management-http", email: "management@fixture.invalid", role: "Management", is_active: true };
  const restricted = ["Sales", "Operations", "Supervisor", "Technician", "Client Viewer"].map((role, index) => ({
    id: `restricted-v5-${index}`, email: `${role.toLowerCase().replace(/\s+/g, "-")}@fixture.invalid`, role, is_active: true
  }));
  const db = database();
  Object.assign(db.quotes[0], { currency: "USD", tax_status: "unconfigured", commercial_acceptance_po_id: "po-http" });
  Object.assign(db.quote_lines[0], { quantity: 16, unit_price_cents: 2500, currency: "USD" });
  db.purchase_orders = [{ id: "po-http", po_reference: "PO-HTTP", po_amount: 1000, status: "verified" }];
  db.dispatch_cards[0].purchase_order_id = "po-http";
  db.users.push(finance, admin, management, ...restricted);
  const contact = call(createV5ClientSupervisorContact, db, "sales-1", { params: { id: "job-1" }, body: contactBody() }).body.data;
  assert.equal(call(recordV5PaperSignature, db, "sales-1", { params: { id: "ws-1" }, body: paperBody(contact.id) }).statusCode, 201);
  const signature = v5SignatureState(db, db.field_worksheets[0]);
  assert.equal(call(confirmV5Timesheet, db, "sup-1", { params: { id: "ws-1" }, body: { evidence_id: signature.evidence.id, hours_hash: signature.current_hash, attest: true } }).statusCode, 201);
  prepareDb?.(db);
  const store = storeFactory ? storeFactory(db) : createStore(join(directory, "db.json"));
  if (!storeFactory) {
    const { release } = await store.read();
    await store.write(db, release);
  }
  const app = express();
  app.use(express.json());
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await callback({ finance, admin, management, restricted, store, baseUrl });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

function createFakePostgresPool(initialDb) {
  let committed = JSON.stringify(initialDb);
  let held = false;
  const waiters = [];
  const state = { failUpdate: false, commits: 0, rollbacks: 0 };
  const lock = () => new Promise((resolve) => {
    if (!held) { held = true; resolve(); } else waiters.push(resolve);
  });
  const unlock = () => {
    const next = waiters.shift();
    if (next) next(); else held = false;
  };
  const ok = { rowCount: 0, rows: [] };
  return {
    state,
    data: () => JSON.parse(committed),
    pool: {
      async connect() {
        let pending = null;
        let holding = false;
        return {
          async query(sql, params) {
            if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return ok;
            if (sql.startsWith("SELECT data")) {
              if (sql.includes("FOR UPDATE")) { await lock(); holding = true; }
              return { rowCount: 1, rows: [{ data: JSON.parse(committed) }] };
            }
            if (sql.startsWith("UPDATE store")) {
              if (state.failUpdate) throw new Error("simulated V5 invoice persistence failure");
              pending = JSON.stringify(params[0]);
              return { rowCount: 1, rows: [] };
            }
            if (sql === "COMMIT") {
              if (pending !== null) { committed = pending; state.commits += 1; }
              pending = null;
              if (holding) { holding = false; unlock(); }
              return ok;
            }
            if (sql === "ROLLBACK") {
              pending = null;
              state.rollbacks += 1;
              if (holding) { holding = false; unlock(); }
              return ok;
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
          release() {}
        };
      }
    }
  };
}

test("V5 invoice-writer API stays dark by default and rejects unauthorised callers without writing", async () => {
  const previous = rememberV5Environment();
  delete process.env.ORAC_V5_COMMERCIAL_WORKFLOW;
  delete process.env.ORAC_V5_INVOICE_WRITER;
  delete process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS;
  try {
    await withApi(async ({ finance, sales, store, url }) => {
      const forbidden = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(sales)}` }, body: JSON.stringify(draftBody)
      });
      assert.equal(forbidden.status, 403);
      const disabled = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` }, body: JSON.stringify(draftBody)
      });
      assert.equal(disabled.status, 409);
      assert.equal((await disabled.json()).code, "FEATURE_DISABLED");
      const disabledDraftRead = await fetch(url.replace("/dispatch_cards/dispatch-http/v5-invoice-drafts", "/v5-invoice-drafts/not-created"), {
        headers: { Authorization: `Bearer ${generateToken(finance)}` }
      });
      assert.equal(disabledDraftRead.status, 409);
      assert.equal((await disabledDraftRead.json()).code, "FEATURE_DISABLED");
      const after = await store.read();
      assert.equal(after.db.v5_invoice_drafts.length, 0);
      assert.equal(after.db.v5_invoices.length, 0);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API refuses JSON mode until an operator explicitly acknowledges single-process use", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  delete process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS;
  try {
    await withApi(async ({ finance, store, url }) => {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` }, body: JSON.stringify(draftBody)
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "V5_INVOICE_JSON_STORE_UNSUPPORTED");
      const after = await store.read();
      assert.equal(after.db.v5_invoice_drafts.length, 0);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API creates a non-consuming draft and lets a different authorised user issue it", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, management, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-success-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      const afterDraft = await store.read();
      assert.equal(afterDraft.db.v5_invoice_drafts.length, 1);
      assert.equal(afterDraft.db.v5_invoices.length, 0);
      assert.equal(afterDraft.db.v5_invoice_source_consumption.length, 0);
      afterDraft.release();
      const issueResponse = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-success-issue-0001" })
      });
      assert.equal(issueResponse.status, 201);
      const invoice = (await issueResponse.json()).data;
      assert.equal(invoice.invoice_number, "V5-INV-2026-00001");
      const draftRead = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}`, {
        headers: { Authorization: `Bearer ${generateToken(finance)}` }
      });
      assert.equal(draftRead.status, 200);
      assert.equal((await draftRead.json()).data.status, "issued");
      const draftReadDenied = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}`, {
        headers: { Authorization: `Bearer ${generateToken(management)}` }
      });
      assert.equal(draftReadDenied.status, 403);
      const listResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoices`, {
        headers: { Authorization: `Bearer ${generateToken(management)}` }
      });
      assert.equal(listResponse.status, 200);
      assert.equal((await listResponse.json()).data.length, 1);
      const afterIssue = await store.read();
      assert.equal(afterIssue.db.v5_invoices.length, 1);
      assert.equal(afterIssue.db.v5_invoice_source_consumption.length, 1);
      afterIssue.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer role UAT keeps commercial writes to Finance/Admin and issued reads to Management", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, management, restricted, store, baseUrl }) => {
      for (const actor of restricted) {
        const response = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(actor)}` },
          body: JSON.stringify({
            idempotency_key: `v5-role-draft-${actor.id}`,
            lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
          })
        });
        assert.equal(response.status, 403, actor.role);
      }
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-role-finance-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      for (const actor of restricted) {
        const response = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(actor)}` },
          body: JSON.stringify({ idempotency_key: `v5-role-issue-${actor.id}` })
        });
        assert.equal(response.status, 403, actor.role);
      }
      const beforeIssue = await store.read();
      assert.equal(beforeIssue.db.v5_invoices.length, 0);
      beforeIssue.release();
      const issued = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-role-admin-issue-0001" })
      });
      assert.equal(issued.status, 201);
      const invoice = (await issued.json()).data;
      const managementRead = await fetch(`${baseUrl}/v5-invoices/${invoice.id}`, { headers: { Authorization: `Bearer ${generateToken(management)}` } });
      assert.equal(managementRead.status, 200);
      for (const actor of restricted) {
        const response = await fetch(`${baseUrl}/v5-invoices/${invoice.id}`, { headers: { Authorization: `Bearer ${generateToken(actor)}` } });
        assert.equal(response.status, 403, actor.role);
      }
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 draft workspace is feature-gated and Finance-only", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, management, baseUrl }) => {
      delete process.env.ORAC_V5_COMMERCIAL_WORKFLOW;
      delete process.env.ORAC_V5_INVOICE_WRITER;
      const disabled = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-draft-workspace`, { headers: { Authorization: `Bearer ${generateToken(finance)}` } });
      assert.equal(disabled.status, 409);
      process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
      process.env.ORAC_V5_INVOICE_WRITER = "enabled";
      process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
      const allowed = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-draft-workspace`, { headers: { Authorization: `Bearer ${generateToken(finance)}` } });
      assert.equal(allowed.status, 200);
      const workspace = (await allowed.json()).data;
      assert.equal(workspace.currency, "USD");
      assert.equal(workspace.lines[0].available_sources[0].source_id, "ws-1");
      const drafts = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, { headers: { Authorization: `Bearer ${generateToken(finance)}` } });
      assert.equal(drafts.status, 200);
      assert.deepEqual((await drafts.json()).data, []);
      const denied = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-draft-workspace`, { headers: { Authorization: `Bearer ${generateToken(management)}` } });
      assert.equal(denied.status, 403);
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API refuses a stale draft after commercial authority changes and consumes nothing", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-stale-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      const changed = await store.read();
      changed.db.quote_lines.find((line) => line.id === "line-1").unit_price_cents = 2000;
      store.write(changed.db, changed.release);
      const issueResponse = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-stale-issue-0001" })
      });
      assert.equal(issueResponse.status, 409);
      assert.equal((await issueResponse.json()).code, "V5_INVOICE_DRAFT_STALE");
      const after = await store.read();
      assert.equal(after.db.v5_invoices.length, 0);
      assert.equal(after.db.v5_invoice_source_consumption.length, 0);
      assert.equal(after.db.v5_invoice_drafts[0].status, "prepared");
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API replays a permitted issue request without a second invoice or consumption", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-replay-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      const draft = (await draftResponse.json()).data;
      const issue = async () => fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-replay-issue-0001" })
      });
      const first = await issue();
      assert.equal(first.status, 201);
      const invoice = (await first.json()).data;
      const replay = await issue();
      assert.equal(replay.status, 200);
      const replayBody = await replay.json();
      assert.equal(replayBody.idempotent_replay, true);
      assert.equal(replayBody.data.id, invoice.id);
      const after = await store.read();
      assert.equal(after.db.v5_invoices.length, 1);
      assert.equal(after.db.v5_invoice_source_consumption.length, 1);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer JSON single-process acknowledgement still serializes simultaneous issue attempts", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-concurrent-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      const draft = (await draftResponse.json()).data;
      const issue = () => fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-concurrent-issue-0001" })
      });
      const responses = await Promise.all([issue(), issue()]);
      const statuses = (await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() })))).sort((left, right) => left.status - right.status);
      assert.deepEqual(statuses.map((item) => item.status), [200, 201]);
      assert.equal(statuses[0].body.idempotent_replay, true);
      assert.equal(statuses[0].body.data.id, statuses[1].body.data.id);
      const after = await store.read();
      assert.equal(after.db.v5_invoices.length, 1);
      assert.equal(after.db.v5_invoice_source_consumption.length, 1);
      assert.equal(after.db.v5_invoice_number_ledger[0].last_sequence, 1);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice issue uses the PostgreSQL adapter without JSON acknowledgement and rolls back every writer record on a failed write", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  delete process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS;
  let fake;
  try {
    await withInvoiceReadyApi(async ({ finance, admin, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-pg-rollback-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      fake.state.failUpdate = true;
      const failed = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-pg-rollback-issue-0001" })
      });
      assert.equal(failed.status, 500);
      const afterFailure = await store.read();
      assert.equal(afterFailure.db.v5_invoice_drafts.length, 1);
      assert.equal(afterFailure.db.v5_invoices.length, 0);
      assert.equal(afterFailure.db.v5_invoice_lines.length, 0);
      assert.equal(afterFailure.db.v5_invoice_source_consumption.length, 0);
      assert.equal(afterFailure.db.v5_invoice_events.length, 0);
      assert.equal(afterFailure.db.v5_invoice_number_ledger.length, 0);
      assert.equal(afterFailure.db.v5_invoice_idempotency.filter((item) => item.command === "issue").length, 0);
      await store.release(afterFailure.release);
      fake.state.failUpdate = false;
      const retry = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-pg-rollback-issue-0001" })
      });
      assert.equal(retry.status, 201);
      const afterRetry = await store.read();
      assert.equal(afterRetry.db.v5_invoices.length, 1);
      assert.equal(afterRetry.db.v5_invoice_source_consumption.length, 1);
      assert.equal(afterRetry.db.v5_invoice_number_ledger.length, 1);
      await store.release(afterRetry.release);
    }, null, (db) => {
      fake = createFakePostgresPool(db);
      return createPostgresStore(":memory:", fake.pool);
    });
    assert.ok(fake.state.rollbacks >= 1);
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API refuses reuse of a draft idempotency key with changed evidence", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, store, baseUrl }) => {
      const request = (quantity) => fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-key-reuse-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity }] }]
        })
      });
      assert.equal((await request(9)).status, 201);
      const conflict = await request(8);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, "IDEMPOTENCY_KEY_REUSED");
      const after = await store.read();
      assert.equal(after.db.v5_invoice_drafts.length, 1);
      assert.equal(after.db.v5_invoices.length, 0);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API refuses a dispatch already covered by a non-voided legacy invoice", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, store, baseUrl }) => {
      const response = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-legacy-block-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).blockers[0].code, "V5_LEGACY_INVOICE_EXISTS");
      const after = await store.read();
      assert.equal(after.db.v5_invoice_drafts.length, 0);
      assert.equal(after.db.v5_invoices.length, 0);
      after.release();
    }, (db) => {
      db.invoices = [{ id: "legacy-invoice-1", dispatch_card_id: "job-1", purchase_order_id: "po-http", total_amount: 225 }];
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API rechecks the verified PO ceiling when issuing a prepared draft", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, admin, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-po-recheck-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      const changed = await store.read();
      changed.db.purchase_orders.find((po) => po.id === "po-http").po_amount = 100;
      store.write(changed.db, changed.release);
      const issueResponse = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(admin)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-po-recheck-issue-0001" })
      });
      assert.equal(issueResponse.status, 409);
      assert.equal((await issueResponse.json()).code, "INVOICE_EXCEEDS_PO_REMAINING");
      const after = await store.read();
      assert.equal(after.db.v5_invoices.length, 0);
      assert.equal(after.db.v5_invoice_source_consumption.length, 0);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});

test("V5 invoice-writer API requires a different authorised user to issue a prepared draft", async () => {
  const previous = rememberV5Environment();
  process.env.ORAC_V5_COMMERCIAL_WORKFLOW = "enabled";
  process.env.ORAC_V5_INVOICE_WRITER = "enabled";
  process.env.ORAC_V5_INVOICE_JSON_SINGLE_PROCESS = "acknowledged";
  try {
    await withInvoiceReadyApi(async ({ finance, store, baseUrl }) => {
      const draftResponse = await fetch(`${baseUrl}/dispatch_cards/job-1/v5-invoice-drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({
          idempotency_key: "v5-http-two-person-draft-0001",
          lines: [{ quote_line_id: "line-1", sources: [{ source_type: "field_worksheet", source_id: "ws-1", quantity: 9 }] }]
        })
      });
      assert.equal(draftResponse.status, 201);
      const draft = (await draftResponse.json()).data;
      const selfIssue = await fetch(`${baseUrl}/v5-invoice-drafts/${draft.id}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${generateToken(finance)}` },
        body: JSON.stringify({ idempotency_key: "v5-http-two-person-issue-0001" })
      });
      assert.equal(selfIssue.status, 403);
      assert.equal((await selfIssue.json()).code, "V5_INVOICE_TWO_PERSON_REQUIRED");
      const after = await store.read();
      assert.equal(after.db.v5_invoices.length, 0);
      assert.equal(after.db.v5_invoice_source_consumption.length, 0);
      after.release();
    });
  } finally {
    restoreV5Environment(previous);
  }
});
