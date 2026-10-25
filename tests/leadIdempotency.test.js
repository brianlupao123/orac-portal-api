import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { createStore as createPostgresStore } from "../src/postgresStore.js";
import { createPublicEndpointLimits } from "../src/middleware/rateLimit.js";
import { createCors, CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from "../src/middleware/cors.js";
import { generateToken } from "../src/middleware/auth.js";
import {
  IDEMPOTENCY_TTL_MS, LEAD_CREATE_SCOPE, canonicalLeadFields, leadRequestHash, idempotencyKeyMiddleware
} from "../src/idempotency.js";

// Synthetic data only. Every store is a temporary file (or an in-memory fake
// Postgres pool); every server binds to 127.0.0.1 and is closed. No .env file is
// read for data and no existing database is touched.

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2030-01-02T03:04:05.000Z");
const ADMIN = { id: "u_admin", email: "admin@orac.co.zw", role: "Admin", is_active: true };

const lead = (over = {}) => ({
  company_name: "Example Mining Test Co",
  contact_name: "Pat Example",
  email: "pat@example.test",
  service_need: "Conveyor idler inspection",
  phone: "+000 000 0000",
  mine_site: "Test Site",
  urgency: "standard",
  ...over
});

function buildApp(store, { clock, before = [], limiter, cors } = {}) {
  const app = express();
  if (cors) app.use(cors);
  app.use(express.json({ limit: "1mb" }));
  if (clock) app.use((req, _res, next) => { req.nowMs = clock.now; next(); });
  for (const mw of before) app.use(mw);
  if (limiter) app.use("/api", limiter);
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (_req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." });
  });
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function tempStore(prefix = "orac-idem-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const file = join(dir, "db.json");
  return { dir, file, store: createStore(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const snapshot = (file) => JSON.parse(readFileSync(file, "utf8"));

async function post(url, body, key, extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  const response = await fetch(`${url}/leads`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

// Raw request so duplicate headers and a deliberately dropped connection can be sent/observed.
function rawPost(url, body, headerList) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}/leads`);
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    for (const [name, value] of headerList) headers[name] = headers[name] === undefined ? value : [].concat(headers[name], value);
    const req = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const leadAudits = (db) => db.audit_logs.filter((a) => a.action === "LEAD_CREATED");

/* ── module-level unit tests ─────────────────────────────────────────────── */

test("canonical hash ignores property order, unknown properties and optional/default spelling", () => {
  const a = leadRequestHash(canonicalLeadFields({ company_name: "A", contact_name: "B", email: "c@x.test", service_need: "S" }));
  const b = leadRequestHash(canonicalLeadFields({ urgency: "standard", service_need: "S", mine_site: "  ", phone: "", email: "c@x.test", contact_name: "B", company_name: "A" }));
  assert.equal(a, b);
});

test("canonical hash separates distinct payloads, including field-boundary shifts and case", () => {
  const base = { company_name: "A", contact_name: "B", email: "c@x.test", service_need: "S" };
  const h = (over) => leadRequestHash(canonicalLeadFields({ ...base, ...over }));
  const seen = new Set([h({}), h({ company_name: "AB", contact_name: "" + "B".slice(1) }), h({ company_name: "A", contact_name: "B ", email: "c@x.test" }),
    h({ email: "C@x.test" }), h({ urgency: "urgent" }), h({ phone: "1" }), h({ mine_site: "1" }), h({ service_need: "s" })]);
  assert.equal(seen.size, 8);
  assert.notEqual(h({ company_name: "ab", contact_name: "c" }), h({ company_name: "a", contact_name: "bc" }));
});

test("key middleware accepts only a single v4 UUID and normalises case", () => {
  const run = (headers, rawHeaders) => {
    const req = { headers, rawHeaders };
    let status = null; let nexted = false;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    idempotencyKeyMiddleware(req, res, () => { nexted = true; });
    return { req, status, nexted };
  };
  const ok = randomUUID();
  assert.equal(run({}).nexted, true);
  assert.equal(run({}).req.idempotencyKey, undefined);
  assert.equal(run({ "idempotency-key": ok }).req.idempotencyKey, ok);
  assert.equal(run({ "idempotency-key": ok.toUpperCase() }).req.idempotencyKey, ok);
  for (const bad of ["", " ", "abc", "00000000-0000-1000-8000-000000000000", `${ok}x`, ok.replace(/-/g, ""), `${ok}, ${ok}`]) {
    const r = run({ "idempotency-key": bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.nexted, false);
  }
  assert.equal(run({ "idempotency-key": ok }, ["Idempotency-Key", ok, "idempotency-key", ok]).status, 400);
});

/* ── HTTP tests on the real router, real middleware, real JSON store ─────── */

test("first keyed submission creates one lead, one audit and one key record; response shape matches legacy", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const legacy = await post(url, lead({ email: "legacy@example.test" }));
      const key = randomUUID();
      const keyed = await post(url, lead(), key);
      assert.equal(legacy.status, 200);
      assert.equal(keyed.status, 200);
      assert.deepEqual(Object.keys(keyed.body), Object.keys(legacy.body));
      assert.deepEqual(Object.keys(keyed.body.data), Object.keys(legacy.body.data));
      assert.equal(keyed.body.idempotent_replay, undefined);
      assert.equal(keyed.headers.get("idempotency-replayed"), null);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 2);
      assert.equal(db.idempotency_keys.length, 1);
      const record = db.idempotency_keys[0];
      assert.equal(record.key, key);
      assert.equal(record.scope, LEAD_CREATE_SCOPE);
      assert.equal(record.lead_id, keyed.body.data.id);
      assert.equal(Date.parse(record.expires_at) - Date.parse(record.created_at), IDEMPOTENCY_TTL_MS);
      const audits = leadAudits(db).filter((a) => a.entity_id === keyed.body.data.id);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].actor_id, "system");
      assert.equal(JSON.stringify(audits).includes(key), false, "the key is not copied into the audit log");
    });
  } finally { t.cleanup(); }
});

test("legacy unkeyed submissions keep creating separate leads and store no key metadata", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const a = await post(url, lead());
      const b = await post(url, lead());
      assert.notEqual(a.body.data.id, b.body.data.id);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 2);
      assert.deepEqual(db.idempotency_keys, []);
    });
  } finally { t.cleanup(); }
});

test("identical replay returns the original status, body and reference with no second lead, audit, notification or other write", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const first = await post(url, lead(), key);
      const afterFirst = snapshot(t.file);
      const replay = await post(url, lead(), key);
      assert.equal(replay.status, first.status);
      assert.deepEqual(replay.body.data, first.body.data);
      assert.equal(replay.body.success, true);
      assert.equal(replay.body.idempotent_replay, true);
      assert.equal(replay.headers.get("idempotency-replayed"), "true");
      assert.deepEqual(snapshot(t.file), afterFirst, "a replay changes nothing in the store");
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 1);
      assert.equal(leadAudits(db).length, 1);
      assert.equal(db.notifications.filter((n) => n.type === "lead").length, 1);
      for (const c of ["quotes", "quote_lines", "invoices", "invoice_lines", "dispatch_cards", "purchase_orders", "service_requests"]) {
        assert.deepEqual(db[c], [], `${c} untouched`);
      }
    });
  } finally { t.cleanup(); }
});

test("replay returns the ORIGINAL response even after the stored lead is edited", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const first = await post(url, lead(), key);
      const db = snapshot(t.file);
      db.leads[0].status = "Qualified";
      db.leads[0].service_need = "edited internally";
      writeFileSync(t.file, JSON.stringify(db, null, 2));
      const replay = await post(url, lead(), key);
      assert.deepEqual(replay.body.data, first.body.data);
      assert.equal(replay.body.data.status, "New");
    });
  } finally { t.cleanup(); }
});

test("equivalent payloads (property order, unknown fields, omitted vs default optionals) replay; changed payloads conflict", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const first = await post(url, { company_name: "A Co", contact_name: "B", email: "b@example.test", service_need: "S" }, key);
      assert.equal(first.status, 200);
      const equivalents = [
        { service_need: "S", email: "b@example.test", contact_name: "B", company_name: "A Co", urgency: "standard", phone: "", mine_site: "   " },
        { company_name: "A Co", contact_name: "B", email: "b@example.test", service_need: "S", unknown_field: "ignored by schema", urgency: "" }
      ];
      for (const body of equivalents) {
        const r = await post(url, body, key);
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.equal(r.body.idempotent_replay, true);
        assert.equal(r.body.data.id, first.body.data.id);
      }
      const variants = [
        { company_name: "A Co." }, { contact_name: "B2" }, { email: "B@example.test" }, { service_need: "S2" },
        { phone: "1" }, { mine_site: "x" }, { urgency: "urgent" }
      ];
      for (const v of variants) {
        const r = await post(url, { company_name: "A Co", contact_name: "B", email: "b@example.test", service_need: "S", ...v }, key);
        assert.equal(r.status, 409, JSON.stringify(v));
        assert.equal(r.body.code, "IDEMPOTENCY_KEY_CONFLICT");
      }
      assert.equal(snapshot(t.file).leads.length, 1);
    });
  } finally { t.cleanup(); }
});

test("conflict response leaks no lead content and no reference, and does not write", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const first = await post(url, lead({ contact_name: "Original Person", email: "original@example.test" }), key);
      const before = snapshot(t.file);
      const conflict = await post(url, lead({ contact_name: "Someone Else", email: "other@example.test" }), key);
      assert.equal(conflict.status, 409);
      assert.deepEqual(Object.keys(conflict.body).sort(), ["code", "message", "success"]);
      const text = JSON.stringify(conflict.body);
      for (const secret of [first.body.data.id, "Original Person", "original@example.test", "Someone Else", "other@example.test"]) {
        assert.equal(text.includes(secret), false, secret);
      }
      assert.deepEqual(snapshot(t.file), before);
    });
  } finally { t.cleanup(); }
});

test("malformed, empty, repeated and non-v4 keys are rejected with 400 before any mutation", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const before = snapshot(t.file);
      for (const bad of ["", "not-a-uuid", "00000000-0000-1000-8000-000000000000", `${randomUUID()}0`, randomUUID().replace(/-/g, ""), "x".repeat(500)]) {
        const r = await post(url, lead(), bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.equal(r.body.code, "IDEMPOTENCY_KEY_INVALID");
        assert.equal(r.body.success, false);
      }
      const dup = await rawPost(url, lead(), [["Idempotency-Key", randomUUID()], ["Idempotency-Key", randomUUID()]]);
      assert.equal(dup.status, 400);
      assert.equal(dup.body.code, "IDEMPOTENCY_KEY_INVALID");
      assert.deepEqual(snapshot(t.file), before);
      const upper = randomUUID().toUpperCase();
      const a = await post(url, lead(), upper);
      const b = await post(url, lead(), upper.toLowerCase());
      assert.equal(b.body.data.id, a.body.data.id, "key matching is case-insensitive");
    });
  } finally { t.cleanup(); }
});

test("a validation failure does not reserve the key; the corrected retry succeeds with that key", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const bad = await post(url, lead({ email: "not-an-email" }), key);
      assert.equal(bad.status, 400);
      assert.deepEqual(snapshot(t.file).idempotency_keys, []);
      const good = await post(url, lead({ email: "fixed@example.test" }), key);
      assert.equal(good.status, 200);
      assert.equal(good.body.idempotent_replay, undefined);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 1);
      assert.equal(db.idempotency_keys.length, 1);
    });
  } finally { t.cleanup(); }
});

test("concurrent duplicates with one key create exactly one lead; the rest replay the same reference", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 8 }, () => post(url, lead(), key)));
      assert.ok(results.every((r) => r.status === 200));
      assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
      assert.equal(results.filter((r) => r.body.idempotent_replay === true).length, 7);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 1);
      assert.equal(leadAudits(db).length, 1);
      assert.equal(db.idempotency_keys.length, 1);
    });
  } finally { t.cleanup(); }
});

test("concurrent same-key requests with different payloads: one wins, the others get 409", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      const results = await Promise.all(["a", "b", "a", "b"].map((x) => post(url, lead({ service_need: `need-${x}` }), key)));
      const ok = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      assert.equal(ok.length + conflicts.length, 4);
      assert.ok(conflicts.length >= 1);
      assert.equal(new Set(ok.map((r) => r.body.data.id)).size, 1);
      assert.equal(snapshot(t.file).leads.length, 1);
    });
  } finally { t.cleanup(); }
});

test("saved lead + lost acknowledgement + retry => one lead and the ORIGINAL reference", async () => {
  const t = tempStore();
  try {
    let dropNext = false; let lastRes;
    const lossy = Object.create(t.store);
    lossy.write = function write(db, ctx) {
      const result = t.store.write(db, ctx);   // durable commit really happens first
      if (dropNext) { dropNext = false; lastRes.socket.destroy(); } // then the acknowledgement is lost
      return result;
    };
    const app = buildApp(lossy, { before: [(_req, res, next) => { lastRes = res; next(); }] });
    await withServer(app, async (url) => {
      const key = randomUUID();
      dropNext = true;
      await assert.rejects(rawPost(url, lead(), [["Idempotency-Key", key]]), "the client never sees the response");
      const persisted = snapshot(t.file);
      assert.equal(persisted.leads.length, 1, "the enquiry WAS saved");
      const originalRef = persisted.leads[0].id;
      const retry = await post(url, lead(), key);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent_replay, true);
      assert.equal(retry.body.data.id, originalRef);
      assert.equal(retry.body.data.created_at, persisted.leads[0].created_at);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 1);
      assert.equal(leadAudits(db).length, 1);
    });
  } finally { t.cleanup(); }
});

test("a clean failure BEFORE saving followed by a retry creates the lead normally (different scenario, not the lost-ack proof)", async () => {
  const t = tempStore();
  try {
    let fail = true;
    const flaky = Object.create(t.store);
    flaky.write = function write(db, ctx) {
      if (fail) { fail = false; if (ctx) ctx(); throw new Error("simulated disk failure"); }
      return t.store.write(db, ctx);
    };
    await withServer(buildApp(flaky), async (url) => {
      const key = randomUUID();
      const before = readFileSync(t.file, "utf8");
      const failed = await post(url, lead(), key);
      assert.equal(failed.status, 500, "no false success");
      assert.equal(failed.body.success, false);
      assert.equal(readFileSync(t.file, "utf8"), before, "neither lead nor key was persisted");
      const retry = await post(url, lead(), key);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.idempotent_replay, undefined, "first successful creation, not a replay");
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 1);
      assert.equal(db.idempotency_keys.length, 1);
      assert.equal(db.idempotency_keys[0].lead_id, db.leads[0].id);
    });
  } finally { t.cleanup(); }
});

test("replays survive a process restart (new store instance and new app on the same file)", async () => {
  const t = tempStore();
  try {
    const key = randomUUID();
    let first;
    await withServer(buildApp(t.store), async (url) => { first = await post(url, lead(), key); });
    const reopened = createStore(t.file);
    await withServer(buildApp(reopened), async (url) => {
      const replay = await post(url, lead(), key);
      assert.equal(replay.body.idempotent_replay, true);
      assert.deepEqual(replay.body.data, first.body.data);
      assert.equal(snapshot(t.file).leads.length, 1);
    });
  } finally { t.cleanup(); }
});

test("expiry: valid until 24h after creation (exclusive), retries do not extend it, then a reused key is new", async () => {
  const t = tempStore();
  try {
    const clock = { t: T0, now() { return this.t; } };
    const app = buildApp(t.store, { clock: { now: () => clock.t } });
    await withServer(app, async (url) => {
      const key = randomUUID();
      const first = await post(url, lead(), key);
      assert.equal(first.body.data.created_at, new Date(T0).toISOString());
      const expiresAt = snapshot(t.file).idempotency_keys[0].expires_at;
      assert.equal(expiresAt, new Date(T0 + 24 * HOUR).toISOString());

      clock.t = T0 + 12 * HOUR;
      assert.equal((await post(url, lead(), key)).body.idempotent_replay, true);
      assert.equal(snapshot(t.file).idempotency_keys[0].expires_at, expiresAt, "a replay does not extend retention");

      clock.t = T0 + 24 * HOUR - 1;
      const lastMoment = await post(url, lead(), key);
      assert.equal(lastMoment.body.idempotent_replay, true);
      assert.equal(lastMoment.body.data.id, first.body.data.id);

      clock.t = T0 + 24 * HOUR; // boundary: expired
      const reused = await post(url, lead(), key);
      assert.equal(reused.status, 200);
      assert.equal(reused.body.idempotent_replay, undefined);
      assert.notEqual(reused.body.data.id, first.body.data.id);
      const db = snapshot(t.file);
      assert.equal(db.leads.length, 2, "documented limitation: a key reused after expiry creates a new lead");
      assert.equal(db.idempotency_keys.length, 1, "expired record pruned, new one stored");
      assert.equal(db.idempotency_keys[0].lead_id, reused.body.data.id);
      assert.equal(db.idempotency_keys[0].expires_at, new Date(T0 + 48 * HOUR).toISOString());
    });
  } finally { t.cleanup(); }
});

test("expiry also applies to a changed payload: after 24h the key may be reused for a different submission", async () => {
  const t = tempStore();
  try {
    const clock = { t: T0 };
    await withServer(buildApp(t.store, { clock: { now: () => clock.t } }), async (url) => {
      const key = randomUUID();
      await post(url, lead(), key);
      clock.t = T0 + 24 * HOUR - 1;
      assert.equal((await post(url, lead({ service_need: "different" }), key)).status, 409);
      clock.t = T0 + 24 * HOUR;
      assert.equal((await post(url, lead({ service_need: "different" }), key)).status, 200);
    });
  } finally { t.cleanup(); }
});

test("cleanup removes only expired key records: leads and every unexpired record are kept, however many", async () => {
  const t = tempStore();
  try {
    const clock = { t: T0 };
    await withServer(buildApp(t.store, { clock: { now: () => clock.t } }), async (url) => {
      const expiredKeys = []; const liveKeys = [];
      for (let i = 0; i < 3; i++) { const k = randomUUID(); expiredKeys.push(k); await post(url, lead({ service_need: `old-${i}` }), k); }
      clock.t = T0 + 20 * HOUR;
      for (let i = 0; i < 40; i++) { const k = randomUUID(); liveKeys.push(k); await post(url, lead({ service_need: `new-${i}` }), k); }
      clock.t = T0 + 25 * HOUR; // the first three are expired, the 40 are not
      const trigger = randomUUID();
      await post(url, lead({ service_need: "trigger" }), trigger);
      const db = snapshot(t.file);
      const keys = db.idempotency_keys.map((r) => r.key);
      for (const k of expiredKeys) assert.equal(keys.includes(k), false);
      for (const k of [...liveKeys, trigger]) assert.equal(keys.includes(k), true);
      assert.equal(db.leads.length, 44, "no lead is ever deleted by cleanup");
    });
  } finally { t.cleanup(); }
});

test("idempotency records are not reachable through generic collection APIs or the audit log", async () => {
  const t = tempStore();
  try {
    await withServer(buildApp(t.store), async (url) => {
      const key = randomUUID();
      await post(url, lead(), key);
      const auth = { Authorization: `Bearer ${generateToken(ADMIN)}` };
      const missing = await fetch(`${url}/idempotency_keys`, { headers: auth });
      assert.equal(missing.status, 404);
      const leads = await (await fetch(`${url}/leads`, { headers: auth })).text();
      const audit = await (await fetch(`${url}/audit_logs`, { headers: auth })).text();
      assert.equal(leads.includes(key) || audit.includes(key), false);
      assert.equal(leads.includes("request_hash") || audit.includes("request_hash"), false);
      const deactivate = await fetch(`${url}/admin/idempotency_keys/x/deactivate`, { method: "POST", headers: auth });
      assert.equal(deactivate.status, 404);
    });
  } finally { t.cleanup(); }
});

test("an existing data file without idempotency_keys is backfilled when reopened", async () => {
  const t = tempStore();
  try {
    const legacy = snapshot(t.file);
    delete legacy.idempotency_keys;
    writeFileSync(t.file, JSON.stringify(legacy));
    const { db, release } = await createStore(t.file).read();
    assert.deepEqual(db.idempotency_keys, []);
    release();
  } finally { t.cleanup(); }
});

/* ── limiter ordering and CORS ───────────────────────────────────────────── */

test("rate limiting stays ahead of the store lock and a replay still counts against it", async () => {
  const t = tempStore();
  try {
    let reads = 0;
    const spy = Object.create(t.store);
    spy.read = function read(options) { reads += 1; return t.store.read(options); };
    const limiter = createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "2", RATE_LIMIT_WINDOW_MS: "900000" } });
    await withServer(buildApp(spy, { limiter }), async (url) => {
      const key = randomUUID();
      assert.equal((await post(url, lead(), key)).status, 200);
      assert.equal((await post(url, lead(), key)).body.idempotent_replay, true);
      assert.equal(reads, 2);
      const limited = await post(url, lead(), key);
      assert.equal(limited.status, 429, "a replay does not bypass abuse controls");
      assert.ok(limited.headers.get("retry-after"));
      assert.equal(reads, 2, "the 429 was answered before the store lock was taken");
      assert.equal(snapshot(t.file).leads.length, 1);
    });
  } finally { t.cleanup(); }
});

test("server.js wires CORS, then the limiter, then the persistence lock", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r/g, "");
  const cors = src.indexOf("createCors(");
  const limits = src.indexOf('app.use("/api", createPublicEndpointLimits())');
  const persist = src.indexOf('app.use("/api", persistenceMiddleware(store))');
  assert.ok(cors > 0 && limits > cors && persist > limits);
  assert.equal(src.includes("Access-Control-Allow-Headers"), false, "the policy lives only in middleware/cors.js");
});

test("CORS preflight allows Idempotency-Key for permitted origins only and exposes the replay header", async () => {
  const prod = createCors({ allowedOrigins: ["https://app.example.test"], isProduction: true });
  const app = express();
  app.use(prod);
  app.post("/api/leads", (_req, res) => res.json({ ok: true }));
  await withServer(app, async (url) => {
    const preflight = (origin) => fetch(`${url}/leads`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" }
    });
    const allowed = await preflight("https://app.example.test");
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.example.test");
    const allowedHeaders = allowed.headers.get("access-control-allow-headers").toLowerCase().split(",").map((s) => s.trim());
    for (const h of ["content-type", "authorization", "idempotency-key"]) assert.ok(allowedHeaders.includes(h), h);
    assert.equal(allowed.headers.get("access-control-expose-headers"), CORS_EXPOSED_HEADERS);
    assert.equal(CORS_ALLOWED_HEADERS.includes("Idempotency-Key"), true);

    const denied = await preflight("https://evil.example.test");
    assert.equal(denied.status, 204);
    assert.equal(denied.headers.get("access-control-allow-origin"), null, "origin policy is not widened");
    assert.equal(denied.headers.get("access-control-allow-headers"), null);

    const actual = await fetch(`${url}/leads`, { method: "POST", headers: { Origin: "https://app.example.test" } });
    assert.equal(actual.headers.get("access-control-expose-headers"), "Idempotency-Replayed");
  });
});

test("the replay header is actually returned on a replay through the CORS-wrapped stack", async () => {
  const t = tempStore();
  try {
    const cors = createCors({ allowedOrigins: ["https://app.example.test"], isProduction: true });
    await withServer(buildApp(t.store, { cors }), async (url) => {
      const key = randomUUID();
      const headers = { Origin: "https://app.example.test" };
      await post(url, lead(), key, headers);
      const replay = await post(url, lead(), key, headers);
      assert.equal(replay.headers.get("idempotency-replayed"), "true");
      assert.equal(replay.headers.get("access-control-expose-headers"), "Idempotency-Replayed");
    });
  } finally { t.cleanup(); }
});

/* ── PostgreSQL adapter: contract tests on a stateful FAKE pool ───────────── */
// LABEL: these exercise src/postgresStore.js against an in-process fake that
// models one row, BEGIN/COMMIT/ROLLBACK and SELECT ... FOR UPDATE row locking.
// A LIVE ephemeral PostgreSQL integration test was NOT RUN (none available).

function createFakePg(initial) {
  let committed = JSON.stringify(initial);
  let held = false; const waiters = [];
  const state = { failUpdate: false, commits: 0, rollbacks: 0 };
  const lock = () => new Promise((resolve) => { if (!held) { held = true; resolve(); } else waiters.push(resolve); });
  const unlock = () => { const next = waiters.shift(); if (next) next(); else held = false; };
  const ok = { rowCount: 0, rows: [] };
  const pool = {
    async connect() {
      let pending = null; let holding = false;
      return {
        async query(sql, params) {
          if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return ok;
          if (sql.startsWith("SELECT data")) {
            if (sql.includes("FOR UPDATE")) { await lock(); holding = true; }
            return { rowCount: 1, rows: [{ data: JSON.parse(committed) }] };
          }
          if (sql.startsWith("UPDATE store")) {
            if (state.failUpdate) throw new Error("simulated update failure");
            pending = JSON.stringify(params[0]);
            return { rowCount: 1, rows: [] };
          }
          if (sql === "COMMIT") { if (pending !== null) { committed = pending; state.commits += 1; } pending = null; if (holding) { holding = false; unlock(); } return ok; }
          if (sql === "ROLLBACK") { pending = null; state.rollbacks += 1; if (holding) { holding = false; unlock(); } return ok; }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        release() {}
      };
    }
  };
  return { pool, state, data: () => JSON.parse(committed) };
}

async function freshSeed() {
  const { db, release } = await createStore(":memory:").read();
  release();
  return db;
}

test("postgres: keyed create, replay through a second store instance, and no duplicate side effects", async () => {
  const fake = createFakePg(await freshSeed());
  const storeA = createPostgresStore(":memory:", fake.pool);
  const storeB = createPostgresStore(":memory:", fake.pool); // "another process"
  const key = randomUUID();
  let first;
  await withServer(buildApp(storeA), async (url) => { first = await post(url, lead(), key); });
  await withServer(buildApp(storeB), async (url) => {
    const replay = await post(url, lead(), key);
    assert.equal(replay.body.idempotent_replay, true);
    assert.deepEqual(replay.body.data, first.body.data);
    assert.equal((await post(url, lead({ service_need: "other" }), key)).status, 409);
  });
  const db = fake.data();
  assert.equal(db.leads.length, 1);
  assert.equal(leadAudits(db).length, 1);
  assert.equal(db.idempotency_keys.length, 1);
});

test("postgres: concurrent duplicates across two store instances serialise on the row lock", async () => {
  const fake = createFakePg(await freshSeed());
  const appA = buildApp(createPostgresStore(":memory:", fake.pool));
  const appB = buildApp(createPostgresStore(":memory:", fake.pool));
  const key = randomUUID();
  await withServer(appA, async (urlA) => withServer(appB, async (urlB) => {
    const results = await Promise.all([urlA, urlB, urlA, urlB, urlA, urlB].map((u) => post(u, lead(), key)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
    assert.equal(results.filter((r) => r.body.idempotent_replay === true).length, 5);
  }));
  const db = fake.data();
  assert.equal(db.leads.length, 1);
  assert.equal(db.idempotency_keys.length, 1);
});

test("postgres: a failed commit rolls back lead AND key together, returns 500, and releases the lock", async () => {
  const fake = createFakePg(await freshSeed());
  const app = buildApp(createPostgresStore(":memory:", fake.pool));
  const key = randomUUID();
  await withServer(app, async (url) => {
    fake.state.failUpdate = true;
    const failed = await post(url, lead(), key);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.success, false);
    assert.equal(fake.data().leads.length, 0);
    assert.equal(fake.data().idempotency_keys.length, 0);
    fake.state.failUpdate = false;
    const retry = await post(url, lead(), key);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent_replay, undefined);
  });
  const db = fake.data();
  assert.equal(db.leads.length, 1);
  assert.equal(db.idempotency_keys[0].lead_id, db.leads[0].id);
});

test("postgres: lost acknowledgement after COMMIT then retry returns the original reference", async () => {
  const fake = createFakePg(await freshSeed());
  const real = createPostgresStore(":memory:", fake.pool);
  let dropNext = false; let lastRes;
  const lossy = Object.create(real);
  lossy.write = async function write(db, ctx) {
    await real.write(db, ctx);
    if (dropNext) { dropNext = false; lastRes.socket.destroy(); }
  };
  const app = buildApp(lossy, { before: [(_req, res, next) => { lastRes = res; next(); }] });
  await withServer(app, async (url) => {
    const key = randomUUID();
    dropNext = true;
    await assert.rejects(rawPost(url, lead(), [["Idempotency-Key", key]]));
    const ref = fake.data().leads[0].id;
    const retry = await post(url, lead(), key);
    assert.equal(retry.body.data.id, ref);
    assert.equal(retry.body.idempotent_replay, true);
    assert.equal(fake.data().leads.length, 1);
  });
});
