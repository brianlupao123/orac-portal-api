import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

// HTTP[real router], JSON store on a TEMP file. Fictional data only.
const USERS = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance", Operations: "u_ops",
  Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client", Supervisor2: "u_supervisor2"
};
const ROLE_OF = (k) => (k === "Supervisor2" ? "Supervisor" : k);

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  return app;
}
async function withServer(app, run) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "orac-dts-queue-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  const { db, release } = await store.read();
  if (!db.users.some((u) => u.id === "u_supervisor2")) db.users.push({ id: "u_supervisor2", name: "Supervisor Two", email: "sup2@fx.test", role: "Supervisor", is_active: true });
  const t = db.users.find((u) => u.id === "u_tech");
  t.password_hash = "SECRET-HASH-DO-NOT-LEAK";
  t.payment_details = { v: 1, data: "SECRET-ENVELOPE", fields: ["bank_account"] };
  const sheet = (id, status, extra = {}) => ({ id, status, name_on_form: "Fictional Worker", technician_id: "u_tech", entries: [], created_by: "u_tech", submitted_by: "u_tech", created_at: "2026-09-01T00:00:00.000Z", ...extra });
  db.daily_timesheets.push(sheet("dts_sub", "Submitted"), sheet("dts_sub2", "Submitted"), sheet("dts_draft", "Draft", { submitted_by: null }), sheet("dts_done", "Supervisor_Approved", { approved_by: "u_supervisor", approved_at: "2026-09-02T00:00:00.000Z" }), sheet("dts_own", "Submitted", { created_by: "u_supervisor", submitted_by: "u_supervisor2" }));
  store.write(db, release);
  return { store, disk: () => JSON.parse(readFileSync(file, "utf8")) };
}
const tokenFor = (k) => generateToken({ id: USERS[k], email: `${k}@fx.test`, role: ROLE_OF(k), is_active: true });
const call = (base, k, path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(k)}` }, body: body === undefined ? undefined : JSON.stringify(body)
});
const json = async (r) => ({ status: r.status, body: await r.json() });

test("two Supervisors see the same awaiting-review sheets and never drafts; each listing is audited", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    const a = await json(await call(base, "Supervisor", "/daily-timesheet-review-queue"));
    const b = await json(await call(base, "Supervisor2", "/daily-timesheet-review-queue"));
    assert.equal(a.status, 200);
    const ids = (r) => r.body.data.map((x) => x.id).sort();
    assert.deepEqual(ids(a), ["dts_own", "dts_sub", "dts_sub2"]);
    assert.deepEqual(ids(a), ids(b));
    const views = w.disk().audit_logs.filter((x) => x.action === "DAILY_TIMESHEET_QUEUE_VIEWED");
    assert.equal(views.length, 2);
    assert.deepEqual(views.map((v) => v.actor_id).sort(), ["u_supervisor", "u_supervisor2"]);
  });
});

test("Technician, Sales, Finance, Management and Client Viewer get 403 from the queue", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    for (const k of ["Technician", "Sales", "Finance", "Management", "Client Viewer"]) assert.equal((await call(base, k, "/daily-timesheet-review-queue")).status, 403, k);
    assert.equal((await call(base, "Admin", "/daily-timesheet-review-queue")).status, 200);
    assert.equal((await call(base, "Operations", "/daily-timesheet-review-queue")).status, 200);
  });
});

test("the print document never carries a password hash or payment envelope, and others' views are audited", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    for (const k of ["Supervisor", "Admin", "Operations", "Management", "Technician"]) {
      const text = await (await call(base, k, "/document-data/daily_timesheets/dts_sub")).text();
      assert.equal(/SECRET-HASH|SECRET-ENVELOPE|password_hash|payment_details/.test(text), false, k);
    }
    const views = w.disk().audit_logs.filter((x) => x.action === "DAILY_TIMESHEET_DOCUMENT_VIEWED");
    assert.deepEqual(views.map((v) => v.actor_id).sort(), ["u_admin", "u_management", "u_ops", "u_supervisor"], "the worker's own view is not an access event");
  });
});

test("review: the creator cannot approve; an independent Supervisor can; a return needs a reason; the decision is audited", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    assert.equal((await call(base, "Supervisor", "/daily_timesheets/dts_own/review", { method: "POST", body: { decision: "approve" } })).status, 403, "creator");
    assert.equal((await call(base, "Supervisor2", "/daily_timesheets/dts_own/review", { method: "POST", body: { decision: "approve" } })).status, 403, "submitter");
    assert.equal((await call(base, "Supervisor", "/daily_timesheets/dts_sub/review", { method: "POST", body: { decision: "return" } })).status, 400, "return needs a comment");
    assert.equal((await call(base, "Supervisor", "/daily_timesheets/dts_sub/review", { method: "POST", body: { decision: "approve" } })).status, 200);
    assert.ok(w.disk().audit_logs.some((x) => x.action === "DAILY_TIMESHEET_APPROVED" && x.actor_id === "u_supervisor" && x.entity_id === "dts_sub"));
  });
});

test("concurrent decisions on one sheet: one is accepted, the other is refused", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    const [x, y] = await Promise.all([
      call(base, "Supervisor", "/daily_timesheets/dts_sub2/review", { method: "POST", body: { decision: "approve" } }),
      call(base, "Supervisor2", "/daily_timesheets/dts_sub2/review", { method: "POST", body: { decision: "return", comment: "Hours do not match the paper" } })
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 400]);
    const decisions = w.disk().audit_logs.filter((a) => a.entity_id === "dts_sub2" && /^DAILY_TIMESHEET_(APPROVED|RETURNED)$/.test(a.action));
    assert.equal(decisions.length, 1);
  });
});

test("reopen: Admin only, reason required, prior decision kept, audited", async () => {
  const w = await world();
  await withServer(buildApp(w.store), async (base) => {
    for (const k of ["Supervisor", "Operations", "Management", "Finance", "Technician", "Sales", "Client Viewer"]) {
      assert.equal((await call(base, k, "/daily_timesheets/dts_done/reopen", { method: "POST", body: { reason: "Approved by mistake" } })).status, 403, k);
    }
    assert.equal((await call(base, "Admin", "/daily_timesheets/dts_done/reopen", { method: "POST", body: {} })).status, 400, "reason required");
    assert.equal((await call(base, "Admin", "/daily_timesheets/dts_sub/reopen", { method: "POST", body: { reason: "Not reviewed yet" } })).status, 409, "only reviewed sheets reopen");
    const r = await json(await call(base, "Admin", "/daily_timesheets/dts_done/reopen", { method: "POST", body: { reason: "Approved by mistake" } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "Submitted");
    assert.equal(r.body.data.reopened_from.status, "Supervisor_Approved");
    assert.equal(r.body.data.reopened_from.approved_by, "u_supervisor");
    const row = w.disk().audit_logs.find((a) => a.action === "DAILY_TIMESHEET_REOPENED");
    assert.equal(row.actor_id, "u_admin");
    assert.equal(JSON.stringify(row).includes("Approved by mistake"), true, "the reason is recorded");
  });
});
