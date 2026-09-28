import assert from "node:assert/strict";
import test from "node:test";
import { createUser, updateUser } from "../src/controllers/adminController.js";
import { roles } from "../src/permissions.js";

// This file did not exist before the Chat E governance/administration pass —
// adminController.js's user-lifecycle mutations (createUser/updateUser) had
// zero direct unit tests. These cover: (1) permission gating already
// implemented by requirePermission, as a regression guard, and (2) the new
// "Client Viewer must have a client_id that matches a real client" gap fix.
//
// NOTE: these tests call the controller functions directly (no HTTP layer,
// no validate() middleware), the same style tests/accessRequestEnumeration.test.js
// uses, so the request bodies below deliberately bypass AdminCreateUserSchema's
// new .refine() to prove the *controller* itself also rejects a bad
// role/client_id combination — not only the schema layer in front of it.

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function baseDb(overrides = {}) {
  return {
    users: [
      { id: "admin-1", role: roles.ADMIN, is_active: true },
      { id: "tech-1", role: roles.TECHNICIAN, is_active: true }
    ],
    clients: [{ id: "client-a", name: "Client A" }],
    ...overrides
  };
}

function store() {
  const audits = [];
  return { audits, id: (prefix) => `${prefix}_test`, audit: (...args) => audits.push(args) };
}

function requestAs(actorId, db, body = {}, params = {}) {
  return { user: { id: actorId }, db, store: store(), body, params };
}

// ---------------------------------------------------------------- createUser

test("createUser: a non-Admin actor is refused (manageUsers is Admin-only)", () => {
  const db = baseDb();
  const req = requestAs("tech-1", db, {
    name: "New Person", email: "new@example.test", password: "longenoughpassword",
    role: roles.OPERATIONS
  });
  assert.throws(() => createUser(req, response()), /cannot perform manageUsers/);
  assert.equal(db.users.length, 2, "no user should have been created");
});

test("createUser: rejects Client Viewer with no client_id instead of creating a silently broken account", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, {
    name: "Client Contact", email: "contact@example.test", password: "longenoughpassword",
    role: roles.CLIENT_VIEWER
    // client_id intentionally omitted
  });
  const res = response();
  createUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /client_id is required/);
  assert.equal(db.users.length, 2, "rejected request must not create a user");
  assert.equal(req.store.audits.length, 0, "rejected request must not write an audit entry");
});

test("createUser: rejects Client Viewer whose client_id does not match any real client", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, {
    name: "Client Contact", email: "contact@example.test", password: "longenoughpassword",
    role: roles.CLIENT_VIEWER, client_id: "client-does-not-exist"
  });
  const res = response();
  createUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /does not match an existing client/);
  assert.equal(db.users.length, 2);
});

test("createUser: a Client Viewer with a valid client_id is created normally", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, {
    name: "Client Contact", email: "contact@example.test", password: "longenoughpassword",
    role: roles.CLIENT_VIEWER, client_id: "client-a"
  });
  const res = response();
  createUser(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.client_id, "client-a");
  assert.equal(db.users.length, 3);
  assert.equal(req.store.audits.length, 1);
  assert.equal(req.store.audits[0][4], "ADMIN_USER_CREATED");
});

test("createUser: a non-Client-Viewer role with no client_id is unaffected by the gap fix", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, {
    name: "Ops Person", email: "ops@example.test", password: "longenoughpassword",
    role: roles.OPERATIONS
  });
  const res = response();
  createUser(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.client_id, null);
});

// ---------------------------------------------------------------- updateUser

test("updateUser: promoting an existing user to Client Viewer without a client_id is rejected, and nothing is changed", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, { role: roles.CLIENT_VIEWER }, { id: "tech-1" });
  const res = response();
  updateUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /client_id is required/);
  const target = db.users.find((u) => u.id === "tech-1");
  assert.equal(target.role, roles.TECHNICIAN, "role must not change on a rejected request");
  assert.equal(req.store.audits.length, 0);
});

test("updateUser: promoting to Client Viewer while supplying a valid client_id in the same request succeeds", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, { role: roles.CLIENT_VIEWER, client_id: "client-a" }, { id: "tech-1" });
  const res = response();
  updateUser(req, res);
  assert.equal(res.statusCode, 200);
  const target = db.users.find((u) => u.id === "tech-1");
  assert.equal(target.role, roles.CLIENT_VIEWER);
  assert.equal(target.client_id, "client-a");
});

test("updateUser: an already-valid Client Viewer can still be edited without re-supplying client_id", () => {
  const db = baseDb({
    users: [
      { id: "admin-1", role: roles.ADMIN, is_active: true },
      { id: "viewer-1", role: roles.CLIENT_VIEWER, client_id: "client-a", is_active: true, name: "Old Name" }
    ]
  });
  const req = requestAs("admin-1", db, { name: "New Name" }, { id: "viewer-1" });
  const res = response();
  updateUser(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.name, "New Name");
  assert.equal(res.body.data.client_id, "client-a", "client_id must be preserved, not cleared");
});

test("updateUser: changing an existing Client Viewer's client_id to an unknown client is rejected", () => {
  const db = baseDb({
    users: [
      { id: "admin-1", role: roles.ADMIN, is_active: true },
      { id: "viewer-1", role: roles.CLIENT_VIEWER, client_id: "client-a", is_active: true }
    ]
  });
  const req = requestAs("admin-1", db, { client_id: "client-ghost" }, { id: "viewer-1" });
  const res = response();
  updateUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.users.find((u) => u.id === "viewer-1").client_id, "client-a");
});

test("updateUser: a non-Admin actor is refused", () => {
  const db = baseDb();
  const req = requestAs("tech-1", db, { name: "x" }, { id: "tech-1" });
  assert.throws(() => updateUser(req, response()), /cannot perform manageUsers/);
});

test("updateUser: unknown user id returns 404", () => {
  const db = baseDb();
  const req = requestAs("admin-1", db, { name: "x" }, { id: "does-not-exist" });
  const res = response();
  updateUser(req, res);
  assert.equal(res.statusCode, 404);
});
