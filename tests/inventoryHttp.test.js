import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";

// Task 02 - Express + auth HTTP tests for inventory purchase-to-use traceability.
// Real Express app, real router, real validate() schemas, real JWT auth middleware,
// real mutex persistence and a real JSON store on a TEMP file (never data/db.json).
// All records below are fictional test fixtures injected into that temp file only.

// BASELINE DEFECT (owner: Task 03 - field work / roster): src/router.js imports
// `getDispatchRoster` from dispatchController.js, which does not export it, so the
// real router (and therefore server.js) cannot load. This suite does NOT implement
// that handler. It uses the real router whenever it loads; otherwise it loads a
// temporary copy of router.js with ONLY the roster GET route and its import name
// removed. Every inventory/material/auth route under test is untouched either way.
// Once Task 03 lands the export, the real router is used automatically.
const ROUTER_SRC = fileURLToPath(new URL("../src/router.js", import.meta.url));
let routerMode = "real";
async function loadRouter() {
  try {
    return (await import("../src/router.js")).default;
  } catch (error) {
    if (!/getDispatchRoster/.test(String(error?.message))) throw error;
    routerMode = "derived (baseline getDispatchRoster export missing - Task 03)";
    const text = readFileSync(ROUTER_SRC, "utf8")
      .replace(/,\s*getDispatchRoster/, "")
      .replace(/^.*router\.get\("\/dispatch_cards\/:id\/roster", getDispatchRoster\);.*$/m, "");
    assert.equal(/getDispatchRoster/.test(text), false, "derived router must drop only the roster references");
    const tmp = fileURLToPath(new URL(`../src/router.httptest-${process.pid}.js`, import.meta.url));
    writeFileSync(tmp, text);
    process.on("exit", () => { if (existsSync(tmp)) unlinkSync(tmp); });
    try { return (await import(pathToFileURL(tmp).href)).default; }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
}
const apiRouter = await loadRouter();

// Every title below carries this tag so a result can never be mistaken for full-application validation.
//  real router    : the production src/router.js loaded unmodified (still no server.js / CORS / static layer).
//  DERIVED router : a temporary COPY of src/router.js with ONLY the roster GET route removed, because the
//                   baseline router cannot load (getDispatchRoster missing - Task 03). It exercises the
//                   inventory/material/auth routes through real middleware, but it is NOT full-application
//                   HTTP validation and must not be reported as such.
const TAG = routerMode === "real"
  ? "HTTP[real router]"
  : "HTTP[DERIVED router: roster route removed - NOT full-application validation]";

test("HTTP harness: states which router the suite ran against", (t) => {
  t.diagnostic(`router mode: ${routerMode}`);
  if (routerMode !== "real") t.diagnostic("WARNING: derived router in use - results below are NOT full-application HTTP validation (baseline defect, Task 03).");
  assert.ok(typeof apiRouter === "function");
});

const ROLE_USERS = {
  Admin: "u_admin", Management: "u_management", Sales: "u_sales", Finance: "u_finance",
  Operations: "u_ops", Technician: "u_tech", Supervisor: "u_supervisor", "Client Viewer": "u_client"
};

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." });
  });
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "orac-inv-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.suppliers = [{ id: "sup-fx-1", name: "Fictional Supplies Ltd", is_active: true }];
  db.stock_items = [{ id: "si-fx-1", catalog_item_id: "cat-fx-1", item_code: "FX-GSK", item_name: "Fictional Gasket", unit_of_measure: "each", quantity_on_hand: 10, reorder_level: 2, unit_cost: 1, is_active: true }];
  db.stock_movements = [];
  db.material_usage = [];
  db.dispatch_cards = [{ id: "dc-fx-1", dispatch_number: "FX-JOB-1", assigned_technician_id: "u_tech", status: "In_Progress" }];
  writeFileSync(file, JSON.stringify(db, null, 2));
  return { store, file, disk: () => JSON.parse(readFileSync(file, "utf8")) };
}

