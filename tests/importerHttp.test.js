import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";
import { sha256Text, IMPORT_LIMITS } from "../src/importers/masterDataImport.js";

// Synthetic data only. Each test uses its own temporary JSON store and a local server
// bound to 127.0.0.1. No .env file is read and no existing database is touched.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2030-01-02T03:04:05.000Z");

function buildApp(store, clock) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (clock) app.use((req, _res, next) => { req.nowMs = clock.now; next(); });
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (_req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." });
  });
  return app;
}

async function withApp(run, { clock } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orac-import-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  const app = buildApp(store, clock);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const db = () => JSON.parse(readFileSync(file, "utf8"));
  const tokenFor = (id) => generateToken(db().users.find((u) => u.id === id));
  try {
    await run({ url, store, file, db, tokenFor });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function call(url, method, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON (template) */ }
  return { status: response.status, json, text, headers: response.headers };
}

// Any 2xx answer, even a preview, makes the store rewrite the whole document with its normal normalisation
// (for example default is_active flags). "Changes nothing" therefore compares the business collections.
const fingerprint = (d) => JSON.stringify({ clients: d.clients.map((c) => [c.id, c.name]), catalog_items: d.catalog_items.map((i) => [i.id, i.item_code]), import_jobs: d.import_jobs, audit: d.audit_logs.length });

const CLIENTS_CSV = "name,client_type,contact_person,email\nAlpha Test Co,Mine,Pat Example,pat@example.test\nBeta Test Co,Plant,,\n";
const CATALOG_CSV = "item_code,item_name,unit_price,category\nA-001,Test Bolt,12.50,Fasteners\nA-002,Test Nut,0.75,Fasteners\n";
const commitBody = (csv, over = {}) => ({
  csv_content: csv, confirmation: "IMPORT_CLIENTS", expected_row_count: csv.split("\n").filter(Boolean).length - 1, file_sha256: sha256Text(csv), ...over
});
const catalogCommit = (csv, over = {}) => commitBody(csv, { confirmation: "IMPORT_CATALOG_ITEMS", ...over });

test("template downloads give the header row as JSON, for Admin and Management only", async () => {
  await withApp(async ({ url, tokenFor }) => {
    const clients = await call(url, "GET", "/imports/clients/template", tokenFor("u_admin"));
    assert.equal(clients.status, 200);
    assert.deepEqual(clients.json, { success: true, data: { filename: "clients-import-template.csv", csv_content: "name,client_type,contact_person,email\r\n" } });
    const catalog = await call(url, "GET", "/imports/catalog_items/template", tokenFor("u_management"));
    assert.equal(catalog.json.data.csv_content, "item_code,item_name,unit_price,category,unit_of_measure,material_grade,dimensions\r\n");
    assert.equal(catalog.json.data.filename, "catalog_items-import-template.csv");
    for (const id of ["u_sales", "u_finance", "u_ops", "u_tech", "u_supervisor", "u_client"]) {
      assert.equal((await call(url, "GET", "/imports/clients/template", tokenFor(id))).status, 403, id);
    }
    assert.equal((await call(url, "GET", "/imports/clients/template")).status, 401);
  });
});

test("preview reports rows and changes nothing", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const before = fingerprint(db());
    const res = await call(url, "POST", "/imports/clients/preview", tokenFor("u_admin"), { csv_content: CLIENTS_CSV });
    assert.equal(res.status, 200);
    const d = res.json.data;
    assert.equal(d.row_count, 2);
    assert.equal(d.ok_count, 2);
    assert.equal(d.can_commit, true);
    assert.equal(d.confirmation_phrase, "IMPORT_CLIENTS");
    assert.equal(d.file_sha256, sha256Text(CLIENTS_CSV));
    assert.equal(d.rows[0].parsed, undefined);
    assert.equal(fingerprint(db()), before);
    const bad = await call(url, "POST", "/imports/clients/preview", tokenFor("u_admin"), { csv_content: "name,client_type\n,Mine\n" });
    assert.equal(bad.json.data.error_count, 1);
    assert.equal(bad.json.data.can_commit, false);
    assert.equal(fingerprint(db()), before);
  });
});

