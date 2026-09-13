import assert from "node:assert/strict";
import test from "node:test";
import { authMiddleware, generateToken } from "../src/middleware/auth.js";

function runMiddleware(user, tokenUser = user) {
  const token = generateToken(tokenUser);
  const req = {
    headers: { authorization: `Bearer ${token}` },
    db: { users: user ? [user] : [] }
  };
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let nextCalled = false;

  authMiddleware(req, response, () => { nextCalled = true; });
  return { req, response, nextCalled };
}

test("auth middleware hydrates the current active account rather than trusting stale token claims", () => {
  const currentUser = {
    id: "user-1",
    email: "current@orac.co.zw",
    role: "Finance",
    client_id: "client-1",
    is_active: true
  };
  const staleTokenUser = {
    id: "user-1",
    email: "old@orac.co.zw",
    role: "Admin",
    is_active: true
  };

  const result = runMiddleware(currentUser, staleTokenUser);

  assert.equal(result.nextCalled, true);
  assert.deepEqual(result.req.user, {
    id: "user-1",
    email: "current@orac.co.zw",
    role: "Finance",
    client_id: "client-1",
    is_active: true
  });
});

test("auth middleware rejects a valid token after its account is deactivated", () => {
  const user = {
    id: "user-2",
    email: "disabled@orac.co.zw",
    role: "Sales",
    is_active: false
  };

  const result = runMiddleware(user, { ...user, is_active: true });

  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 401);
  assert.equal(result.response.body.message, "Unauthorized. Account is inactive.");
});

test("auth middleware rejects a valid token for an account that no longer exists", () => {
  const tokenUser = {
    id: "missing-user",
    email: "missing@orac.co.zw",
    role: "Sales",
    is_active: true
  };
  const result = runMiddleware(null, tokenUser);

  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 401);
});
