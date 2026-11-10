import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/router.js", import.meta.url), "utf8").replace(/\r/g, "");
const lines = src.split("\n");
const authAt = lines.findIndex((l) => /^router\.use\(authMiddleware\);/.test(l));

test("router.use(authMiddleware) exists exactly once and is the first router.use", () => {
  const uses = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^router\.use\(/.test(l));
  assert.equal(uses.length, 1, "no other router-level middleware may be added without review");
  assert.equal(uses[0].i, authAt);
});

test("the unauthenticated route allowlist includes only the reviewed routes and TOTP verification", () => {
  const before = lines.slice(0, authAt).join("\n");
  const found = [...before.matchAll(/^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
  assert.deepEqual(found, [
    "POST /access-requests", "POST /auth/login", "POST /auth/request-password-reset", "POST /auth/reset-password",
    "POST /auth/totp/enrollment/start", "POST /auth/totp/enrollment/confirm", "POST /auth/totp/verify", "POST /leads"
  ].sort());
});

test("no route is registered with a template literal or variable path before the auth line", () => {
  const before = lines.slice(0, authAt).join("\n");
  assert.equal(/router\.(get|post|put|patch|delete)\(\s*[`a-zA-Z_]/.test(before), false);
});

test("no route file other than router.js mounts handlers on the app", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8").replace(/\r/g, "");
  const mounts = [...server.matchAll(/^app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(mounts, ["GET /healthz"], "any new app-level route bypasses the auth line");
});

test("server.js never logs tokens, passwords or connection strings", () => {
  for (const f of ["../server.js", "../src/controllers/authController.js", "../src/controllers/totpController.js", "../src/controllers/accessRequestsController.js", "../src/accountTokens.js"]) {
    const s = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of s.matchAll(/console\.(log|info|warn|error)\(([^;]*)\)/g)) {
      assert.equal(/token|password|DATABASE_URL|secret|link/i.test(m[2]), false, `${f}: ${m[0]}`);
    }
  }
});
