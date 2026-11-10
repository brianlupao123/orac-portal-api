import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { makeReq, makeRes, run } from "./_http.js";
import { loginDemoUser } from "../src/controllers/authController.js";
import { beginTotpEnrollment, confirmTotpEnrollment, issueTotpEnrollmentTicket, verifyTotpLogin } from "../src/controllers/totpController.js";
import { authMiddleware, generateToken } from "../src/middleware/auth.js";
import { toPublicUser } from "../src/accountTokens.js";
import { encodeBase32, totpAt, matchTotp, encryptTotpSecret, decryptTotpSecret } from "../src/totp.js";
import { validateTotpRuntime } from "../src/totpPolicy.js";
import { createUser } from "../src/controllers/adminController.js";

const KEY = crypto.randomBytes(32).toString("base64");

function fixture() {
  const user = { id: "admin-1", email: "admin@fixture.invalid", role: "Admin", is_active: true,
    password_hash: bcrypt.hashSync("long-fixture-password", 4), password_changed_by: "admin-1" };
  const issuer = { id: "admin-issuer", email: "issuer@fixture.invalid", role: "Admin", is_active: true };
  const db = { users: [user, issuer], audit_logs: [] };
  const store = { audit: (state, actor, type, id, action, before, after) => {
    state.audit_logs.push({ actor_id: actor.id, action, before, after });
  } };
  return { user, issuer, db, store, req: (body, auth = true) => makeReq({ body, db, store, user: auth ? user : undefined }) };
}

async function startEnrollment(f, res) {
  const issued = makeRes();
  issueTotpEnrollmentTicket(makeReq({ body: { user_id: f.user.id }, db: f.db, store: f.store, user: f.issuer }), issued);
  assert.equal(issued.statusCode, 200);
  await beginTotpEnrollment(f.req({ email: f.user.email, password: "long-fixture-password", ticket: issued.body.data.ticket }, false), res);
  assert.equal(res.statusCode, 200);
}

function confirmEnrollment(f, enrollment, code, res) {
  confirmTotpEnrollment(f.req({ email: f.user.email, enrollment_id: enrollment.body.data.enrollment_id, code }, false), res);
}

function setEnvironment() {
  const previous = { roles: process.env.ORAC_TOTP_PROTECTED_ROLES, key: process.env.ORAC_TOTP_ENCRYPTION_KEY,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED };
  process.env.ORAC_TOTP_ENCRYPTION_KEY = KEY;
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  return () => {
    if (previous.roles === undefined) delete process.env.ORAC_TOTP_PROTECTED_ROLES;
    else process.env.ORAC_TOTP_PROTECTED_ROLES = previous.roles;
    if (previous.key === undefined) delete process.env.ORAC_TOTP_ENCRYPTION_KEY;
    else process.env.ORAC_TOTP_ENCRYPTION_KEY = previous.key;
    if (previous.enrollment === undefined) delete process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
    else process.env.ORAC_TOTP_ENROLLMENT_ENABLED = previous.enrollment;
  };
}

test("RFC 6238 SHA-1 vector and single-use counter", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890"));
  assert.equal(totpAt(secret, 1, 8), "94287082");
  assert.equal(totpAt(secret, 1), "287082");
  assert.equal(matchTotp(secret, "287082", { now: 59_000 }), 1);
  assert.equal(matchTotp(secret, "287082", { now: 59_000, lastCounter: 1 }), null);
  assert.equal(matchTotp(secret, "not-six-digits", { now: 59_000 }), null);
});