test("commit creates every record, a job record and audit entries (job entry has no cell values)", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const clientsBefore = db().clients.length;
    const auditBefore = db().audit_logs.length;
    const res = await call(url, "POST", "/imports/clients/commit", tokenFor("u_admin"), commitBody(CLIENTS_CSV));
    assert.equal(res.status, 201);
    assert.equal(res.json.data.created_count, 2);
    const after = db();
    assert.equal(after.clients.length, clientsBefore + 2);
    const created = after.clients.slice(-2);
    assert.deepEqual(created.map((c) => c.name), ["Alpha Test Co", "Beta Test Co"]);
    assert.ok(created.every((c) => c.is_active === true));
    assert.equal(after.import_jobs.length, 1);
    const job = after.import_jobs[0];
    assert.equal(job.created_count, 2);
    assert.deepEqual(job.created_ids, created.map((c) => c.id));
    assert.equal(job.file_sha256, sha256Text(CLIENTS_CSV));
    assert.equal(job.created_by, "u_admin");
    const newAudit = after.audit_logs.slice(auditBefore);
    assert.equal(newAudit.filter((a) => a.action === "ADMIN_CLIENT_CREATED").length, 2);
    const jobAudit = newAudit.filter((a) => a.action === "IMPORT_CLIENTS_COMMITTED");
    assert.equal(jobAudit.length, 1);
    const text = JSON.stringify(jobAudit[0]);
    assert.ok(!text.includes("Alpha Test Co") && !text.includes("pat@example.test"));
    assert.ok(!JSON.stringify(job).includes("Alpha Test Co"));
  });
});

test("catalog commit stores numeric prices and defaults, like the form", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const res = await call(url, "POST", "/imports/catalog_items/commit", tokenFor("u_management"), catalogCommit(CATALOG_CSV));
    assert.equal(res.status, 201);
    const items = db().catalog_items.slice(-2);
    assert.deepEqual(items.map((i) => i.unit_price), [12.5, 0.75]);
    assert.equal(items[0].category, "Fasteners");
    assert.equal(items[0].dimensions, "");
    assert.equal(db().import_jobs[0].created_by, "u_management");
  });
});

test("refusals: role, forged token role, inactive account, no token", async () => {
  await withApp(async ({ url, tokenFor, db, file }) => {
    const before = JSON.stringify(db());
    for (const id of ["u_sales", "u_finance", "u_ops", "u_tech", "u_supervisor", "u_client"]) {
      const p = await call(url, "POST", "/imports/clients/preview", tokenFor(id), { csv_content: CLIENTS_CSV });
      const c = await call(url, "POST", "/imports/clients/commit", tokenFor(id), commitBody(CLIENTS_CSV));
      assert.equal(p.status, 403, `${id} preview`);
      assert.equal(c.status, 403, `${id} commit`);
      assert.equal((await call(url, "GET", "/imports", tokenFor(id))).status, 403, `${id} history`);
    }
    // A token that claims Admin for an account that is really Sales: the database role decides.
    const forged = generateToken({ ...db().users.find((u) => u.id === "u_sales"), role: "Admin" });
    assert.equal((await call(url, "POST", "/imports/clients/commit", forged, commitBody(CLIENTS_CSV))).status, 403);
    assert.equal((await call(url, "POST", "/imports/clients/preview", null, { csv_content: CLIENTS_CSV })).status, 401);
    // Inactive Management account.
    const data = db();
    const token = tokenFor("u_management");
    data.users.find((u) => u.id === "u_management").is_active = false;
    writeFileSync(file, JSON.stringify(data));
    const inactive = await call(url, "POST", "/imports/clients/preview", token, { csv_content: CLIENTS_CSV });
    assert.ok([401, 403].includes(inactive.status));
    const afterData = db();
    afterData.users.find((u) => u.id === "u_management").is_active = true;
    assert.equal(afterData.clients.length, JSON.parse(before).clients.length);
    assert.equal(afterData.import_jobs.length, 0);
  });
});

