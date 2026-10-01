import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authMiddleware, generateToken } from "../src/middleware/auth.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { getNotifications, markRead, markAllRead } from "../src/controllers/notificationController.js";
import {
  createAccessRequest, approveAccessRequest, rejectAccessRequest, issueAccessRequestSetupLink
} from "../src/controllers/accessRequestsController.js";
import { createServiceRequest, triageServiceRequest } from "../src/controllers/serviceRequestsController.js";
import { getCollection } from "../src/controllers/coreController.js";
import { permissions } from "../src/permissions.js";

// HTTP-level test of Task 01 over REAL dependencies: real Express, real JWT auth
// middleware, real mutex/commit persistence middleware and a real JSON file store
// in a temp directory (never data/db.json).
//
// WHAT THIS DOES NOT PROVE: src/router.js is NOT imported. On the audited baseline
// (origin/main 855620d) router.js imports `getDispatchRoster`, which
// dispatchController.js does not export, so the real router cannot load (the same
// reason internalWorkRequestsHttp.test.js and rosterAssignment.test.js fail on
// baseline). The routes below are therefore mounted here with the real controllers,
// and the last test asserts by SOURCE TEXT that router.js registers the same routes
// behind authMiddleware. Route wiring through the real router remains unverified.

function buildApp(store) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const api = express.Router();
  api.use(persistenceMiddleware(store));
  api.post("/access-requests", createAccessRequest);            // public, as in router.js
  api.use(authMiddleware);
  api.post("/access-requests/:id/approve", approveAccessRequest);
  api.post("/access-requests/:id/reject", rejectAccessRequest);
  api.post("/access-requests/:id/setup-link", issueAccessRequestSetupLink);
  api.get("/notifications", getNotifications);
  api.post("/notifications/read-all", markAllRead);
  api.post("/notifications/:id/read", markRead);
  api.post("/service-requests", createServiceRequest);
  api.post("/service-requests/:id/triage", triageServiceRequest);
  api.get("/access_requests", getCollection("access_requests"));
  api.get("/users", getCollection("users"));
  app.use("/api", api);
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message || "Internal server error." }));
  return app;
}

