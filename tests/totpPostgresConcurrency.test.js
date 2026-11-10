import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import router from "../src/router.js";
import { createStore as createPostgresStore } from "../src/postgresStore.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createPublicEndpointLimits } from "../src/middleware/rateLimit.js";
import { encryptTotpSecret, generateTotpSecret, totpAt, digestOpaque } from "../src/totp.js";
import { generateToken } from "../src/middleware/auth.js";

/**
 * Creates an in-process PostgreSQL engine with two distinct connection pools
 * (modeling two independent server/worker processes) sharing a single database row,
 * with exact SELECT ... FOR UPDATE row-locking, BEGIN/COMMIT/ROLLBACK transaction
 * semantics, and failure injection.
 */
function createTwoPoolFakePg(initialDb) {
  let committed = JSON.stringify(initialDb);
  let held = false;
  const waiters = [];
  const state = { failUpdate: false, commits: 0, rollbacks: 0 };

  const lock = () => new Promise((resolve) => {
    if (!held) {
      held = true;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });

  const unlock = () => {
    const next = waiters.shift();
    if (next) next();
    else held = false;
  };

  const ok = { rowCount: 0, rows: [] };

  function makePool(poolName) {
    return {
      poolName,
      async connect() {
        let pending = null;
        let holding = false;
        return {
          async query(sql, params) {
            if (sql === "BEGIN" || sql.startsWith("SET LOCAL")) return ok;
            if (sql.startsWith("SELECT data")) {
              if (sql.includes("FOR UPDATE")) {
                await lock();
                holding = true;
              }
              return { rowCount: 1, rows: [{ data: JSON.parse(committed) }] };
            }
            if (sql.startsWith("UPDATE store")) {
              if (state.failUpdate) throw new Error("simulated postgres update failure");
              pending = JSON.stringify(params[0]);
              return { rowCount: 1, rows: [] };
            }
            if (sql === "COMMIT") {
              if (pending !== null) {
                committed = pending;
                state.commits += 1;
              }
              pending = null;
              if (holding) {
                holding = false;
                unlock();
              }
              return ok;
            }
            if (sql === "ROLLBACK") {
              pending = null;
              state.rollbacks += 1;
              if (holding) {
                holding = false;
                unlock();
              }
              return ok;
            }
            throw new Error(`unexpected SQL in fake pool: ${sql}`);
          },
          release() {}
        };
      }
    };
  }

  return {
    poolA: makePool("poolA"),
    poolB: makePool("poolB"),
    state,
    data: () => JSON.parse(committed)
  };
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  app.use("/api", createPublicEndpointLimits({ env: { RATE_LIMIT_PUBLIC_WRITE_MAX: "100" } }));
  app.use("/api", persistenceMiddleware(store));
  app.use("/api", router);
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ success: false, message: error.message });
  });
  return app;
}

