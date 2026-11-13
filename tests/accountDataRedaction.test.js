import assert from "node:assert/strict";
import test from "node:test";
import { createUser, updateUser } from "../src/controllers/adminController.js";
import { getCollection } from "../src/controllers/coreController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function database() {
  const admin = { id: "admin-1", name: "Admin", email: "admin@example.test", role: "Admin", is_active: true, password_hash: "admin-hash" };
  return {
    users: [admin],
    audit_logs: [{
      id: "audit-1",
      entity_type: "user",
      old_values: { password_hash: "old-hash", reset_token: "old-token", name: "Old" },
      new_values: { password: "raw", password_hash: "new-hash", nested: { reset_token: "nested-token", name: "New" } }
    }]
  };
}

function store() {
  return { id: () => "user-2", audit(_db, _actor, _entity, _id, _action, before, after) { this.before = before; this.after = after; } };
}

test("Admin create and update responses and audit payloads omit credential fields", () => {
  const db = database();
  const backingStore = store();
  const createRequest = { user: { id: "admin-1" }, db, store: backingStore, body: { name: "New", email: "new@example.test", role: "Technician", password: "a-long-enough-password" } };
  const createResponse = response();
  createUser(createRequest, createResponse);
  assert.equal(createResponse.body.data.password_hash, undefined);
  assert.equal(backingStore.after.password_hash, undefined);
  assert.equal(backingStore.after.bank_account, undefined);

  const updateRequest = { user: { id: "admin-1" }, db, store: backingStore, params: { id: "user-2" }, body: { password: "another-long-password" } };
  const updateResponse = response();
  updateUser(updateRequest, updateResponse);
  assert.equal(updateResponse.body.data.password_hash, undefined);
  assert.equal(backingStore.before.password_hash, undefined);
  assert.equal(backingStore.after.password_hash, undefined);
  assert.equal(backingStore.after.bank_account, undefined);
});

test("users and audit-log collection responses redact nested credential fields", () => {
  const db = database();
  const request = { user: { id: "admin-1" }, db };
  const usersResponse = response();
  getCollection("users")(request, usersResponse);
  assert.equal(usersResponse.body.data[0].password_hash, undefined);

  const auditResponse = response();
  getCollection("audit_logs")(request, auditResponse);
  const audit = auditResponse.body.data[0];
  assert.equal(audit.old_values.password_hash, undefined);
  assert.equal(audit.old_values.reset_token, undefined);
  assert.equal(audit.new_values.password, undefined);
  assert.equal(audit.new_values.nested.reset_token, undefined);
  assert.equal(audit.new_values.nested.name, "New");
});