const userFor = (role) => ({ id: ROLE_USERS[role], email: `${role}@fx.test`, role, is_active: true });
const call = (base, role, path, { method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${generateToken(userFor(role))}`, ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const receipt = (o = {}) => ({ stock_item_id: "si-fx-1", movement_type: "in", quantity: 5, reason: "Delivery received", reference_type: "supplier", reference_id: "sup-fx-1", source_document_ref: "DN-FX-1", ...o });
const usage = (o = {}) => ({ catalog_item_id: "cat-fx-1", description: "Fictional Gasket", quantity_used: 2, unit_cost: 1, ...o });

test(`${TAG}: no token or a forged token is refused before any inventory route runs`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    for (const path of ["/inventory/reconciliation", "/inventory/movements", "/stock_movements"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
      assert.equal((await fetch(`${base}${path}`, { headers: { Authorization: "Bearer not-a-real-token" } })).status, 401, path);
    }
    const post = await fetch(`${base}/inventory/movements`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt()) });
    assert.equal(post.status, 401);
  });
  assert.equal(w.disk().stock_movements.length, 0);
});

test(`${TAG}: 8-role matrix on GET /inventory/reconciliation (Admin/Management/Operations only)`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    for (const role of Object.keys(ROLE_USERS)) {
      const r = await call(base, role, "/inventory/reconciliation");
      const allowed = ["Admin", "Management", "Operations"].includes(role);
      assert.equal(r.status, allowed ? 200 : 403, role);
    }
  });
});

test(`${TAG}: a supplier receipt goes through auth + real schema + ledger; the on-disk record is kept, the response hides the fingerprint`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const r = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt({ idempotency_key: "http-key-0001" }) });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.equal(text.includes("idempotency_fingerprint"), false);
    assert.equal(JSON.parse(text).data.movement.source_document_ref, "DN-FX-1");
  });
  const disk = w.disk();
  assert.equal(disk.stock_items[0].quantity_on_hand, 15);
  assert.equal(disk.stock_movements.length, 1);
  assert.equal(JSON.stringify(disk.audit_logs).includes("idempotency_fingerprint"), false, "persisted audit log never carries the fingerprint");
});

test(`${TAG}: refused receipts (no supplier/document, client PO as evidence, reserved reference type) change nothing on disk`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const bad = [
      receipt({ reference_type: undefined, reference_id: undefined, source_document_ref: undefined }),
      receipt({ source_document_ref: undefined }),
      receipt({ reference_type: "purchase_order", reference_id: "po-1" }),
      receipt({ reference_type: "material_usage", reference_id: "mu-1" }),
      receipt({ reference_type: "direct_sale" })
    ];
    for (const body of bad) {
      const r = await call(base, "Operations", "/inventory/movements", { method: "POST", body });
      assert.ok([400, 409, 422].includes(r.status), `status ${r.status}`);
    }
  });
  const disk = w.disk();
  assert.equal(disk.stock_movements.length, 0);
  assert.equal(disk.stock_items[0].quantity_on_hand, 10);
});

test(`${TAG}: Idempotency-Key header and body key both make a repeated receipt apply once; reusing a key for a different payload is refused`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const a = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt(), headers: { "Idempotency-Key": "hdr-receipt-0001" } });
    const b = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt(), headers: { "Idempotency-Key": "hdr-receipt-0001" } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await b.json()).idempotent_replay, true);
    const c = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt({ quantity: 9 }), headers: { "Idempotency-Key": "hdr-receipt-0001" } });
    assert.equal(c.status, 409);
    const d1 = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt({ idempotency_key: "body-receipt-0001" }) });
    const d2 = await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt({ idempotency_key: "body-receipt-0001" }) });
    assert.equal(d1.status, 200);
    assert.equal((await d2.json()).idempotent_replay, true);
  });
  const disk = w.disk();
  assert.equal(disk.stock_movements.length, 2);
  assert.equal(disk.stock_items[0].quantity_on_hand, 20);
});

test(`${TAG}: a Technician's worksheet usage deducts atomically, a retry with the same key deducts once, and a different payload on that key is refused`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const path = "/dispatch_cards/dc-fx-1/materials";
    const first = await call(base, "Technician", path, { method: "POST", body: usage({ idempotency_key: "ws-key-0000001" }) });
    const retry = await call(base, "Technician", path, { method: "POST", body: usage({ idempotency_key: "ws-key-0000001" }) });
    assert.equal(first.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.idempotent_replay, true);
    assert.equal(JSON.stringify(retryBody).includes("idempotency_fingerprint"), false);
    const clash = await call(base, "Technician", path, { method: "POST", body: usage({ quantity_used: 3, idempotency_key: "ws-key-0000001" }) });
    assert.equal(clash.status, 409);
    const fresh = await call(base, "Technician", path, { method: "POST", body: usage({ idempotency_key: "ws-key-0000002" }) });
    assert.equal(fresh.status, 200);
  });
  const disk = w.disk();
  assert.equal(disk.material_usage.length, 2);
  assert.equal(disk.stock_movements.length, 2);
  assert.equal(disk.stock_items[0].quantity_on_hand, 6);
});