test("commit refusals leave no record: phrase, count, hash, row errors, file errors", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    const before = JSON.stringify(db());
    const cases = [
      [commitBody(CLIENTS_CSV, { confirmation: "import_clients" }), 400, "CONFIRMATION_WRONG"],
      [commitBody(CLIENTS_CSV, { confirmation: undefined }), 400, "CONFIRMATION_WRONG"],
      [commitBody(CLIENTS_CSV, { expected_row_count: 3 }), 400, "COUNT_WRONG"],
      [commitBody(CLIENTS_CSV, { expected_row_count: "2" }), 400, "COUNT_WRONG"],
      [commitBody(CLIENTS_CSV, { file_sha256: "0".repeat(64) }), 400, "HASH_MISMATCH"],
      [commitBody("name,client_type\n,Mine\nOK Co,Mine\n"), 400, "ROW_ERRORS"],
      [commitBody("name,client_type,colour\nA,B,red\n"), 400, "HEADER_UNKNOWN"],
      [commitBody("   "), 400, "FILE_EMPTY"],
      [{ confirmation: "IMPORT_CLIENTS", expected_row_count: 1 }, 400, "CSV_CONTENT_REQUIRED"]
    ];
    for (const [body, status, code] of cases) {
      const res = await call(url, "POST", "/imports/clients/commit", admin, body);
      assert.equal(res.status, status, code);
      assert.equal(res.json.code, code);
      assert.equal(res.json.success, false);
    }
    assert.equal(JSON.stringify(db()), before);
  });
});

test("size limits: 1,001 rows and more than 512 KB are refused; more than 1 MB is refused by the body limit", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    const before = fingerprint(db());
    const many = "name,client_type\n" + Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `C${i},Mine`).join("\n");
    const r1 = await call(url, "POST", "/imports/clients/commit", admin, commitBody(many));
    assert.equal(r1.json.code, "TOO_MANY_ROWS");
    const large = `name,client_type\n${"x".repeat(IMPORT_LIMITS.maxBytes)},Mine\n`;
    const r2 = await call(url, "POST", "/imports/clients/preview", admin, { csv_content: large });
    assert.equal(r2.json.data.file_errors[0].code, "FILE_TOO_LARGE");
    const r3 = await call(url, "POST", "/imports/clients/preview", admin, { csv_content: "x".repeat(1100 * 1024) });
    assert.equal(r3.status, 413);
    assert.equal(fingerprint(db()), before);
  });
});

test("the same file cannot be committed twice (409), and a changed file can", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    assert.equal((await call(url, "POST", "/imports/clients/commit", admin, commitBody(CLIENTS_CSV))).status, 201);
    const count = db().clients.length;
    const again = await call(url, "POST", "/imports/clients/commit", admin, commitBody(CLIENTS_CSV));
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "DUPLICATE_FILE");
    assert.equal(db().clients.length, count);
    const preview = await call(url, "POST", "/imports/clients/preview", admin, { csv_content: CLIENTS_CSV });
    assert.equal(preview.json.data.already_imported, true);
    assert.equal(preview.json.data.can_commit, false);
    const changed = CLIENTS_CSV + "Gamma Test Co,Mine,,\n";
    assert.equal((await call(url, "POST", "/imports/clients/commit", admin, commitBody(changed))).status, 201);
    // The same bytes are a different file for the other entity only if the entity differs; same entity stays blocked.
    assert.equal(db().import_jobs.length, 2);
  });
});

test("a file edited between preview and commit is refused (hash)", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    const preview = await call(url, "POST", "/imports/clients/preview", admin, { csv_content: CLIENTS_CSV });
    const edited = CLIENTS_CSV.replace("Alpha", "Altered");
    const res = await call(url, "POST", "/imports/clients/commit", admin, {
      csv_content: edited, confirmation: "IMPORT_CLIENTS", expected_row_count: 2, file_sha256: preview.json.data.file_sha256
    });
    assert.equal(res.json.code, "HASH_MISMATCH");
    assert.equal(db().import_jobs.length, 0);
  });
});