test("enrollment is dark by default", async () => {
  const previous = process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
  delete process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
  try {
    const f = fixture();
    const res = makeRes();
    await beginTotpEnrollment(f.req({ password: "long-fixture-password" }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(f.user.totp, undefined);
  } finally {
    if (previous !== undefined) process.env.ORAC_TOTP_ENROLLMENT_ENABLED = previous;
  }
});

test("enrollment ticket needs an independent Admin and cannot be reused or replaced silently", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const issue = (actor = f.issuer) => {
      const res = makeRes();
      issueTotpEnrollmentTicket(makeReq({ body: { user_id: f.user.id }, db: f.db, store: f.store, user: actor }), res);
      return res;
    };
    assert.equal(issue(f.user).statusCode, 403, "a user cannot issue their own ticket");
    f.user.password_changed_by = f.issuer.id;
    assert.equal(issue().statusCode, 409, "the password-changing Admin cannot issue the ticket");
    delete f.user.password_changed_by;
    assert.equal(issue().statusCode, 409, "legacy accounts with unknown password provenance fail closed");
    f.user.password_changed_by = f.user.id;
    const ticket = issue().body.data.ticket;
    assert.equal(JSON.stringify(f.db).includes(ticket), false, "raw ticket is never stored");
    const wrong = makeRes();
    await beginTotpEnrollment(f.req({ email: f.user.email, password: "long-fixture-password", ticket: "x".repeat(43) }, false), wrong);
    assert.equal(wrong.statusCode, 401);
    assert.equal(f.user.totp, undefined);
    const first = makeRes();
    await beginTotpEnrollment(f.req({ email: f.user.email, password: "long-fixture-password", ticket }, false), first);
    assert.equal(first.statusCode, 200);
    const repeated = makeRes();
    await beginTotpEnrollment(f.req({ email: f.user.email, password: "long-fixture-password", ticket }, false), repeated);
    assert.equal(repeated.statusCode, 409);
    const secret = new URL(first.body.data.otpauth_uri).searchParams.get("secret");
    const wrongEnrollmentId = makeRes();
    confirmTotpEnrollment(f.req({ email: f.user.email, enrollment_id: "x".repeat(43), code: totpAt(secret, Math.floor(Date.now() / 30_000)) }, false), wrongEnrollmentId);
    assert.equal(wrongEnrollmentId.statusCode, 400);
    const confirmed = makeRes();
    confirmEnrollment(f, first, totpAt(secret, Math.floor(Date.now() / 30_000)), confirmed);
    assert.equal(confirmed.statusCode, 200);
    assert.equal(f.user.totp_enrollment_ticket, null);
    const replay = makeRes();
    await beginTotpEnrollment(f.req({ email: f.user.email, password: "long-fixture-password", ticket }, false), replay);
    assert.equal(replay.statusCode, 401);
    assert.equal(JSON.stringify(f.db.audit_logs).includes(ticket), false);
  } finally { restore(); }
});

test("the Admin who created an account with a password cannot issue its TOTP ticket", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    f.store.id = () => "new-finance";
    const created = makeRes();
    createUser(makeReq({ db: f.db, store: f.store, user: f.issuer, body: {
      name: "New Finance", email: "new-finance@fixture.invalid", role: "Finance", password: "new-finance-password"
    } }), created);
    assert.equal(created.statusCode, 200);
    const target = f.db.users.find((user) => user.id === "new-finance");
    assert.equal(target.password_changed_by, f.issuer.id);
    const ticket = (actor) => {
      const res = makeRes();
      issueTotpEnrollmentTicket(makeReq({ db: f.db, store: f.store, user: actor,
        body: { user_id: target.id } }), res);
      return res;
    };
    assert.equal(ticket(f.issuer).statusCode, 409);
    assert.equal(ticket(f.user).statusCode, 200);
  } finally { restore(); }
});

test("a newly protected Finance user can enroll without a bearer using an independent ticket", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    f.user.role = "Finance";
    process.env.ORAC_TOTP_PROTECTED_ROLES = "Finance";
    const blocked = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), blocked);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.body.data?.token, undefined);
    const enrollment = makeRes();
    await startEnrollment(f, enrollment);
    const secret = new URL(enrollment.body.data.otpauth_uri).searchParams.get("secret");
    const confirmed = makeRes();
    confirmEnrollment(f, enrollment, totpAt(secret, Math.floor(Date.now() / 30_000)), confirmed);
    assert.equal(confirmed.statusCode, 200);
    const login = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), login);
    assert.equal(login.body.data.status, "verification_required");
  } finally { restore(); }
});

