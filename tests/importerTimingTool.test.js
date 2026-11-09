import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildCsv, verdict } from "../tools/time-import-http.mjs";
import { commitMasterDataImport, previewMasterDataImport } from "../src/controllers/importController.js";
import { normalizeDb } from "../src/store.js";

// The tool is run as a real separate process against a local HTTP server that calls the REAL import controllers
// on an in-memory database. This proves the request format and the safety flags. It does not exercise Express
// or PostgreSQL: those still need a run against a staging server.

function startServer() {
  const db = normalizeDb({ users: [], clients: [], catalog_items: [] }, { seedDemoRecords: false });
  db.users.push({ id: "u_admin", role: "Admin", is_active: true, name: "Test Admin", email: "admin@example.test" });
  let n = 0;
  const store = { id: (p) => `${p}_${++n}`, audit: (d, actor, type, id, action) => { d.audit_logs.push({ entity_type: type, entity_id: id, action, actor_id: actor.id }); } };
  const handlers = {
    "/api/imports/clients/preview": previewMasterDataImport("clients"), "/api/imports/clients/commit": commitMasterDataImport("clients"),
    "/api/imports/catalog_items/preview": previewMasterDataImport("catalog_items"), "/api/imports/catalog_items/commit": commitMasterDataImport("catalog_items")
  };
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seenAuth.push(req.headers.authorization);
      const handler = handlers[req.url];
      const out = { status: 404, body: { success: false, message: "no such route" } };
      if (handler) {
        const fake = { status(c) { out.status = c; return fake; }, json(b) { if (out.status === 404) out.status = 200; out.body = b; return fake; } };
        try { handler({ db, store, user: { id: "u_admin" }, body: JSON.parse(raw || "{}"), params: {}, nowMs: Date.UTC(2026, 10, 1) }, fake); }
        catch (e) { out.status = e.status || 500; out.body = { success: false, message: e.message }; }
      }
      res.writeHead(out.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, db, seenAuth, url: `http://127.0.0.1:${server.address().port}/api` })));
}
function runTool(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["tools/time-import-http.mjs", ...args], { env: { ...process.env, ...env }, cwd: new URL("..", import.meta.url) });
    let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("buildCsv makes unique synthetic rows for both kinds of data", () => {
  const clients = buildCsv("clients", 5, "AB1CD").trim().split("\n");
  assert.equal(clients.length, 6); assert.equal(new Set(clients.slice(1).map((l) => l.split(",")[0])).size, 5);
  const items = buildCsv("catalog_items", 5, "AB1CD").trim().split("\n");
  assert.equal(new Set(items.slice(1).map((l) => l.split(",")[0])).size, 5);
  assert.match(items[1], /,\d+\.\d\d,/);
});

test("verdict thresholds and a safe row suggestion", () => {
  assert.equal(verdict(4999, 1000).level, "OK");
  assert.equal(verdict(6000, 1000).level, "CAUTION");
  assert.match(verdict(6000, 1000).text, /IMPORT_MAX_ROWS=833/);
  assert.equal(verdict(12000, 1000).level, "TOO SLOW");
  assert.match(verdict(12000, 1000).text, /about 416/);
});

test("preview only creates nothing; commit needs both flags; with them it creates exactly the rows", async () => {
  const s = await startServer();
  const env = { ORAC_API_URL: s.url, ORAC_TOKEN: "not-a-real-token-xyz" };
  try {
    const preview = await runTool(["--rows", "25"], env);
    assert.equal(preview.code, 0, preview.out);
    assert.match(preview.out, /preview: HTTP 200/); assert.match(preview.out, /rows 25, ready 25, errors 0, can_commit true/);
    assert.equal(s.db.clients.length, 0, "preview must not create anything");

    const refused = await runTool(["--rows", "25", "--commit"], env);
    assert.equal(refused.code, 2); assert.equal(s.db.clients.length, 0, "no creation without the confirmation flag");

    const committed = await runTool(["--rows", "25", "--commit", "--i-understand-this-creates-records"], env);
    assert.equal(committed.code, 0, committed.out);
    assert.match(committed.out, /commit: HTTP 201/); assert.match(committed.out, /created 25 records/); assert.match(committed.out, /RESULT OK/);
    assert.equal(s.db.clients.length, 25); assert.equal(s.db.import_jobs.length, 1);

    assert.equal(committed.out.includes("not-a-real-token-xyz"), false, "the token is never printed");
    assert.ok(s.seenAuth.every((h) => h === "Bearer not-a-real-token-xyz"));
  } finally { s.server.close(); }
});

test("catalog items work too, and a missing URL or token is a clear refusal", async () => {
  const s = await startServer();
  try {
    const c = await runTool(["--entity", "catalog_items", "--rows", "10", "--commit", "--i-understand-this-creates-records"], { ORAC_API_URL: s.url, ORAC_TOKEN: "t" });
    assert.equal(c.code, 0, c.out); assert.equal(s.db.catalog_items.length, 10);
    const none = await runTool(["--rows", "5"], { ORAC_API_URL: "", ORAC_TOKEN: "" });
    assert.equal(none.code, 2); assert.match(none.out, /Set ORAC_API_URL/);
    const bad = await runTool(["--entity", "wages"], { ORAC_API_URL: s.url, ORAC_TOKEN: "t" });
    assert.equal(bad.code, 2);
  } finally { s.server.close(); }
});
