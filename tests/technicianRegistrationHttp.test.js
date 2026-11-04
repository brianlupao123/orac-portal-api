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

// Real Express app, real router, real mutex-locking persistence and a real JSON
// file store in a temp directory: the layer the controller tests cannot reach
// (authentication, routing, the write-back to disk and the double-click race).

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", apiRouter);
  app.use("/api", (req, res) => res.status(404).json({ success: false, message: "API route not found." }));
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." }));
  return app;
}

async function withServer(app, body) {
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  try { await body(`http://127.0.0.1:${server.address().port}/api`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "orac-techreg-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  const db = JSON.parse(readFileSync(file, "utf8"));
  db.users.push({ id: "u_admin2", name: "Admin Two", email: "admin2@orac.co.zw", role: "Admin", is_active: true, password_hash: db.users[0].password_hash });
  writeFileSync(file, JSON.stringify(db, null, 2));
  return { store, file };
}

const authed = (url, user, init = {}) => fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}), Authorization: `Bearer ${generateToken(user)}` } });
const post = (url, user, body) => authed(url, user, { method: "POST", body: JSON.stringify(body ?? {}) });
const ADMIN = { id: "u_admin", email: "admin@orac.co.zw", role: "Admin", is_active: true };
const ADMIN2 = { id: "u_admin2", email: "admin2@orac.co.zw", role: "Admin", is_active: true };
const SUPERVISOR = { id: "u_supervisor", email: "supervisor@orac.co.zw", role: "Supervisor", is_active: true };
const OPS = { id: "u_ops", email: "ops@orac.co.zw", role: "Operations", is_active: true };
const TECH = { id: "u_tech", email: "tech@orac.co.zw", role: "Technician", is_active: true };
const PAYLOAD = { first_name: "Tendai", last_name: "Moyo", national_id: "63-123456 A 42", trade: "Welder", worker_type: "contractor", phone_number: "+263 77 123 4567" };
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("end to end: Supervisor submits, Admin approves in one call, and the technician exists on disk", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD });
    assert.equal(created.status, 201);
    const request = (await created.json()).data;
    assert.equal(request.recipient_role, "Admin");
    assert.equal(request.status, "Submitted");

    const inbox = await (await authed(`${base}/internal-work-requests/inbox`, ADMIN)).json();
    assert.deepEqual(inbox.data.map((row) => row.id), [request.id]);
    assert.ok(inbox.data[0].allowed_actions.includes("approve_registration"));

    const approved = await post(`${base}/internal-work-requests/${request.id}/approve-technician`, ADMIN);
    assert.equal(approved.status, 200);
    const result = (await approved.json()).data;
    assert.equal(result.status, "Completed");
    assert.equal(result.technician.name, "Tendai Moyo");

    const db = read(file);
    const user = db.users.find((u) => u.id === result.technician.id);
    assert.equal(user.role, "Technician");
    assert.equal(user.trade, "Welder");
    assert.equal(user.worker_type, "contractor");
    assert.equal(user.national_id, PAYLOAD.national_id);
    assert.equal(user.email, null);
    assert.equal(user.password_hash, null);
    assert.equal(db.internal_work_requests.find((r) => r.id === request.id).registered_user_id, user.id);

    // Audit trail: present, and free of the ID and phone number.
    const actions = db.audit_logs.map((entry) => entry.action);
    assert.ok(actions.includes("TECHNICIAN_REGISTERED_FROM_REQUEST") && actions.includes("INTERNAL_WORK_REQUEST_COMPLETED"));
    const trail = JSON.stringify(db.audit_logs) + JSON.stringify(db.notifications);
    assert.equal(trail.includes("63-123456"), false);
    assert.equal(trail.includes("77 123"), false);

    // Notifications: Admin was told on submit, the Supervisor on completion.
    assert.ok(db.notifications.some((n) => n.type === "internal_request" && (n.target_roles || []).includes("Admin")));
    assert.ok(db.notifications.some((n) => n.type === "internal_request" && n.user_id === "u_supervisor" && /completed/.test(n.message)));

    // The Admin user screen can list the new technician and never returns credentials.
    const users = (await (await authed(`${base}/users`, ADMIN)).json()).data;
    const listed = users.find((u) => u.id === user.id);
    assert.equal(listed.name, "Tendai Moyo");
    assert.equal("password_hash" in listed, false);

    // The new technician can be found by the dispatch roster logic (role + active) and has a classified trade.
    assert.equal(listed.role, "Technician");
    assert.equal(listed.is_active, true);
  });
});