test("seed encryption authenticates its ciphertext and protected rollout requires key and password", () => {
  const restore = setEnvironment();
  try {
    const secret = encodeBase32(crypto.randomBytes(20));
    const sealed = encryptTotpSecret(secret);
    assert.notEqual(sealed, secret);
    assert.equal(decryptTotpSecret(sealed), secret);
    assert.throws(() => decryptTotpSecret(sealed.slice(0, -2) + "aa"));
    assert.throws(() => validateTotpRuntime({ ORAC_TOTP_PROTECTED_ROLES: "Admin", ORAC_TOTP_ENCRYPTION_KEY: KEY }));
    assert.doesNotThrow(() => validateTotpRuntime({ ORAC_TOTP_PROTECTED_ROLES: "Admin", ORAC_TOTP_ENCRYPTION_KEY: KEY, ORAC_REQUIRE_PASSWORD: "true" }));
    assert.throws(() => validateTotpRuntime({ ORAC_TOTP_ENROLLMENT_ENABLED: "true" }));
  } finally { restore(); }
});

test("protected Admin cannot get JWT from password alone; challenge, TOTP and recovery are one use", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const oldToken = generateToken(f.user);
    const start = makeRes();
    await startEnrollment(f, start);
    const secret = new URL(start.body.data.otpauth_uri).searchParams.get("secret");
    assert.ok(secret);
    assert.equal(JSON.stringify(f.user).includes(secret), false, "unencrypted seed is never persisted");
    const confirm = makeRes();
    confirmEnrollment(f, start, totpAt(secret, Math.floor(Date.now() / 30_000)), confirm);
    assert.equal(confirm.statusCode, 200);
    assert.equal(confirm.body.data.recovery_codes.length, 10);
    assert.equal(JSON.stringify(f.user).includes(confirm.body.data.recovery_codes[0]), false);
    assert.equal("totp" in toPublicUser(f.user), false);
    assert.equal(run(authMiddleware, makeReq({ db: f.db, headers: { authorization: `Bearer ${oldToken}` } })).res.statusCode, 401,
      "factor enrollment revokes the token used to start enrollment");

    process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
    assert.equal(run(authMiddleware, makeReq({ db: f.db, headers: { authorization: `Bearer ${oldToken}` } })).res.statusCode, 401);
    const passwordRes = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), passwordRes);
    assert.equal(passwordRes.body.data.status, "verification_required");
    assert.equal("token" in passwordRes.body.data, false);
    const challengeId = passwordRes.body.data.challenge_id;
    const verifyReq = f.req({ email: f.user.email, challenge_id: challengeId, code: totpAt(secret, Math.floor(Date.now() / 30_000) + 1) }, false);
    const verifyRes = makeRes();
    verifyTotpLogin(verifyReq, verifyRes);
    assert.equal(verifyRes.statusCode, 200);
    assert.ok(verifyRes.body.data.token);
    assert.equal(run(authMiddleware, makeReq({ db: f.db, headers: { authorization: `Bearer ${verifyRes.body.data.token}` } })).passed, true);
    const replay = makeRes();
    verifyTotpLogin(verifyReq, replay);
    assert.equal(replay.statusCode, 401);

    const recovery = confirm.body.data.recovery_codes[0];
    const secondPassword = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), secondPassword);
    const recoveryReq = f.req({ email: f.user.email, challenge_id: secondPassword.body.data.challenge_id, recovery_code: recovery }, false);
    const recoveryRes = makeRes();
    verifyTotpLogin(recoveryReq, recoveryRes);
    assert.equal(recoveryRes.statusCode, 200);
    assert.equal(run(authMiddleware, makeReq({ db: f.db, headers: { authorization: `Bearer ${verifyRes.body.data.token}` } })).res.statusCode, 401);
    assert.equal(f.user.totp.recovery_hashes.length, 9);
    assert.equal(JSON.stringify(f.db.audit_logs).includes(recovery), false);
  } finally { restore(); }
});

