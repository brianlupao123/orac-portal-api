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

test("production runtime refuses RATE_LIMIT_DISABLED=true", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { validateRuntimeConfig } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; validateRuntimeConfig()`],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        STORE_DRIVER: "postgres",
        DATABASE_URL: "postgres://not-connected.invalid/orac-test",
        JWT_SECRET: "test-secret-which-is-long-enough-for-production-validation",
        RATE_LIMIT_DISABLED: "true"
      },
      encoding: "utf8"
    });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RATE_LIMIT_DISABLED=true is not permitted in production/);
});

test("runtime config rejects malformed TRUST_PROXY_HOPS and accepts zero", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (trustProxyHops) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { validateRuntimeConfig } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; validateRuntimeConfig()`],
    {
      env: { ...process.env, TRUST_PROXY_HOPS: trustProxyHops },
      encoding: "utf8"
    });
  for (const value of ["abc", "1.5", "-1", "9007199254740992"]) {
    const result = run(value);
    assert.notEqual(result.status, 0, `expected ${value} to be rejected`);
    assert.match(result.stderr, /Invalid TRUST_PROXY_HOPS/);
  }
  assert.equal(run("0").status, 0);
  assert.equal(run("2").status, 0);
});