async function withServer(app, run) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}/api`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "orac-notif-http-"));
  const file = join(dir, "db.json");
  const store = createStore(file);
  const db = JSON.parse(readFileSync(file, "utf8"));
  const hash = db.users[0].password_hash;
  db.users.push({ id: "u_client_mim", name: "Mimosa Viewer", email: "mim@orac.test", role: "Client Viewer", client_id: "c_mimosa", is_active: true, password_hash: hash });
  writeFileSync(file, JSON.stringify(db, null, 2));
  return { store, file };
}

const who = (db, id) => db.users.find((user) => user.id === id);
const call = (base, db, userId, path, init = {}) => fetch(`${base}${path}`, {
  ...init,
  headers: { "Content-Type": "application/json", ...(userId ? { Authorization: `Bearer ${generateToken(who(db, userId))}` } : {}), ...(init.headers || {}) }
});
const post = (base, db, userId, path, body) => call(base, db, userId, path, { method: "POST", body: JSON.stringify(body ?? {}) });
const disk = (file) => JSON.parse(readFileSync(file, "utf8"));

test("access request over HTTP: Admin-only visibility, Admin-only decisions, per-user read state persisted", async () => {
  const { store, file } = makeStore();
  const db = disk(file);
  await withServer(buildApp(store), async (base) => {
    const created = await post(base, db, null, "/access-requests", { name: "Pat New", email: "pat@example.test", requested_role: "Technician", reason: "Field work" });
    assert.equal(created.status, 200, "public create answers generically (no id, no existence leak)");
    assert.deepEqual((await created.json()).data, { status: "Pending" });
    const requestId = disk(file).access_requests.at(-1).id;

    // Persisted, and the notification exists only for Admin.
    const afterCreate = disk(file);
    assert.equal(afterCreate.access_requests.length, 1);
    const adminList = await (await call(base, db, "u_admin", "/notifications")).json();
    assert.equal(adminList.data.length, 1);
    const item = adminList.data[0];
    assert.equal(item.type, "access_request");
    assert.equal(item.read, false);
    assert.equal(item.destination.resolved, true);
    assert.equal(item.destination.route, `/admin?tab=access-requests&focus=${requestId}`);
    for (const key of ["read_by", "target_roles", "audit_log_id", "exclude_user_ids"]) assert.equal(key in item, false, `${key} must not leave the server`);
    assert.equal(JSON.stringify(adminList).includes("pat@example.test"), false, "no requester email in the notification");
    for (const userId of ["u_management", "u_sales", "u_finance", "u_ops", "u_tech", "u_supervisor", "u_client", "u_client_mim"]) {
      const body = await (await call(base, db, userId, "/notifications")).json();
      assert.equal(body.data.length, 0, `${userId} must see no access-request notification`);
    }

    // The inbox does not depend on the notification: Admin lists it; Management is refused.
    const inbox = await call(base, db, "u_admin", "/access_requests");
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json()).data.some((row) => row.id === requestId), true);
    for (const userId of ["u_management", "u_sales", "u_client"]) assert.equal((await call(base, db, userId, "/access_requests")).status, 403, userId);

    // Read state is per user and committed to disk.
    assert.equal((await post(base, db, "u_sales", `/notifications/${item.id}/read`)).status, 404, "a user who cannot see it cannot mark it");
    assert.equal((await post(base, db, "u_admin", `/notifications/${item.id}/read`)).status, 200);
    const stored = disk(file).notifications.find((n) => n.id === item.id);
    assert.deepEqual(stored.read_by, ["u_admin"]);
    const again = await (await call(base, db, "u_admin", "/notifications")).json();
    assert.equal(again.data[0].read, true);
    assert.equal((await post(base, db, "u_admin", "/notifications/read-all")).status, 200);

    // Non-Admin cannot decide; nothing changes.
    for (const userId of ["u_management", "u_sales"]) {
      for (const path of [`/access-requests/${requestId}/approve`, `/access-requests/${requestId}/reject`, `/access-requests/${requestId}/setup-link`]) {
        assert.equal((await post(base, db, userId, path, { role: "Technician" })).status, 403, `${userId} ${path}`);
      }
    }
    assert.equal(disk(file).access_requests[0].status, "Pending");
    assert.equal(disk(file).users.length, db.users.length);
    assert.equal((await post(base, db, null, `/access-requests/${requestId}/approve`, { role: "Technician" })).status, 401);
  });
});

test("approve then one-time setup link over HTTP: no token at approval, hash only on disk, never in audit or user lists", async () => {
  const { store, file } = makeStore();
  const db = disk(file);
  await withServer(buildApp(store), async (base) => {
    assert.equal((await post(base, db, null, "/access-requests", { name: "Pat New", email: "pat2@example.test", requested_role: "Technician", reason: "Field work" })).status, 200);
    const requestId = disk(file).access_requests.at(-1).id;

    // Admin-self-request is refused at the public endpoint.
    const selfAdmin = await post(base, db, null, "/access-requests", { name: "Mallory", email: "mallory@example.test", requested_role: "Admin", reason: "x" });
    assert.ok(selfAdmin.status >= 400 && selfAdmin.status < 500, `Admin self-request refused (got ${selfAdmin.status})`);

    // Approving a Client Viewer without a client is blocked.
    const bad = await post(base, db, "u_admin", `/access-requests/${requestId}/approve`, { role: "Client Viewer" });
    assert.equal(bad.status, 400);

    const approved = await post(base, db, "u_admin", `/access-requests/${requestId}/approve`, { role: "Technician" });
    assert.equal(approved.status, 200);
    const approvedText = JSON.stringify(await approved.json());
    assert.equal(/reset_token|token/i.test(approvedText.replace(/token_expires/gi, "")), false, "approval must not return a token");
    let onDisk = disk(file);
    const created = onDisk.users.find((user) => user.email === "pat2@example.test");
    assert.ok(created);
    assert.equal(created.reset_token, undefined);
    assert.equal(created.reset_token_hash, undefined, "no token exists until the Admin issues one");

    const issued = await post(base, db, "u_admin", `/access-requests/${requestId}/setup-link`);
    assert.equal(issued.status, 200);
    assert.match(issued.headers.get("cache-control") || "", /no-store/);
    const link = (await issued.json()).data;
    const rawToken = /token=([A-Za-z0-9_-]+)/.exec(link.setup_path)?.[1];
    assert.ok(rawToken && rawToken.length >= 40, "long random token returned once");
    assert.match(link.setup_path, /^\/reset-password#email=/, "token travels in the URL fragment");

    onDisk = disk(file);
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes(rawToken), false, "the raw token is never persisted anywhere (user row, audit log, notifications)");
    const row = onDisk.users.find((user) => user.email === "pat2@example.test");
    assert.match(row.reset_token_hash, /^[a-f0-9]{64}$/);

    const users = JSON.stringify(await (await call(base, db, "u_admin", "/users")).json());
    for (const field of ["password_hash", "reset_token_hash", "reset_token\""]) assert.equal(users.includes(field), false, `${field} must be redacted from user lists`);
    const audit = JSON.stringify(onDisk.audit_logs.filter((entry) => /ACCESS_REQUEST/.test(entry.action)));
    assert.equal(audit.includes(rawToken), false);
    assert.equal(audit.includes("reset_token_hash\":\"" + row.reset_token_hash), false, "the stored digest is not copied into audit either");
  });
});

test("service request over HTTP: Sales and Operations are told, the requesting client user hears the decision, other client sees nothing", async () => {
  const { store, file } = makeStore();
  const db = disk(file);
  const site = db.mine_sites.find((item) => item.client_id === "c_zimplats");
  await withServer(buildApp(store), async (base) => {
    const created = await post(base, db, "u_client", "/service-requests", { title: "Pump inspection", service_need: "Secret detail about pump 7.", mine_site_id: site.id });
    assert.equal(created.status, 201);
    const id = (await created.json()).data.id;

    for (const userId of ["u_sales", "u_ops"]) {
      const body = await (await call(base, db, userId, "/notifications")).json();
      assert.equal(body.data.length, 1, userId);
      assert.equal(body.data[0].destination.route, "/service-requests");
      assert.equal(body.data[0].destination.resolved, true);
      assert.equal(JSON.stringify(body).includes("Secret detail"), false, "no request text in the notification");
      assert.equal(JSON.stringify(body).includes("Pump inspection"), false);
    }
    for (const userId of ["u_admin", "u_management", "u_finance", "u_tech", "u_supervisor", "u_client", "u_client_mim"]) {
      assert.equal((await (await call(base, db, userId, "/notifications")).json()).data.length, 0, userId);
    }

    assert.equal((await post(base, db, "u_ops", `/service-requests/${id}/triage`, { decision: "acknowledge" })).status, 200);
    const mine = await (await call(base, db, "u_client", "/notifications")).json();
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].destination.route, "/portal");
    assert.equal((await (await call(base, db, "u_client_mim", "/notifications")).json()).data.length, 0, "other client isolated");

    // Read state of the group notification is per user.
    const salesItem = (await (await call(base, db, "u_sales", "/notifications")).json()).data[0];
    assert.equal((await post(base, db, "u_sales", `/notifications/${salesItem.id}/read`)).status, 200);
    assert.equal((await (await call(base, db, "u_ops", "/notifications")).json()).data.find((n) => n.id === salesItem.id).read, false);
    assert.equal((await (await call(base, db, "u_sales", "/notifications")).json()).data.find((n) => n.id === salesItem.id).read, true);
  });
});

test("a failure while generating a notification does not undo the committed business change (real store)", async () => {
  const { store, file } = makeStore();
  const db = disk(file);
  await withServer(buildApp(store), async (base) => {
    const original = console.error;
    const savedPolicy = permissions.viewAccessRequests;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(" ")); };
    try {
      // The store repairs a corrupted notifications list on read, so induce the failure inside
      // the notification code itself: with the policy list unusable, generation throws a TypeError.
      permissions.viewAccessRequests = null;
      const res = await post(base, db, null, "/access-requests", { name: "Lee Safe", email: "lee@example.test", requested_role: "Technician", reason: "x" });
      assert.equal(res.status, 200, "the business transaction still succeeds");
      assert.equal(disk(file).access_requests.some((row) => row.email === "lee@example.test"), true, "and is committed");
      assert.ok(logged.some((line) => /Notification generation skipped for ACCESS_REQUEST_CREATED: \w+/.test(line)), "the failure really happened and was contained (class name only)");
      assert.equal(logged.join("\n").includes("lee@example.test"), false, "the log never echoes record content");
    } finally { permissions.viewAccessRequests = savedPolicy; console.error = original; }
  });
});

test("router.js registers the same routes behind authMiddleware (source-text check; router cannot be imported on this baseline)", () => {
  const source = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const authAt = source.indexOf("router.use(authMiddleware);");
  assert.ok(authAt > 0);
  assert.ok(source.indexOf('router.post("/access-requests", createAccessRequest);') < authAt, "public create stays before auth");
  for (const line of [
    'router.post("/access-requests/:id/approve", approveAccessRequest);',
    'router.post("/access-requests/:id/reject", rejectAccessRequest);',
    'router.post("/access-requests/:id/setup-link", issueAccessRequestSetupLink);',
    'router.get("/notifications", getNotifications);',
    'router.post("/notifications/read-all", markAllRead);',
    'router.post("/notifications/:id/read", markRead);'
  ]) assert.ok(source.indexOf(line) > authAt, `missing or before auth: ${line}`);
  assert.ok(source.indexOf('router.post("/notifications/read-all"') < source.indexOf('router.post("/notifications/:id/read"'), "read-all must precede :id/read");
});