test("invalid TOTP attempts are bounded and require persistence on 401", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const enrollment = makeRes();
    await startEnrollment(f, enrollment);
    const secret = new URL(enrollment.body.data.otpauth_uri).searchParams.get("secret");
    confirmEnrollment(f, enrollment, totpAt(secret, Math.floor(Date.now() / 30_000)), makeRes());
    process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
    const login = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), login);
    const challenge_id = login.body.data.challenge_id;
    for (let i = 0; i < 5; i++) {
      const req = f.req({ email: f.user.email, challenge_id, code: "abcdef" }, false);
      const res = makeRes();
      verifyTotpLogin(req, res);
      assert.equal(res.statusCode, 401);
      assert.equal(req.persistOnFailure, true);
    }
    assert.equal(f.user.totp.challenge, null);
    assert.equal(f.db.audit_logs.filter((entry) => entry.action === "TOTP_VERIFY_FAILED").length, 5);
    assert.equal(JSON.stringify(f.db.audit_logs).includes("abcdef"), false);
  } finally { restore(); }
});

test("new password challenges cannot reset the account-wide factor failure budget", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const enrollment = makeRes();
    await startEnrollment(f, enrollment);
    const secret = new URL(enrollment.body.data.otpauth_uri).searchParams.get("secret");
    confirmEnrollment(f, enrollment, totpAt(secret, Math.floor(Date.now() / 30_000)), makeRes());
    process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin";
    for (let attempt = 0; attempt < 10; attempt++) {
      const login = makeRes();
      await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), login);
      assert.equal(login.statusCode, 200);
      const bad = makeRes();
      verifyTotpLogin(f.req({ email: f.user.email, challenge_id: login.body.data.challenge_id, code: "abcdef" }, false), bad);
      assert.equal(bad.statusCode, 401);
    }
    assert.equal(f.user.totp.failures, 10);
    assert.ok(f.user.totp.locked_until > Date.now());
    assert.equal(f.db.audit_logs.filter((entry) => entry.action === "TOTP_FACTOR_LOCKED").length, 1);
    const blocked = makeRes();
    await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), blocked);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.body.data?.token, undefined);
  } finally { restore(); }
});

test("changing an existing session's database role into a protected role requires TOTP", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    f.user.role = "Sales";
    const oldToken = generateToken(f.user);
    f.user.role = "Finance";
    process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin,Management,Finance";
    const result = run(authMiddleware, makeReq({ db: f.db, headers: { authorization: `Bearer ${oldToken}` } }));
    assert.equal(result.passed, false);
    assert.equal(result.res.statusCode, 401);
  } finally { restore(); }
});

test("password or role changes invalidate a pending TOTP challenge", async () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const enrollment = makeRes();
    await startEnrollment(f, enrollment);
    const secret = new URL(enrollment.body.data.otpauth_uri).searchParams.get("secret");
    confirmEnrollment(f, enrollment, totpAt(secret, Math.floor(Date.now() / 30_000)), makeRes());
    process.env.ORAC_TOTP_PROTECTED_ROLES = "Admin,Management,Finance";
    const login = async () => {
      const res = makeRes();
      await loginDemoUser(f.req({ email: f.user.email, password: "long-fixture-password" }, false), res);
      return res.body.data.challenge_id;
    };
    const check = (challenge_id) => {
      const res = makeRes();
      verifyTotpLogin(f.req({ email: f.user.email, challenge_id,
        code: totpAt(secret, Math.floor(Date.now() / 30_000) + 1) }, false), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.data?.token, undefined);
    };
    const beforePassword = await login();
    f.user.password_changed_at = new Date().toISOString();
    check(beforePassword);
    const beforeHash = await login();
    const priorHash = f.user.password_hash;
    f.user.password_hash = bcrypt.hashSync("another-fixture-password", 4);
    check(beforeHash);
    f.user.password_hash = priorHash;
    const beforeEmail = await login();
    f.user.email = "new-admin@fixture.invalid";
    check(beforeEmail);
    f.user.email = "admin@fixture.invalid";
    const beforeRole = await login();
    f.user.role = "Finance";
    check(beforeRole);
  } finally { restore(); }
});