async function withTwoServers(storeA, storeB, fn) {
  const serverA = await new Promise((resolve) => {
    const instance = buildApp(storeA).listen(0, "127.0.0.1", () => resolve(instance));
  });
  const serverB = await new Promise((resolve) => {
    const instance = buildApp(storeB).listen(0, "127.0.0.1", () => resolve(instance));
  });

  const urlA = `http://127.0.0.1:${serverA.address().port}/api`;
  const urlB = `http://127.0.0.1:${serverB.address().port}/api`;

  const post = async (baseUrl, path, body, bearer) => {
    const response = await fetch(baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };

  try {
    await fn({ urlA, urlB, post });
  } finally {
    await Promise.all([
      new Promise((resolve, reject) => serverA.close((err) => err ? reject(err) : resolve())),
      new Promise((resolve, reject) => serverB.close((err) => err ? reject(err) : resolve()))
    ]);
  }
}

test("postgres two-pool: concurrent TOTP code verify serialises on row lock, issuing exactly one JWT and failing duplicate with 401", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  try {
    const email = "finance-pg-concurrent@fixture.invalid";
    const password = "fixture-pg-password";
    const secret = generateTotpSecret();
    const initialDb = {
      users: [{
        id: "finance-pg-user",
        email,
        role: "Finance",
        is_active: true,
        password_hash: bcrypt.hashSync(password, 4),
        totp: {
          secret: encryptTotpSecret(secret),
          last_counter: -1,
          recovery_hashes: [],
          version: "v-pg-1"
        }
      }],
      audit_logs: []
    };

    const fake = createTwoPoolFakePg(initialDb);
    const storeA = createPostgresStore(":memory:", fake.poolA);
    const storeB = createPostgresStore(":memory:", fake.poolB);

    await withTwoServers(storeA, storeB, async ({ urlA, urlB, post }) => {
      // Step 1: Login to urlA to generate TOTP challenge
      const loginRes = await post(urlA, "/auth/login", { email, password });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.data.status, "verification_required");
      const challengeId = loginRes.body.data.challenge_id;
      assert.ok(challengeId);

      // Step 2: Compute current valid TOTP code
      const code = totpAt(secret, Math.floor(Date.now() / 30_000));

      // Step 3: Concurrently submit verification across the two different server pools
      const [resA, resB] = await Promise.all([
        post(urlA, "/auth/totp/verify", { email, challenge_id: challengeId, code }),
        post(urlB, "/auth/totp/verify", { email, challenge_id: challengeId, code })
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 401], "exactly one server instance succeeds with 200 and one fails with 401");

      const successes = [resA, resB].filter((r) => r.status === 200);
      assert.equal(successes.length, 1);
      assert.ok(successes[0].body.data.token, "successful verify returns JWT");

      // Verify committed DB state reflects consumed counter and commits
      const committed = fake.data();
      const updatedUser = committed.users.find((u) => u.id === "finance-pg-user");
      assert.ok(updatedUser.totp.last_counter >= 0);
      assert.ok(fake.state.commits >= 1);
    });
  } finally {
    for (const [key, value] of Object.entries({
      ORAC_TOTP_PROTECTED_ROLES: previous.roles,
      ORAC_TOTP_ENCRYPTION_KEY: previous.key
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("postgres two-pool: concurrent recovery code verify across two pools consumes hash exactly once", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  try {
    const email = "finance-rec-pg@fixture.invalid";
    const password = "fixture-rec-pg-password";
    const secret = generateTotpSecret();
    const recoveryCode = crypto.randomBytes(18).toString("base64url");
    const initialDb = {
      users: [{
        id: "finance-rec-pg-user",
        email,
        role: "Finance",
        is_active: true,
        password_hash: bcrypt.hashSync(password, 4),
        totp: {
          secret: encryptTotpSecret(secret),
          last_counter: -1,
          recovery_hashes: [digestOpaque(recoveryCode)],
          version: "v-pg-rec"
        }
      }],
      audit_logs: []
    };

    const fake = createTwoPoolFakePg(initialDb);
    const storeA = createPostgresStore(":memory:", fake.poolA);
    const storeB = createPostgresStore(":memory:", fake.poolB);

    await withTwoServers(storeA, storeB, async ({ urlA, urlB, post }) => {
      // Step 1: Login to get challenge
      const loginRes = await post(urlA, "/auth/login", { email, password });
      assert.equal(loginRes.status, 200);
      const challengeId = loginRes.body.data.challenge_id;

      // Step 2: Concurrently verify with the single recovery code across both pools
      const [resA, resB] = await Promise.all([
        post(urlA, "/auth/totp/verify", { email, challenge_id: challengeId, recovery_code: recoveryCode }),
        post(urlB, "/auth/totp/verify", { email, challenge_id: challengeId, recovery_code: recoveryCode })
      ]);

      assert.deepEqual([resA.status, resB.status].sort(), [200, 401]);
      const successes = [resA, resB].filter((r) => r.status === 200);
      assert.equal(successes.length, 1);
      assert.ok(successes[0].body.data.token);

      // Verify recovery hash is consumed in committed DB
      const committed = fake.data();
      const updatedUser = committed.users.find((u) => u.id === "finance-rec-pg-user");
      assert.equal(updatedUser.totp.recovery_hashes.length, 0);
      assert.equal(JSON.stringify(committed).includes(recoveryCode), false);
    });
  } finally {
    for (const [key, value] of Object.entries({
      ORAC_TOTP_PROTECTED_ROLES: previous.roles,
      ORAC_TOTP_ENCRYPTION_KEY: previous.key
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("postgres two-pool: concurrent Admin factor reset approvals across two pools serialise and reject duplicate approval with 404", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  try {
    const adminA = {
      id: "admin-pg-a",
      email: "adminA-pg@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-a", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vA", last_counter: 1 }
    };
    const adminB = {
      id: "admin-pg-b",
      email: "adminB-pg@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-b", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vB", last_counter: 1 }
    };
    const adminTarget = {
      id: "admin-pg-target",
      email: "adminTarget-pg@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-target", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vTarget", last_counter: 1, recovery_hashes: [] },
      session_epoch: 1
    };

    const initialDb = {
      users: [adminA, adminB, adminTarget],
      audit_logs: []
    };

    const fake = createTwoPoolFakePg(initialDb);
    const storeA = createPostgresStore(":memory:", fake.poolA);
    const storeB = createPostgresStore(":memory:", fake.poolB);

    await withTwoServers(storeA, storeB, async ({ urlA, urlB, post }) => {
      const tokenA = generateToken(adminA, { factorVerified: true });
      const tokenB = generateToken(adminB, { factorVerified: true });

      // Step 1: Admin A initiates factor reset request via urlA
      const reqRes = await post(urlA, "/auth/totp/factor/reset/request", { user_id: adminTarget.id }, tokenA);
      assert.equal(reqRes.status, 200);
      const requestId = reqRes.body.data.request_id;
      assert.ok(requestId);

      // Verify request is committed in fake DB
      const postReqDb = fake.data();
      const targetInDb = postReqDb.users.find((u) => u.id === adminTarget.id);
      assert.ok(targetInDb.totp_factor_reset_request);

      // Step 2: Admin B attempts concurrent approval across urlA (poolA) and urlB (poolB)
      const [approveA, approveB] = await Promise.all([
        post(urlA, "/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB),
        post(urlB, "/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB)
      ]);

      const statuses = [approveA.status, approveB.status].sort();
      assert.deepEqual(statuses, [200, 404], "one approval succeeds with 200, concurrent duplicate fails with 404");

      const committed = fake.data();
      const finalTarget = committed.users.find((u) => u.id === adminTarget.id);
      assert.equal(finalTarget.totp, null, "factor is wiped");
      assert.equal(finalTarget.totp_factor_reset_request, null, "pending request is wiped");
      assert.equal(finalTarget.session_epoch, 2, "session epoch bumped exactly once");

      // Verify audit logs
      const approvedAudits = committed.audit_logs.filter((log) => log.action === "TOTP_FACTOR_RESET_APPROVED");
      assert.equal(approvedAudits.length, 1, "exactly one approval audit recorded");
      assert.equal(approvedAudits[0].actor_id, adminB.id);
    });
  } finally {
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

test("postgres two-pool: simulated database update failure during TOTP verify rolls back, releases lock, and leaves state valid for retry", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  try {
    const email = "finance-pg-fail@fixture.invalid";
    const password = "fixture-pg-fail-pass";
    const secret = generateTotpSecret();
    const initialDb = {
      users: [{
        id: "finance-pg-fail-user",
        email,
        role: "Finance",
        is_active: true,
        password_hash: bcrypt.hashSync(password, 4),
        totp: {
          secret: encryptTotpSecret(secret),
          last_counter: -1,
          recovery_hashes: [],
          version: "v-pg-fail"
        }
      }],
      audit_logs: []
    };

    const fake = createTwoPoolFakePg(initialDb);
    const storeA = createPostgresStore(":memory:", fake.poolA);
    const storeB = createPostgresStore(":memory:", fake.poolB);

    await withTwoServers(storeA, storeB, async ({ urlA, urlB, post }) => {
      // Step 1: Login to get challenge
      const loginRes = await post(urlA, "/auth/login", { email, password });
      assert.equal(loginRes.status, 200);
      const challengeId = loginRes.body.data.challenge_id;
      const code = totpAt(secret, Math.floor(Date.now() / 30_000));

      // Step 2: Inject failure on update
      fake.state.failUpdate = true;
      const failedRes = await post(urlA, "/auth/totp/verify", { email, challenge_id: challengeId, code });
      assert.equal(failedRes.status, 500, "database update failure returns 500");
      assert.ok(fake.state.rollbacks >= 1, "transaction is rolled back");

      // Verify state was not modified in committed DB
      const postFailDb = fake.data();
      const userAfterFail = postFailDb.users.find((u) => u.id === "finance-pg-fail-user");
      assert.equal(userAfterFail.totp.last_counter, -1, "last_counter remains unchanged after rollback");

      // Step 3: Remove failure injection and retry via urlB (the other pool)
      fake.state.failUpdate = false;
      const retryRes = await post(urlB, "/auth/totp/verify", { email, challenge_id: challengeId, code });
      assert.equal(retryRes.status, 200, "retry after rollback succeeds");
      assert.ok(retryRes.body.data.token, "JWT issued after successful retry");

      const finalDb = fake.data();
      const finalUser = finalDb.users.find((u) => u.id === "finance-pg-fail-user");
      assert.ok(finalUser.totp.last_counter >= 0);
    });
  } finally {
    for (const [key, value] of Object.entries({
      ORAC_TOTP_PROTECTED_ROLES: previous.roles,
      ORAC_TOTP_ENCRYPTION_KEY: previous.key
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("postgres two-pool: simulated database update failure during factor reset approval rolls back, releases lock, and preserves request for retry", async () => {
  const previous = {
    roles: process.env.ORAC_TOTP_PROTECTED_ROLES,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED,
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY
  };
  process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

  try {
    const adminA = {
      id: "admin-fail-a",
      email: "adminA-fail@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-a", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vA", last_counter: 1 }
    };
    const adminB = {
      id: "admin-fail-b",
      email: "adminB-fail@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-b", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vB", last_counter: 1 }
    };
    const adminTarget = {
      id: "admin-fail-target",
      email: "adminTarget-fail@fixture.invalid",
      role: "Admin",
      is_active: true,
      password_hash: bcrypt.hashSync("pass-target", 4),
      totp: { secret: encryptTotpSecret(generateTotpSecret()), version: "vTarget", last_counter: 1, recovery_hashes: [] },
      session_epoch: 1
    };

    const initialDb = {
      users: [adminA, adminB, adminTarget],
      audit_logs: []
    };

    const fake = createTwoPoolFakePg(initialDb);
    const storeA = createPostgresStore(":memory:", fake.poolA);
    const storeB = createPostgresStore(":memory:", fake.poolB);

    await withTwoServers(storeA, storeB, async ({ urlA, urlB, post }) => {
      const tokenA = generateToken(adminA, { factorVerified: true });
      const tokenB = generateToken(adminB, { factorVerified: true });

      // Step 1: Admin A creates reset request
      const reqRes = await post(urlA, "/auth/totp/factor/reset/request", { user_id: adminTarget.id }, tokenA);
      assert.equal(reqRes.status, 200);
      const requestId = reqRes.body.data.request_id;
      assert.ok(requestId);

      // Step 2: Inject failure during approval
      fake.state.failUpdate = true;
      const failApprove = await post(urlA, "/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB);
      assert.equal(failApprove.status, 500, "database update failure returns 500");
      assert.ok(fake.state.rollbacks >= 1, "rolled back");

      // Verify request is preserved and target factor is NOT wiped
      const postFailDb = fake.data();
      const targetAfterFail = postFailDb.users.find((u) => u.id === adminTarget.id);
      assert.ok(targetAfterFail.totp, "factor still intact");
      assert.ok(targetAfterFail.totp_factor_reset_request, "pending request still intact");
      assert.equal(targetAfterFail.session_epoch, 1, "session epoch not incremented");

      // Step 3: Remove failure and retry approval via urlB (poolB)
      fake.state.failUpdate = false;
      const retryApprove = await post(urlB, "/auth/totp/factor/reset/approve", { user_id: adminTarget.id, request_id: requestId }, tokenB);
      assert.equal(retryApprove.status, 200, "retry after rollback succeeds");

      const finalDb = fake.data();
      const finalTarget = finalDb.users.find((u) => u.id === adminTarget.id);
      assert.equal(finalTarget.totp, null);
      assert.equal(finalTarget.totp_factor_reset_request, null);
      assert.equal(finalTarget.session_epoch, 2);
    });
  } finally {
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