test(`${TAG}: concurrent duplicate worksheet submissions with one key deduct exactly once (real mutex)`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const send = () => call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body: usage({ idempotency_key: "race-key-0000001" }) });
    const results = await Promise.all([send(), send(), send(), send()]);
    for (const r of results) assert.equal(r.status, 200);
  });
  const disk = w.disk();
  assert.equal(disk.material_usage.length, 1);
  assert.equal(disk.stock_movements.length, 1);
  assert.equal(disk.stock_items[0].quantity_on_hand, 8);
});

test(`${TAG}: over-stock worksheet usage is refused with nothing written, even when override_negative is sent over the wire`, async () => {
  const w = makeWorld();
  const before = JSON.stringify(w.disk());
  await withServer(buildApp(w.store), async (base) => {
    for (const role of ["Technician", "Operations"]) {
      const r = await call(base, role, "/dispatch_cards/dc-fx-1/materials", { method: "POST", body: usage({ quantity_used: 99, override_negative: true }) });
      assert.ok([403, 409].includes(r.status), `${role}: ${r.status}`);
    }
  });
  const disk = w.disk();
  assert.equal(disk.material_usage.length, 0);
  assert.equal(disk.stock_movements.length, 0);
  assert.equal(disk.stock_items[0].quantity_on_hand, 10);
  assert.equal(JSON.stringify(disk.stock_items), JSON.stringify(JSON.parse(before).stock_items));
});

test(`${TAG}: Client Viewer, Sales, Finance, Supervisor and Technician cannot read the ledger by route or by generic collection`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt() });
    for (const role of ["Client Viewer", "Sales", "Finance", "Supervisor", "Technician"]) {
      for (const path of ["/inventory/movements", "/inventory/stock_items/si-fx-1/movements", "/stock_movements?client_id=c-1"]) {
        const r = await call(base, role, path);
        assert.equal(r.status, 403, `${role} ${path}`);
      }
    }
    for (const role of ["Admin", "Management", "Operations"]) {
      const generic = await call(base, role, "/stock_movements");
      assert.equal(generic.status, 200, role);
      assert.equal((await generic.text()).includes("idempotency_fingerprint"), false, role);
    }
  });
});

test(`${TAG}: the ledger is append-only - no PATCH/PUT/DELETE route exists for movements`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    await call(base, "Admin", "/inventory/movements", { method: "POST", body: receipt() });
    const id = w.disk().stock_movements[0].id;
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      for (const path of [`/inventory/movements/${id}`, `/stock_movements/${id}`]) {
        const r = await call(base, "Admin", path, { method, body: {} });
        assert.equal(r.status, 404, `${method} ${path}`);
      }
    }
    // The generic archive route must also refuse movement records.
    const arch = await call(base, "Admin", `/admin/stock_movements/${id}/deactivate`, { method: "POST" });
    assert.ok([403, 404, 405].includes(arch.status), `archive ${arch.status}`);
  });
  assert.equal(w.disk().stock_movements.length, 1);
});

test(`${TAG}: the dormant direct-sale endpoint stays disabled (404, no change) for every role unless explicitly enabled`, async () => {
  assert.notEqual(process.env.ENABLE_DIRECT_SALE_STOCK_ISSUE, "true", "test environment must not enable it");
  const w = makeWorld();
  const before = JSON.stringify(w.disk());
  await withServer(buildApp(w.store), async (base) => {
    for (const role of ["Admin", "Management", "Operations"]) {
      const r = await call(base, role, "/inventory/movements/direct-sale", { method: "POST", body: { stock_item_id: "si-fx-1", quantity: 1, reason: "x" } });
      assert.ok([400, 404].includes(r.status), `${role}: ${r.status}`);
      assert.equal(r.status === 200, false);
    }
  });
  assert.equal(JSON.stringify(w.disk().stock_movements), JSON.stringify(JSON.parse(before).stock_movements));
  assert.equal(w.disk().stock_items[0].quantity_on_hand, 10);
});