test("the technician's national ID is not readable by anyone except Admin", async () => {
  const { store } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await (await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD })).json();
    const id = created.data.id;
    await post(`${base}/internal-work-requests/${id}/approve-technician`, ADMIN);
    for (const user of [SUPERVISOR, OPS, TECH]) {
      assert.equal((await authed(`${base}/users`, user)).status, 403, `${user.role} must not list users`);
    }
    const opsView = await authed(`${base}/internal-work-requests/${id}`, OPS);
    assert.equal(opsView.status, 404, "Operations cannot open the request");
    const text = await (await authed(`${base}/audit_logs`, ADMIN)).text();
    assert.equal(text.includes("63-123456"), false);
  });
});

test("route guards: no token is 401; Supervisor, Technician and Operations cannot approve", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await (await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD })).json();
    const url = `${base}/internal-work-requests/${created.data.id}/approve-technician`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    for (const user of [SUPERVISOR, TECH, OPS]) assert.equal((await post(url, user)).status, 403, user.role);
    assert.equal(read(file).users.some((u) => u.national_id), false);
    assert.equal(read(file).internal_work_requests[0].status, "Submitted");
  });
});

test("a Technician cannot raise a registration, and a bad payload is a 400 at the route", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const asTech = await post(`${base}/internal-work-requests`, TECH, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD });
    assert.equal(asTech.status, 403);
    for (const payload of [{ ...PAYLOAD, trade: "Astronaut" }, { ...PAYLOAD, extra: 1 }, { ...PAYLOAD, phone_number: "1" }]) {
      const res = await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload });
      assert.equal(res.status, 400);
    }
    assert.equal(read(file).internal_work_requests.length, 0);
  });
});

test("a double click or two Admins at once creates exactly one technician", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const created = await (await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD })).json();
    const url = `${base}/internal-work-requests/${created.data.id}/approve-technician`;
    const results = await Promise.all([post(url, ADMIN), post(url, ADMIN), post(url, ADMIN2), post(url, ADMIN2)]);
    const statuses = results.map((res) => res.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409]);
    const db = read(file);
    assert.equal(db.users.filter((u) => u.national_id).length, 1);
    assert.equal(db.audit_logs.filter((entry) => entry.action === "TECHNICIAN_REGISTERED_FROM_REQUEST").length, 1);
  });
});

test("the same person submitted twice: the first approval wins, the second is refused as a duplicate", async () => {
  const { store, file } = makeTempStore();
  await withServer(buildApp(store), async (base) => {
    const one = await (await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: PAYLOAD })).json();
    const two = await (await post(`${base}/internal-work-requests`, SUPERVISOR, { request_type: "NEW_TECHNICIAN_REGISTRATION", payload: { ...PAYLOAD, national_id: "63123456a42" } })).json();
    assert.equal((await post(`${base}/internal-work-requests/${one.data.id}/approve-technician`, ADMIN)).status, 200);
    const dup = await post(`${base}/internal-work-requests/${two.data.id}/approve-technician`, ADMIN);
    assert.equal(dup.status, 409);
    assert.equal(read(file).users.filter((u) => u.national_id).length, 1);
    const reject = await post(`${base}/internal-work-requests/${two.data.id}/transition`, ADMIN, { action: "reject", note: "Already registered" });
    assert.equal(reject.status, 200);
  });
});
