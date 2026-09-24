import assert from "node:assert/strict";
import test from "node:test";
import { createAccessRequest } from "../src/controllers/accessRequestsController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function requestFor(email, db = { users: [], access_requests: [] }) {
  return {
    body: { name: "Jane Doe", email, requested_role: "Sales", reason: "" },
    db,
    store: { id: () => "areq_test", audit: () => {} }
  };
}

test("public access requests do not reveal whether an email already exists or is pending", () => {
  const fresh = response();
  createAccessRequest(requestFor("fresh@example.test"), fresh);

  const existingUser = response();
  createAccessRequest(requestFor("user@example.test", {
    users: [{ id: "u1", email: "user@example.test" }], access_requests: []
  }), existingUser);

  const pending = response();
  createAccessRequest(requestFor("pending@example.test", {
    users: [], access_requests: [{ id: "a1", email: "pending@example.test", status: "Pending" }]
  }), pending);

  assert.equal(fresh.statusCode, 200);
  assert.deepEqual(existingUser.body, fresh.body);
  assert.deepEqual(pending.body, fresh.body);
  assert.deepEqual(fresh.body, { success: true, data: { status: "Pending" } });
});