test(`${TAG}: reconciliation reports a valid fictional ledger as reconciled and never edits records`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt() });
    await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body: usage() });
    const snapshot = JSON.stringify(w.disk());
    const r = await call(base, "Management", "/inventory/reconciliation");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(JSON.stringify(w.disk()), snapshot, "a read-only report writes nothing");
    const report = body.data || body;
    const item = report.items.find((i) => i.item_code === "FX-GSK");
    assert.ok(item, "fictional item present in report");
    assert.deepEqual(item.exceptions, [], "a ledger built only through the API reconciles with no exceptions");
    assert.equal(item.quantity_on_hand, 13);
    assert.equal(item.ledger_balance, 13);
    assert.equal(report.totals.with_exceptions, 0);
  });
});

test(`${TAG} (T17): a failed write leaves ledger, usage and balance untouched; the same-key retry then applies exactly once`, async () => {
  const w = makeWorld();
  const realWrite = w.store.write.bind(w.store);
  let failNext = true;
  // Simulates the store failing mid-request (e.g. disk full). Like the real store, it still releases the mutex.
  w.store.write = (db, release) => {
    if (failNext) { failNext = false; if (release) release(); throw new Error("simulated disk failure"); }
    return realWrite(db, release);
  };
  const before = JSON.stringify(w.disk());
  await withServer(buildApp(w.store), async (base) => {
    const body = usage({ idempotency_key: "atomic-key-000001" });
    const failed = await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body });
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(w.disk()), before, "nothing was persisted by the failed request");
    const retry = await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotent_replay, undefined, "the failed attempt left no record, so this is the first real write");
    const again = await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body });
    assert.equal((await again.json()).idempotent_replay, true);
  });
  const disk = w.disk();
  assert.equal(disk.material_usage.length, 1);
  assert.equal(disk.stock_movements.length, 1);
  assert.equal(disk.stock_items[0].quantity_on_hand, 8);
});

test(`${TAG}: the existing low-stock notification still fires from the audit payload and never carries the fingerprint`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    const r = await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body: usage({ quantity_used: 9, idempotency_key: "notify-key-000001" }) });
    assert.equal(r.status, 200);
  });
  const disk = w.disk();
  assert.ok((disk.notifications || []).some((n) => n.title === "Low Stock Alert"), "reorder alert generated at the threshold");
  assert.equal(JSON.stringify(disk.notifications).includes("idempotency_fingerprint"), false);
  assert.equal(JSON.stringify(disk.audit_logs).includes("idempotency_fingerprint"), false);
});

test(`${TAG}: per-item history, the ledger list and the item list never return the fingerprint, and show the traceability fields`, async () => {
  const w = makeWorld();
  await withServer(buildApp(w.store), async (base) => {
    await call(base, "Operations", "/inventory/movements", { method: "POST", body: receipt({ idempotency_key: "hist-key-0000001" }) });
    await call(base, "Technician", "/dispatch_cards/dc-fx-1/materials", { method: "POST", body: usage({ idempotency_key: "hist-key-0000002" }) });
    for (const path of ["/inventory/stock_items/si-fx-1/movements", "/inventory/movements", "/inventory/stock_items", "/stock_movements", "/inventory/reconciliation"]) {
      const r = await call(base, "Management", path);
      assert.equal(r.status, 200, path);
      assert.equal((await r.text()).includes("idempotency_fingerprint"), false, path);
    }
    const hist = await (await call(base, "Management", "/inventory/stock_items/si-fx-1/movements")).json();
    const list = hist.data.movements;
    assert.equal(list.length, 2);
    for (const m of list) {
      for (const field of ["quantity", "quantity_before", "quantity_after", "unit_of_measure", "actor_id", "created_at", "reason", "reference_type"]) {
        assert.ok(m[field] !== undefined && m[field] !== null, `${field} present on ${m.reference_type}`);
      }
    }
  });
});
