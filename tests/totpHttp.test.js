import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import router from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createPublicEndpointLimits } from "../src/middleware/rateLimit.js";
import { encryptTotpSecret, generateTotpSecret, totpAt } from "../src/totp.js";
import { generateToken } from "../src/middleware/auth.js";

test("real HTTP route persists TOTP challenges and failed attempts before issuing a JWT", async () => {
  const previousRoles = process.env.ORAC_TOTP_PROTECTED_ROLES;
  const previousKey = process.env.ORAC_TOTP_ENCRYPTION_KEY;
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  let server;
  try {
    const secret = generateTotpSecret();
    let state = { users: [{ id: "u1", email: "admin@fixture.invalid", role: "Admin", is_active: true,
      password_hash: bcrypt.hashSync("long-fixture-password", 4),
      totp: { secret: encryptTotpSecret(secret), last_counter: -1, recovery_hashes: [], version: "v1" } }], audit_logs: [] };
    const store = {
      read: async () => ({ db: structuredClone(state), release: {} }),
      write: async (db) => { state = structuredClone(db); },
      release: async () => {},
      audit: (db, actor, type, id, action) => db.audit_logs.push({ actor_id: actor.id, type, id, action })
    };
    const app = express();
    app.use(express.json());
    app.use("/api", createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "20" } }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", router);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (path, body) => {
      const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const login = await post("/auth/login", { email: "admin@fixture.invalid", password: "long-fixture-password" });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.status, "verification_required");
    assert.equal(login.body.data.token, undefined);
    assert.ok(state.users[0].totp.challenge?.digest);
    const challenge_id = login.body.data.challenge_id;
    const bad = await post("/auth/totp/verify", { email: "admin@fixture.invalid", challenge_id, code: "abcdef" });
    assert.equal(bad.status, 401);
    assert.equal(state.users[0].totp.challenge.attempts, 1);
    const good = await post("/auth/totp/verify", { email: "admin@fixture.invalid", challenge_id,
      code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
    assert.equal(good.status, 200);
    assert.ok(good.body.data.token);
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(state.users[0].totp.challenge, null);
    assert.equal((await post("/auth/totp/verify", { email: "admin@fixture.invalid", challenge_id,
      code: totpAt(secret, Math.floor(Date.now() / 30_000)) })).status, 401);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousRoles === undefined) delete process.env.ORAC_TOTP_PROTECTED_ROLES;
    else process.env.ORAC_TOTP_PROTECTED_ROLES = previousRoles;
    if (previousKey === undefined) delete process.env.ORAC_TOTP_ENCRYPTION_KEY;
    else process.env.ORAC_TOTP_ENCRYPTION_KEY = previousKey;
  }
});

