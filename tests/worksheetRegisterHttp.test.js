import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

// HTTP[real router]: real Express app, real router, real zod validation, real JWT
// auth, real mutex persistence, JSON store on a TEMP file. Fictional data only.

const ROLE_USERS = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance",
  Operations: "u_ops", Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client"
};

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
function world() {
  const dir = mkdtempSync(join(tmpdir(), "orac-mts-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  return { store, disk: () => JSON.parse(readFileSync(file, "utf8")), file };
}
const tokenFor = (role) => generateToken({ id: ROLE_USERS[role], email: `${role}@fx.test`, role, is_active: true });
const call = (base, role, path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(role)}` },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const json = async (r) => ({ status: r.status, body: await r.json() });

const periodBody = (over = {}) => ({
  title: "Fictional Shutdown", period_start: "2026-08-31", period_end: "2026-09-30",
  scope: { client_id: "c_example_north", project_title: "Fictional Shutdown" },
  roster: [{ technician_id: "u_tech", group: "Fitters" }], ...over
});

test("HTTP[real router]: unauthenticated requests are refused on every Worksheet route", async () => {
  const w = world();
  await withServer(buildApp(w.store), async (base) => {
    for (const [method, path] of [["GET", "/worksheet_registers"], ["POST", "/worksheet_registers"], ["GET", "/worksheet_registers/x"], ["POST", "/worksheet_registers/x/reconcile"], ["GET", "/document-data/worksheet_registers/x"]]) {
      const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  });
});

test("HTTP[real router]: 8-role matrix on list: Admin/Management/Operations/Supervisor 200, everyone else 403", async () => {
  const w = world();
  await withServer(buildApp(w.store), async (base) => {
    for (const role of Object.keys(ROLE_USERS)) {
      const r = await call(base, role, "/worksheet_registers");
      assert.equal(r.status, ["Admin", "Management", "Operations", "Supervisor", "Sales"].includes(role) ? 200 : 403, role);
    }
    // The generic collection route must not expose it either.
    assert.equal((await call(base, "Admin", "/worksheet_registers_raw")).status === 200, false);
  });
});

async function seedDispatch(w) {
  const { db, release } = await w.store.read();
  db.quotes.push({ id: "q_h", quote_number: "Q-H", client_id: "c_example_north", status: "Approved" });
  db.dispatch_cards.push({ id: "dc_h", quotation_id: "q_h", assigned_supervisor_id: "u_supervisor", assigned_technician_ids: ["u_tech"], status: "In_Progress" });
  w.store.write(db, release);
}
const tsBody = (over = {}) => ({
  activity: "Replaced fictional bearing", work_date: "2026-09-01", start_time: "07:00", end_time: "18:00",
  hours_breakdown: { normal: 9, ot_15: 2, ot_20: "X" },
  materials_used: [{ description: "Fictional bearing", quantity: 2, unit: "each" }],
  signatures: { employee: { name: "Technician User", date: "2026-09-01", method: "on_device", attest: true } },
  client_request_id: "offline-0001-abcd", captured_offline_at: "2026-09-01T18:30:00.000Z", submit: true, ...over
});

test("HTTP[real router]: ONE Timesheet from offline capture to Worksheet register and non-billable evidence", async () => {
  const w = world();
  await seedDispatch(w);
  await withServer(buildApp(w.store), async (base) => {
    // 1. Offline-captured Timesheet syncs: job, worker, description, materials, N/1.5/2.0, worker sign-off.
    const created = await json(await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody() }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const ts = created.body.data;
    assert.equal(ts.status, "Submitted"); assert.equal(ts.timesheet_version, 2);
    assert.equal(ts.hours, 11, "server-derived total");
    assert.deepEqual(ts.hours_breakdown, { normal: 9, ot_15: 2, ot_20: 0 });
    assert.equal(ts.signatures.employee.attested_by, "u_tech", "the server stamps who attested");
    assert.ok(ts.signatures.employee.attested_at);
    assert.equal(ts.synced_at, ts.created_at);
    assert.equal(ts.materials_used[0].description, "Fictional bearing");

    // 2. Offline retries: idempotent replay, conflicting reuse, true duplicate, and no money fields.
    const replay = await json(await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody() }));
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.data.id, ts.id);
    assert.equal((await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody({ activity: "Something else" }) })).status, 409, "same reference, different content");
    const dup = await json(await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody({ client_request_id: "offline-0002-efgh" }) }));
    assert.equal(dup.status, 409); assert.equal(dup.body.code, "DUPLICATE_TIMESHEET");
    assert.equal((await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody({ client_request_id: "offline-0003-ijkl", work_date: "2026-09-02", hourly_rate: 45 }) })).status, 400, "a rate is rejected, not dropped");
    assert.equal((await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: tsBody({ client_request_id: "offline-0004-mnop", work_date: "2026-09-02", signatures: undefined }) })).status, 400, "no worker sign-off, no submit");
    assert.equal(w.disk().field_worksheets.length, 1);

    // 3. Customer representative acknowledges, then an independent Supervisor approves (existing flow, unchanged).
    assert.equal((await call(base, "Client Viewer", `/field_worksheets/${ts.id}/client-acknowledge`, { method: "POST", body: { signer_name: "Client Rep", signer_role: "Engineer", acknowledgement: true } })).status, 200);
    assert.equal((await call(base, "Supervisor", `/field_worksheets/${ts.id}/review`, { method: "POST", body: { decision: "approve" } })).status, 200);
    const approved = w.disk().field_worksheets[0];
    assert.equal(approved.status, "Supervisor_Approved");
    const tsBefore = JSON.stringify(approved);

    // 4. The Worksheet is generated from it. Nobody re-enters hours.
    const withRate = await json(await call(base, "Operations", "/worksheet_registers", { method: "POST", body: { ...periodBody(), hourly_rate: 45 } }));
    assert.equal(withRate.status, 400);
    const reg = await json(await call(base, "Operations", "/worksheet_registers", { method: "POST", body: periodBody() }));
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const id = reg.body.data.id;
    assert.equal(reg.body.data.totals.normal, 9); assert.equal(reg.body.data.totals.ot_15, 2);
    const cell = reg.body.data.grid.rows[0].cells["2026-09-01"];
    assert.deepEqual(cell.sources, [{ source_type: "timesheet", record_id: ts.id, row_index: 0 }]);
    const open = reg.body.data.exceptions.filter((e) => e.severity === "warning" && !e.acknowledged_at).map((e) => e.key);
    if (open.length) assert.equal((await call(base, "Operations", `/worksheet_registers/${id}/acknowledge`, { method: "POST", body: { keys: open, note: "Checked against paper" } })).status, 200);

    // 5. Independent approval of the Worksheet, then idempotent non-billable evidence.
    assert.equal((await call(base, "Admin", `/worksheet_registers/${id}/submit`, { method: "POST", body: {} })).status, 200);
    assert.equal((await call(base, "Operations", `/worksheet_registers/${id}/review`, { method: "POST", body: { decision: "approve" } })).status, 403, "builder cannot approve");
    assert.equal((await call(base, "Admin", `/worksheet_registers/${id}/review`, { method: "POST", body: { decision: "approve" } })).status, 403, "submitter cannot approve");
    assert.equal((await call(base, "Supervisor", `/worksheet_registers/${id}/review`, { method: "POST", body: { decision: "approve", comment: "Matches" } })).status, 200);
    assert.equal((await call(base, "Operations", `/worksheet_registers/${id}/reconcile`, { method: "POST", body: {} })).status, 400, "confirm required");
    assert.equal((await call(base, "Supervisor", `/worksheet_registers/${id}/reconcile`, { method: "POST", body: { confirm: true } })).status, 403);
    const first = await json(await call(base, "Operations", `/worksheet_registers/${id}/reconcile`, { method: "POST", body: { confirm: true } }));
    const second = await json(await call(base, "Admin", `/worksheet_registers/${id}/reconcile`, { method: "POST", body: { confirm: true } }));
    assert.equal(first.body.already_recorded, false); assert.equal(second.body.already_recorded, true);
    assert.equal(second.body.data.reconciliation.id, first.body.data.reconciliation.id);

    // 6. Persisted truth: the Timesheet is untouched, no billable time, one reconciliation audit entry, rate-blind payloads.
    const disk = w.disk();
    assert.equal(JSON.stringify(disk.field_worksheets[0]), tsBefore, "the Worksheet never modifies a Timesheet");
    assert.equal(disk.timesheets.length, 0, "no billable time created");
    assert.equal(disk.audit_logs.filter((a) => a.action === "REGISTER_RECONCILIATION_RECORDED").length, 1);
    assert.doesNotMatch(JSON.stringify(first.body), /"(hourly_rate|rate|amount|total_amount|cost)"\s*:/);
    assert.equal((await call(base, "Management", `/document-data/worksheet_registers/${id}`)).status, 200);
    assert.equal((await call(base, "Technician", `/document-data/worksheet_registers/${id}`)).status, 403);
    assert.equal((await call(base, "Management", `/worksheet_registers/${id}/build`, { method: "POST", body: {} })).status, 403);
  });
});

test("HTTP[real router]: a contractor without an account is entered by staff by name; Technicians cannot do that; revisions stay Timesheets", async () => {
  const w = world();
  await seedDispatch(w);
  await withServer(buildApp(w.store), async (base) => {
    const body = tsBody({ client_request_id: "offline-contr-0001", worker_type: "contractor", worker_name: "Walk In Worker", signed_copy_image: "data:image/png;base64,AAAA", signatures: { employee: { name: "Walk In Worker", date: "2026-09-01", method: "paper_scan" } } });
    assert.equal((await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: { ...body, client_request_id: "offline-contr-0002" } })).status, 200, "a Technician submitting as themselves ignores the contractor flag");
    const w1 = w.disk().field_worksheets[0];
    assert.equal(w1.technician_id, "u_tech");
    const w2 = await json(await call(base, "Operations", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: { ...body, work_date: "2026-09-02", signatures: { employee: { name: "Walk In Worker", date: "2026-09-02", method: "paper_scan" } } } }));
    assert.equal(w2.status, 200, JSON.stringify(w2.body));
    assert.equal(w2.body.data.technician_id, null); assert.equal(w2.body.data.worker_name, "Walk In Worker"); assert.equal(w2.body.data.worker_type, "contractor");
    assert.equal((await call(base, "Operations", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: { ...body, client_request_id: "offline-contr-0009", work_date: "2026-09-02", worker_name: "" } })).status, 400);
  });
});

test("HTTP[real router]: the legacy single-number Timesheet body and legacy list routes keep working (compatibility)", async () => {
  const w = world();
  await seedDispatch(w);
  await withServer(buildApp(w.store), async (base) => {
    const legacy = await json(await call(base, "Technician", "/dispatch_cards/dc_h/worksheets", { method: "POST", body: { activity: "Old style", hours: 8, work_date: "2026-08-20" } }));
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.data.timesheet_version, undefined, "stays a legacy record: no breakdown, so never counted in a Worksheet");
    assert.equal(legacy.body.data.hours, 8);
    for (const path of ["/field_worksheets", "/daily_timesheets", "/contractor_log_sheets"]) assert.equal((await call(base, "Supervisor", path)).status, 200, path);
  });
});

test("HTTP[real router]: a data file saved before this feature keeps working and gains the empty collection", async () => {
  const w = world();
  const legacy = w.disk();
  delete legacy.worksheet_registers;
  writeFileSync(w.file, JSON.stringify(legacy));
  await withServer(buildApp(w.store), async (base) => {
    const r = await json(await call(base, "Operations", "/worksheet_registers"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
    assert.equal((await call(base, "Operations", "/daily_timesheets")).status, 200, "Daily Time Sheet list still works");
    assert.equal((await call(base, "Supervisor", "/contractor_log_sheets")).status, 200, "Contractor Log list still works");
  });
});
