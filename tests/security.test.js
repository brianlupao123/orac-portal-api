import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { config, DEV_JWT_SECRET, validateRuntimeConfig } from "../src/config.js";
import { generateToken } from "../src/middleware/auth.js";

test("JWT secret no longer uses the old hardcoded development value", () => {
  assert.notEqual(config.jwtSecret, "orac-dev-secret-key-12345");
});

test("generateToken signs tokens with current config secret", () => {
  const token = generateToken({
    id: "u_test",
    email: "test@orac.co.zw",
    role: "Admin",
    is_active: true
  });
  const payload = jwt.verify(token, config.jwtSecret);
  assert.equal(payload.id, "u_test");
});

test("development fallback secret remains non-production only", () => {
  if (config.isProduction) {
    assert.notEqual(config.jwtSecret, DEV_JWT_SECRET);
  } else {
    assert.ok(config.jwtSecret.length >= 32);
  }
});

test("runtime config validates current demo environment", () => {
  assert.doesNotThrow(() => validateRuntimeConfig());
});