test("a protected, unenrolled Finance user completes ticket enrollment over real HTTP routes", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  let server;
  try {
    const finance = { id: "finance-1", email: "finance@fixture.invalid", role: "Finance", is_active: true,
      password_hash: bcrypt.hashSync("finance-fixture-password", 4), password_changed_by: "finance-1" };
    const admin = { id: "admin-1", email: "admin@fixture.invalid", role: "Admin", is_active: true,
      password_hash: bcrypt.hashSync("admin-fixture-password", 4) };
    let state = { users: [finance, admin], audit_logs: [] };
    const store = {
      read: async () => ({ db: structuredClone(state), release: {} }),
      write: async (db) => { state = structuredClone(db); },
      release: async () => {},
      audit: (db, actor, type, id, action, before, after) => db.audit_logs.push({ actor_id: actor.id, type, id, action, before, after })
    };
    const app = express();
    app.use(express.json());
    app.use("/api", createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "20" } }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", router);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (path, body, bearer) => {
      const response = await fetch(base + path, { method: "POST", headers: {
        "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const blocked = await post("/auth/login", { email: finance.email, password: "finance-fixture-password" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.data?.token, undefined);
    const unauthorizedIssue = await post("/auth/totp/enrollment/tickets", { user_id: finance.id });
    assert.equal(unauthorizedIssue.status, 401);
    const issued = await post("/auth/totp/enrollment/tickets", { user_id: finance.id }, generateToken(admin));
    assert.equal(issued.status, 200);
    assert.equal(issued.headers.get("cache-control"), "no-store");
    const ticket = issued.body.data.ticket;
    assert.equal(JSON.stringify(state).includes(ticket), false);
    const start = await post("/auth/totp/enrollment/start", {
      email: finance.email, password: "finance-fixture-password", ticket
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get("cache-control"), "no-store");
    const secret = new URL(start.body.data.otpauth_uri).searchParams.get("secret");
    const confirmed = await post("/auth/totp/enrollment/confirm", {
      email: finance.email, enrollment_id: start.body.data.enrollment_id,
      code: totpAt(secret, Math.floor(Date.now() / 30_000))
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.recovery_codes.length, 10);
    assert.equal(state.users[0].totp_enrollment_ticket, null);
    assert.equal(JSON.stringify(state).includes(ticket), false);
    const challenged = await post("/auth/login", { email: finance.email, password: "finance-fixture-password" });
    assert.equal(challenged.body.data.status, "verification_required");
    const verified = await post("/auth/totp/verify", {
      email: finance.email, challenge_id: challenged.body.data.challenge_id,
      recovery_code: confirmed.body.data.recovery_codes[0]
    });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.data.token);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries({
      ORAC_TOTP_PROTECTED_ROLES: previous.roles,
      ORAC_TOTP_ENROLLMENT_ENABLED: previous.enrollment,
      ORAC_TOTP_ENCRYPTION_KEY: previous.key
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("two distinct Admin sessions execute factor reset request and approval over real HTTP routes", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  let server;
  try {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const secretTarget = generateTotpSecret();
    const adminA = { id: "admin-a", email: "adminA@fixture.invalid", role: "Admin", is_active: true,
      password_hash: bcrypt.hashSync("admin-a-pass", 4),
      totp: { secret: encryptTotpSecret(secretA), version: "vA", last_counter: 1 } };
    const adminB = { id: "admin-b", email: "adminB@fixture.invalid", role: "Admin", is_active: true,
      password_hash: bcrypt.hashSync("admin-b-pass", 4),
      totp: { secret: encryptTotpSecret(secretB), version: "vB", last_counter: 1 } };
    const adminTarget = {
      id: "admin-target", email: "adminTarget@fixture.invalid", role: "Admin", is_active: true,
      password_hash: bcrypt.hashSync("admin-target-pass", 4),
      totp: { secret: encryptTotpSecret(secretTarget), last_counter: 1, recovery_hashes: [], version: "vT" },
      session_epoch: 1
    };
    let state = { users: [adminA, adminB, adminTarget], audit_logs: [] };
    const store = {
      read: async () => ({ db: structuredClone(state), release: {} }),
      write: async (db) => { state = structuredClone(db); },
      release: async () => {},
      audit: (db, actor, type, id, action, before, after) => db.audit_logs.push({ actor_id: actor?.id, type, id, action, before, after })
    };
    const app = express();
    app.use(express.json());
    app.use("/api", createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "20" } }));
    app.use("/api", persistenceMiddleware(store));
    app.use("/api", router);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (path, body, bearer) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
        },
        body: JSON.stringify(body)
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };

    const tokenA = generateToken(adminA, { factorVerified: true });
    const tokenB = generateToken(adminB, { factorVerified: true });
    const tokenTarget = generateToken(adminTarget, { factorVerified: true });

    // 1. Unauthenticated reset request is rejected
    const unauth = await post("/auth/totp/factor/reset/request", { user_id: adminTarget.id });
    assert.equal(unauth.status, 401);

    // 2. Direct reset route rejects Admin target even with bearer token
    const directAdmin = await post("/auth/totp/factor/reset", { user_id: adminTarget.id, approver_id: adminB.id }, tokenA);
    assert.equal(directAdmin.status, 403);
    assert.equal(directAdmin.body.message.includes("dual-authorization"), true);

    // 3. Admin A requests factor reset over HTTP
    const reqRes = await post("/auth/totp/factor/reset/request", { user_id: adminTarget.id }, tokenA);
    assert.equal(reqRes.status, 200);
    assert.equal(reqRes.headers.get("cache-control"), "no-store");
    assert.ok(reqRes.body.data.request_id);
    const requestId = reqRes.body.data.request_id;

    // Verify raw request_id is not stored in plain text
    const persistedTarget = state.users.find((u) => u.id === adminTarget.id);
    assert.ok(persistedTarget.totp_factor_reset_request);
    assert.equal(JSON.stringify(persistedTarget.totp_factor_reset_request).includes(requestId), false);

    // 4. Admin A attempts self-approval over HTTP (must be rejected)
    const selfApprove = await post("/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenA);
    assert.equal(selfApprove.status, 403);

    // 5. Target Admin attempts to approve their own factor reset (must be rejected)
    const targetApprove = await post("/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenTarget);
    assert.equal(targetApprove.status, 403);

    // 6. Wrong request_id is rejected over HTTP
    const wrongId = crypto.randomBytes(32).toString("base64url");
    const badId = await post("/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: wrongId }, tokenB);
    assert.equal(badId.status, 400);

    // 7. Distinct Admin B approves the factor reset over HTTP
    const approved = await post("/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB);
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get("cache-control"), "no-store");
    assert.equal(approved.body.success, true);

    // Verify factor and pending request are cleared, session epoch incremented
    const finalTarget = state.users.find((u) => u.id === adminTarget.id);
    assert.equal(finalTarget.totp, null);
    assert.equal(finalTarget.totp_factor_reset_request, null);
    assert.equal(finalTarget.session_epoch, 2);

    // Verify audit rows in state
    const requestedAudit = state.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_REQUESTED");
    assert.ok(requestedAudit);
    assert.equal(requestedAudit.actor_id, adminA.id);

    const approvedAudit = state.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_APPROVED");
    assert.ok(approvedAudit);
    assert.equal(approvedAudit.actor_id, adminB.id);

    // 8. Replay resistance over HTTP: second approval attempt fails
    const replayed = await post("/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB);
    assert.equal(replayed.status, 404);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries({
      ORAC_TOTP_PROTECTED_ROLES: previous.roles,
      ORAC_TOTP_ENROLLMENT_ENABLED: previous.enrollment,
      ORAC_TOTP_ENCRYPTION_KEY: previous.key
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
