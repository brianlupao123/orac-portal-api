import assert from "node:assert/strict";
import test from "node:test";
import { getActor } from "../src/controllers/coreController.js";
import { updateUser } from "../src/controllers/adminController.js";
import { roles } from "../src/permissions.js";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function makeDb(users) {
  return {
    users: users.map(u => ({ is_active: true, ...u })),
    audit_logs: [],
    sessions: []
  };
}

test("getActor: fails closed with 401 when req.user is missing or null", () => {
  const db = makeDb([{ id: "u_admin", role: roles.ADMIN }]);
  assert.throws(() => getActor({ db }), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /Unauthenticated request/);
    return true;
  });

  assert.throws(() => getActor({ db, user: null }), (err) => {
    assert.equal(err.status, 401);
    return true;
  });

  assert.throws(() => getActor({ db, user: {} }), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test("getActor: fails closed with 401 when req.user.id does not exist in db.users", () => {
  const db = makeDb([{ id: "u_admin", role: roles.ADMIN }]);
  assert.throws(() => getActor({ db, user: { id: "u_nonexistent" } }), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /User record not found/);
    return true;
  });
});

test("getActor: returns the authenticated user record when present", () => {
  const db = makeDb([
    { id: "u_admin", role: roles.ADMIN, name: "Admin User" },
    { id: "u_finance", role: roles.FINANCE, name: "Finance User" }
  ]);
  const actor = getActor({ db, user: { id: "u_finance" } });
  assert.equal(actor.id, "u_finance");
  assert.equal(actor.role, roles.FINANCE);
});

test("last-Admin lockout guard: cannot demote the only active Admin", () => {
  const db = makeDb([
    { id: "u_admin1", role: roles.ADMIN, is_active: true },
    { id: "u_finance", role: roles.FINANCE, is_active: true }
  ]);
  const req = {
    db,
    user: { id: "u_admin1" },
    params: { id: "u_admin1" },
    body: { role: roles.OPERATIONS },
    store: {
      audit() {}
    }
  };
  const res = makeRes();
  updateUser(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /last active Admin/);
  // Ensure the user role was NOT changed
  assert.equal(db.users[0].role, roles.ADMIN);
});

test("last-Admin lockout guard: cannot deactivate the only active Admin", () => {
  const db = makeDb([
    { id: "u_admin1", role: roles.ADMIN, is_active: true },
    { id: "u_finance", role: roles.FINANCE, is_active: true }
  ]);
  const req = {
    db,
    user: { id: "u_admin1" },
    params: { id: "u_admin1" },
    body: { is_active: false },
    store: {
      audit() {}
    }
  };
  const res = makeRes();
  updateUser(req, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /last active Admin/);
  assert.equal(db.users[0].is_active, true);
});

test("last-Admin lockout guard: demoting or deactivating succeeds when another active Admin exists", () => {
  const db = makeDb([
    { id: "u_admin1", role: roles.ADMIN, is_active: true },
    { id: "u_admin2", role: roles.ADMIN, is_active: true }
  ]);
  const req = {
    db,
    user: { id: "u_admin1" },
    params: { id: "u_admin2" },
    body: { role: roles.MANAGEMENT },
    store: {
      audit() {}
    }
  };
  const res = makeRes();
  updateUser(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.users.find(u => u.id === "u_admin2").role, roles.MANAGEMENT);
});
