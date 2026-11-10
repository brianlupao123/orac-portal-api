import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import router from "../src/router.js";
import { createStore } from "../src/store.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createPublicEndpointLimits } from "../src/middleware/rateLimit.js";
import { encryptTotpSecret, generateTotpSecret, totpAt, digestOpaque } from "../src/totp.js";

test("file-backed JSON store issues one session for concurrent TOTP and recovery-code use", async () => {
  const previousRoles = process.env.ORAC_TOTP_PROTECTED_ROLES;
  const previousKey = process.env.ORAC_TOTP_ENCRYPTION_KEY;
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  const folder = mkdtempSync(join(tmpdir(), "orac-totp-concurrency-"));
  const filePath = join(folder, "fixture.json");
  let server;
  try {
    const email = "finance-concurrent@fixture.invalid";
    const password = "fixture-finance-password";
    const secret = generateTotpSecret();
    const recoveryCode = crypto.randomBytes(18).toString("base64url");
    writeFileSync(filePath, JSON.stringify({
      users: [{ id: "finance-concurrent", email, role: "Finance", is_active: true,
        password_hash: bcrypt.hashSync(password, 4),
        totp: { secret: encryptTotpSecret(secret), last_counter: -1,
          recovery_hashes: [digestOpaque(recoveryCode)], version: "fixture-factor" } }],
      audit_logs: []
    }));
    const store = createStore(filePath);
    const app = express();
    app.use(express.json());
    app.use("/api", createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "100" } }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", router);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (path, body) => {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const login = async () => {
      const response = await post("/auth/login", { email, password });
      assert.equal(response.status, 200);
      return response.body.data.challenge_id;
    };
    const challenge = await login();
    const code = totpAt(secret, Math.floor(Date.now() / 30_000));
    const totpResults = await Promise.all(Array.from({ length: 2 }, () => post("/auth/totp/verify", { email, challenge_id: challenge, code })));
    assert.deepEqual(totpResults.map((result) => result.status).sort(), [200, 401]);
    assert.equal(totpResults.filter((result) => result.body.data?.token).length, 1);
    const secondChallenge = await login();
    const recoveryResults = await Promise.all(Array.from({ length: 2 }, () => post("/auth/totp/verify", {
      email, challenge_id: secondChallenge, recovery_code: recoveryCode
    })));
    assert.deepEqual(recoveryResults.map((result) => result.status).sort(), [200, 401]);
    assert.equal(recoveryResults.filter((result) => result.body.data?.token).length, 1);
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(saved.users.find((user) => user.id === "finance-concurrent").totp.recovery_hashes.length, 0);
    assert.equal(JSON.stringify(saved).includes(recoveryCode), false);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
    if (previousRoles === undefined) delete process.env.ORAC_TOTP_PROTECTED_ROLES;
    else process.env.ORAC_TOTP_PROTECTED_ROLES = previousRoles;
    if (previousKey === undefined) delete process.env.ORAC_TOTP_ENCRYPTION_KEY;
    else process.env.ORAC_TOTP_ENCRYPTION_KEY = previousKey;
  }
});
