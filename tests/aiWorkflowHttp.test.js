import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HTTP-level test for the assistant routes (real Express app, real router,
// real auth middleware, real JSON file store in a temp directory).
//
// STATUS: WRITTEN BUT NOT EXECUTED BY THE AUTHOR. The authoring sandbox had no
// express/jsonwebtoken/bcrypt/zod/pg installed and no network (npm registry
// returned 403), so this file was only checked to skip cleanly there. It is
// modelled on tests/internalWorkRequestsHttp.test.js. Run it first after
// `npm ci`; if it fails, treat that as unverified test code, not automatically
// a product bug. Expected values were cross-checked against direct controller
// calls (see VALIDATION_REPORT.md).
let deps = null;
try {
  const express = (await import("express")).default;
  const router = (await import("../src/router.js")).default;
  const { persistenceMiddleware } = await import("../src/persistenceMiddleware.js");
  const { createStore } = await import("../src/store.js");
  const { generateToken } = await import("../src/middleware/auth.js");
  deps = { express, router, persistenceMiddleware, createStore, generateToken };
} catch (error) {
  deps = { error };
}
const skip = deps.error ? `dependencies unavailable: ${deps.error.code || deps.error.message}` : false;

const USERS = {
  Admin: { id: "u_admin", email: "admin@orac.co.zw", role: "Admin", is_active: true },
  Management: { id: "u_management", email: "management@orac.co.zw", role: "Management", is_active: true },
  Sales: { id: "u_sales", email: "sales@orac.co.zw", role: "Sales", is_active: true },
  Finance: { id: "u_finance", email: "finance@orac.co.zw", role: "Finance", is_active: true },
  Operations: { id: "u_ops", email: "ops@orac.co.zw", role: "Operations", is_active: true },
  Technician: { id: "u_tech", email: "tech@orac.co.zw", role: "Technician", is_active: true },
  Supervisor: { id: "u_supervisor", email: "supervisor@orac.co.zw", role: "Supervisor", is_active: true },
  "Client Viewer": { id: "u_client", email: "client@orac.co.zw", role: "Client Viewer", is_active: true }
};

function buildApp(store) {
  const { express, router, persistenceMiddleware } = deps;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", router);
  app.use("/api", (req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." }));
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "orac-ai-http-"));
  const file = join(dir, "db.json");
  return { store: deps.createStore(file), file };
}

const call = (url, user, body, method = "POST") => fetch(url, {
  method,
  headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${deps.generateToken(user)}` } : {}) },
  ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) })
});

test("assistant routes require a bearer token", { skip }, async () => {
  const { store } = makeStore();
  await withServer(buildApp(store), async (base) => {
    for (const [method, path] of [["GET", "/ai/health"], ["POST", "/ai/chat"], ["POST", "/ai/workflow"], ["POST", "/ai/briefing"], ["POST", "/ai/record-analysis"], ["POST", "/ai/feedback"]]) {
      const res = await call(`${base}${path}`, null, { message: "hi" }, method);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
});

test("record-analysis HTTP endpoint requires the trail flag and returns role-scoped cited evidence", { skip }, async () => {
  const { store } = makeStore();
  const { db, release } = await store.read();
  db.users = Object.values(USERS);
  db.clients = [{ id: "client-a", name: "Fictional Client" }];
  db.leads = [{ id: "lead-a", client_id: "client-a", status: "New", created_at: "2026-01-01T00:00:00.000Z" }];
  db.quotes = [{ id: "quote-a", client_id: "client-a", source_lead_id: "lead-a", status: "Approved_Pending_PO", quote_number: "Q-SYN-1", created_at: "2026-01-02T00:00:00.000Z" }];
  db.purchase_orders = [];
  db.dispatch_cards = [{ id: "dispatch-a", dispatch_number: "D-SYN-1", status: "In_Progress", assigned_technician_id: "u_tech" }];
  db.field_worksheets = [{ id: "ws-a", dispatch_card_id: "dispatch-a", technician_id: "u_tech", status: "Supervisor_Approved", work_date: "2026-10-10", hourly_rate: 900, notes: "private" }];
  db.timesheets = [{ id: "ts-a", dispatch_card_id: "dispatch-a", technician_id: "u_tech", entry_source: "kiosk", review_status: "pending_review", work_date: "2026-10-10", hours_logged: 8, hourly_rate: 900, notes: "private" }];
  db.audit_logs = [];
  store.write(db, release);

  const previous = process.env.ORAC_RECORD_TRAIL_V1;
  try {
    delete process.env.ORAC_RECORD_TRAIL_V1;
    await withServer(buildApp(store), async (base) => {
      const off = await call(`${base}/ai/record-analysis`, USERS.Admin, { record_type: "quote", record_id: "quote-a" });
      assert.equal(off.status, 404);
      process.env.ORAC_RECORD_TRAIL_V1 = "enabled";
      const result = await call(`${base}/ai/record-analysis`, USERS.Admin, { record_type: "quote", record_id: "quote-a" });
      assert.equal(result.status, 200);
      const body = await result.json();
      assert.equal(body.data.mode, "deterministic-evidence-summary");
      assert.deepEqual(body.data.evidenceRefs.map((item) => item.targetId), ["lead-a", "quote-a"]);
      const denied = await call(`${base}/ai/record-analysis`, USERS.Technician, { record_type: "quote", record_id: "quote-a" });
      assert.equal(denied.status, 404);
      const dispatch = await call(`${base}/ai/record-analysis`, USERS.Technician, { record_type: "dispatch", record_id: "dispatch-a" });
      assert.equal(dispatch.status, 200);
      const dispatchBody = await dispatch.json();
      assert.deepEqual(dispatchBody.data.evidenceRefs.map((item) => item.targetId), ["dispatch-a", "ws-a", "ts-a"]);
      assert.equal(dispatchBody.data.evidence.timesheets[0].counts_as_approved, false);
      assert.equal(JSON.stringify(dispatchBody).includes("hourly_rate"), false);
      const hiddenDispatch = await call(`${base}/ai/record-analysis`, USERS.Technician, { record_type: "dispatch", record_id: "missing-or-unassigned" });
      assert.equal(hiddenDispatch.status, 404);
      const invoice = await call(`${base}/ai/record-analysis`, USERS.Admin, { record_type: "invoice", record_id: "invoice-a" });
      assert.equal(invoice.status, 404, "unknown invoices remain non-confirming, not unsupported types");
      const unsupported = await call(`${base}/ai/record-analysis`, USERS.Admin, { record_type: "payment", record_id: "payment-a" });
      assert.equal(unsupported.status, 400);
    });
  } finally {
    if (previous === undefined) delete process.env.ORAC_RECORD_TRAIL_V1;
    else process.env.ORAC_RECORD_TRAIL_V1 = previous;
  }
});

test("every seeded role gets deterministic read-only health and a cited guide", { skip }, async () => {
  const { store } = makeStore();
  await withServer(buildApp(store), async (base) => {
    for (const [role, user] of Object.entries(USERS)) {
      const health = await (await call(`${base}/ai/health`, user, null, "GET")).json();
      assert.equal(health.data.mode, "deterministic-read-only", role);
      assert.equal(health.data.provider, null);
      const topic = health.data.workflow_topics[0];
      const guide = await (await call(`${base}/ai/workflow`, user, { article_id: topic.id })).json();
      assert.equal(guide.data.label, "Workflow guidance", role);
      assert.equal(guide.data.guidance.articleId, topic.id);
    }
  });
});

test("role and client come from the stored account, never from the request body", { skip }, async () => {
  const { store } = makeStore();
  await withServer(buildApp(store), async (base) => {
    // Client Viewer claims Admin + another client in the body; the answer must
    // still be the Client Viewer's own part and must not mention the other client.
    const chat = await (await call(`${base}/ai/chat`, USERS["Client Viewer"], { message: "how do I raise an invoice?", role: "Admin", client_id: "c_mimosa" })).json();
    assert.equal(chat.data.label, "Workflow guidance");
    assert.ok(!JSON.stringify(chat).includes("c_mimosa"));
    assert.ok(chat.data.links.every((l) => l.id !== "finance"), "Client Viewer must not be linked to Finance");
    const guide = await (await call(`${base}/ai/workflow`, USERS["Client Viewer"], { article_id: "invoicing", role: "Finance" })).json();
    assert.equal(guide.data.guidance?.articleId, "invoicing");
    assert.match(guide.data.guidance.yourPart.do, /own organisation only/);
    const tech = await (await call(`${base}/ai/workflow`, USERS.Technician, { article_id: "invoicing" })).json();
    assert.equal(tech.data.label, "Declined");
    assert.equal(tech.data.guidance, null);
  });
});

test("a chat request writes one structured audit row and never stores the question", { skip }, async () => {
  const { store, file } = makeStore();
  await withServer(buildApp(store), async (base) => {
    const question = "how do I review a timesheet? httpsecretmarker9931";
    const res = await call(`${base}/ai/chat`, USERS.Supervisor, { message: question });
    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200)); // allow the persistence middleware to flush
    const db = JSON.parse(readFileSync(file, "utf8"));
    const rows = db.audit_logs.filter((row) => row.action === "AI_PHASE_0_5_RESPONSE");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].new_values.outcome, "answered");
    assert.ok(!JSON.stringify(db.audit_logs).includes("httpsecretmarker9931"));
  });
});

test("a token for a non-existent user cannot use the assistant (401)", { skip }, async () => {
  const { store } = makeStore();
  await withServer(buildApp(store), async (base) => {
    const ghost = { id: "u_ghost", email: "ghost@example.invalid", role: "Admin", is_active: true };
    const res = await call(`${base}/ai/chat`, ghost, { message: "how do I approve a timesheet?" });
    assert.equal(res.status, 401);
  });
});
