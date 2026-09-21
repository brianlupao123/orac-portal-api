import assert from "node:assert/strict";
import test from "node:test";
import { requestPasswordReset, resetPassword } from "../src/controllers/authController.js";

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function requestFor(email) {
  const auditEvents = [];
  const db = {
    users: [{ id: "user-1", email: "person@example.test", is_active: true, password_hash: "hash" }]
  };
  const req = {
    body: { email },
    db,
    store: {
      audit(_db, _actor, _entity, _id, action, before, after) {
        auditEvents.push({ action, before, after });
      }
    }
  };
  return { req, db, auditEvents };
}

test("password reset requests are generic and do not create or expose reset tokens without delivery", () => {
  const known = requestFor("person@example.test");
  const knownResponse = response();
  requestPasswordReset(known.req, knownResponse);

  const unknown = requestFor("missing@example.test");
  const unknownResponse = response();
  requestPasswordReset(unknown.req, unknownResponse);

  assert.deepEqual(knownResponse.body, unknownResponse.body);
  assert.equal(known.db.users[0].reset_token, undefined);
  assert.equal(known.db.users[0].reset_token_expires_at, undefined);
  assert.deepEqual(known.auditEvents, [{
    action: "PASSWORD_RESET_REQUESTED",
    before: null,
    after: { delivery: "not_configured" }
  }]);
  assert.equal(JSON.stringify(known.auditEvents).includes("token"), false);
  assert.equal(JSON.stringify(known.auditEvents).includes("reset-password"), false);
});

test("reset completion rejects an unissued token", () => {
  const { req } = requestFor("person@example.test");
  req.body = { email: "person@example.test", token: "unissued", new_password: "long-enough-password" };
  const res = response();
  resetPassword(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /invalid or has expired/);
});