test("atomic: a failure part way through leaves no record, no audit entry and no job", async () => {
  await withApp(async ({ url, tokenFor, db, store }) => {
    const real = store.audit.bind(store);
    let calls = 0;
    store.audit = (...args) => { calls += 1; if (calls === 3) throw new Error("injected failure at record 3"); return real(...args); };
    const csv = "name,client_type\nOne,Mine\nTwo,Mine\nThree,Mine\nFour,Mine\n";
    const before = JSON.stringify(db());
    const res = await call(url, "POST", "/imports/clients/commit", tokenFor("u_admin"), commitBody(csv));
    assert.equal(res.status, 500);
    assert.equal(JSON.stringify(db()), before);
    store.audit = real;
    assert.equal((await call(url, "POST", "/imports/clients/commit", tokenFor("u_admin"), commitBody(csv))).status, 201);
  });
});

test("two commits of one file at once give one job and one 409", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    const results = await Promise.all([
      call(url, "POST", "/imports/clients/commit", admin, commitBody(CLIENTS_CSV)),
      call(url, "POST", "/imports/clients/commit", admin, commitBody(CLIENTS_CSV))
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(db().import_jobs.length, 1);
    assert.equal(db().clients.filter((c) => c.name === "Alpha Test Co").length, 1);
  });
});

test("history lists jobs without ids; detail shows ids; ids older than 90 days are pruned at the next commit", async () => {
  const clock = { now: T0 };
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    assert.equal((await call(url, "POST", "/imports/clients/commit", admin, commitBody(CLIENTS_CSV))).status, 201);
    const list = await call(url, "GET", "/imports", tokenFor("u_management"));
    assert.equal(list.json.data.length, 1);
    assert.equal(list.json.data[0].created_ids, undefined);
    assert.equal(list.json.data[0].ids_available, true);
    const id = list.json.data[0].id;
    const detail = await call(url, "GET", `/imports/${id}`, admin);
    assert.equal(detail.json.data.created_ids.length, 2);
    assert.equal((await call(url, "GET", "/imports/imp_missing", admin)).status, 404);
    clock.now = T0 + 91 * DAY;
    const second = "name,client_type\nDelta Test Co,Mine\n";
    assert.equal((await call(url, "POST", "/imports/clients/commit", admin, commitBody(second))).status, 201);
    const jobs = db().import_jobs;
    assert.deepEqual(jobs[0].created_ids, []);
    assert.equal(jobs[0].ids_pruned_at, new Date(clock.now).toISOString());
    assert.equal(jobs[1].created_ids.length, 1);
    const after = await call(url, "GET", "/imports", admin);
    assert.equal(after.json.data.find((j) => j.id === jobs[0].id).ids_available, false);
  }, { clock });
});

test("the normal admin create routes still answer as before (including field validation messages)", async () => {
  await withApp(async ({ url, tokenFor, db }) => {
    const admin = tokenFor("u_admin");
    const ok = await call(url, "POST", "/admin/clients", admin, { name: "Form Test Co", client_type: "Mine" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.success, true);
    assert.equal(ok.json.data.name, "Form Test Co");
    assert.equal(ok.json.data.is_active, true);
    const bad = await call(url, "POST", "/admin/clients", admin, { name: "", client_type: "Mine" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.message, "Name is required");
    const item = await call(url, "POST", "/admin/catalog_items", admin, { item_code: "F-1", item_name: "Form Item", unit_price: 5 });
    assert.equal(item.status, 200);
    assert.equal(item.json.data.unit_price, 5);
    assert.equal((await call(url, "POST", "/admin/clients", tokenFor("u_sales"), { name: "X", client_type: "Y" })).status, 403);
    assert.equal(db().clients.some((c) => c.name === "X"), false);
  });
});

test("an existing store file without import_jobs loads and works (backfilled by normalizeDb)", async () => {
  await withApp(async ({ url, tokenFor, db, file }) => {
    const data = db();
    delete data.import_jobs;
    writeFileSync(file, JSON.stringify(data));
    const list = await call(url, "GET", "/imports", tokenFor("u_admin"));
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.data, []);
    assert.equal((await call(url, "POST", "/imports/clients/commit", tokenFor("u_admin"), commitBody(CLIENTS_CSV))).status, 201);
    assert.equal(db().import_jobs.length, 1);
  });
});
