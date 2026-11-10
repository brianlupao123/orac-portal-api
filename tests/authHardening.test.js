import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { loginDemoUser, getMe, requestPasswordReset, resetPassword } from "../src/controllers/authController.js";
import { authMiddleware, generateToken } from "../src/middleware/auth.js";
import { updateUser } from "../src/controllers/adminController.js";
import { deactivateEntity, reactivateEntity } from "../src/controllers/coreController.js";
import { config } from "../src/config.js";
import { issueResetToken } from "../src/accountTokens.js";
import { makeReq, makeRes } from "./_http.js";

const audits = [];
function world() {
  audits.length = 0;
  const db = {
    users: [
      { id: "u1", email: "Active@x.co", role: "Admin", is_active: true, password_hash: bcrypt.hashSync("correct-horse-battery", 4), reset_token: "sha256:abc", reset_token_expires_at: 123 },
      { id: "u2", email: "off@x.co", role: "Sales", is_active: false, password_hash: bcrypt.hashSync("whatever-long-pass", 4) },
      { id: "u3", email: "nopass@x.co", role: "Sales", is_active: true }
    ],
    audit_logs: []
  };
  const store = { id: (p) => `${p}_1`, audit: (_db, actor, ...rest) => audits.push({ actor, rest }) };
  return { db, store };
}
async function login(body, w = world()) {
  const res = makeRes();
  await loginDemoUser(makeReq({ body, db: w.db, store: w.store }), res);
  return res;
}
function withPasswordRequired(value, fn) {
  const prev = config.requirePassword; config.requirePassword = value;
  return Promise.resolve(fn()).finally(() => { config.requirePassword = prev; });
}

test("login failures are byte-identical for unknown, inactive, no-password-set and wrong-password accounts", () =>
  withPasswordRequired(true, async () => {
    const cases = [
      { email: "ghost@x.co", password: "correct-horse-battery" },
      { email: "off@x.co", password: "whatever-long-pass" },
      { email: "nopass@x.co", password: "anything" },
      { email: "active@x.co", password: "wrong-wrong-wrong" }
    ];
    const results = [];
    for (const c of cases) results.push(await login(c));
    for (const r of results) assert.equal(r.statusCode, 401);
    const first = JSON.stringify(results[0].body);
    assert.equal(first.includes("not found"), false);
    for (const r of results) assert.equal(JSON.stringify(r.body), first);
  }));

test("login success returns token and a user with no password_hash / reset_token fields; email matched case-insensitively", () =>
  withPasswordRequired(true, async () => {
    const r = await login({ email: " ACTIVE@x.co ", password: "correct-horse-battery" });
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.data.token);
    const u = r.body.data.user;
    for (const k of ["password_hash", "password", "reset_token", "reset_token_expires_at"]) assert.equal(k in u, false, k);
    assert.equal(u.id, "u1");
  }));

test("a missing password is refused with 400 before any account lookup when a password is required", () =>
  withPasswordRequired(true, async () => {
    const known = await login({ email: "active@x.co" });
    const unknown = await login({ email: "ghost@x.co" });
    assert.equal(known.statusCode, 400);
    assert.deepEqual(known.body, unknown.body);
  }));

test("blank-password sign-in works only when passwords are NOT required (local development shortcut), never for unknown users", () =>
  withPasswordRequired(false, async () => {
    const ok = await login({ email: "active@x.co" });
    assert.equal(ok.statusCode, 200);
    assert.equal((await login({ email: "ghost@x.co" })).statusCode, 401);
    assert.equal((await login({ email: "off@x.co" })).statusCode, 401, "inactive users never get a blank sign-in");
  }));

test("a wrong password is still refused when passwords are not required", () =>
  withPasswordRequired(false, async () => {
    assert.equal((await login({ email: "active@x.co", password: "nope-nope-nope" })).statusCode, 401);
  }));

test("config.requirePassword follows NODE_ENV=production and ORAC_REQUIRE_PASSWORD", async () => {
  const run = async (env) => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { config } from ${JSON.stringify(new URL("../src/config.js", import.meta.url).href)}; console.log(config.requirePassword)`],
      { env: { PATH: process.env.PATH, JWT_SECRET: "x".repeat(40), ...env }, encoding: "utf8" });
    return r.stdout.trim();
  };
  assert.equal(await run({ NODE_ENV: "production" }), "true");
  assert.equal(await run({ NODE_ENV: "development" }), "false");
  assert.equal(await run({ NODE_ENV: "development", ORAC_REQUIRE_PASSWORD: "true" }), "true");
  assert.equal(await run({}), "false");
});

test("/auth/me returns no secrets", () => {
  const w = world();
  const res = makeRes();
  getMe(makeReq({ db: w.db, user: { id: "u1" } }), res);
  for (const k of ["password_hash", "reset_token", "reset_token_expires_at"]) assert.equal(k in res.body.data, false);
});

test("request-password-reset: identical response for known, unknown and inactive accounts; issues and stores no token; audit carries no token", () => {
  const w = world();
  const out = ["active@x.co", "ghost@x.co", "off@x.co"].map((email) => {
    const res = makeRes();
    const before = w.db.users.map((u) => u.reset_token);
    requestPasswordReset(makeReq({ body: { email }, db: w.db, store: w.store }), res);
    assert.deepEqual(w.db.users.map((u) => u.reset_token), before, "no token may be minted without a delivery path");
    return JSON.stringify(res.body);
  });
  assert.equal(new Set(out).size, 1);
  assert.equal(JSON.stringify(audits.map((a) => a.rest)).match(/token/i)?.length ?? 0, 0, "audit rows must not mention or contain tokens");
});

test("reset-password: valid token sets a new hash, stamps password_changed_at, clears token, and cannot be replayed", () => {
  const w = world();
  const user = w.db.users[0];
  const { token } = issueResetToken(user);
  const req = () => makeReq({ body: { email: "active@x.co", token, new_password: "a-brand-new-passphrase" }, db: w.db, store: w.store });
  const res = makeRes(); resetPassword(req(), res);
  assert.equal(res.statusCode, 200);
  assert.ok(user.password_changed_at);
  assert.equal(user.reset_token, null);
  assert.equal(bcrypt.compareSync("a-brand-new-passphrase", user.password_hash), true);
  const replay = makeRes(); resetPassword(req(), replay);
  assert.equal(replay.statusCode, 400);
  assert.equal(JSON.stringify(audits).includes(token), false);
});

test("reset-password refuses inactive accounts, expired tokens, short and over-long passwords, with the same generic message", () => {
  const w = world();
  const inactive = w.db.users[1]; const { token: t2 } = issueResetToken(inactive);
  const active = w.db.users[0]; const { token: t1 } = issueResetToken(active, Date.now() - 31 * 60 * 1000);
  const go = (email, token, pw) => { const r = makeRes(); resetPassword(makeReq({ body: { email, token, new_password: pw }, db: w.db, store: w.store }), r); return r; };
  const a = go("off@x.co", t2, "a-long-enough-password");
  const b = go("active@x.co", t1, "a-long-enough-password");
  assert.equal(a.statusCode, 400); assert.equal(b.statusCode, 400);
  assert.deepEqual(a.body, b.body);
  const fresh = issueResetToken(active).token;
  assert.equal(go("active@x.co", fresh, "short").statusCode, 400);
  assert.equal(go("active@x.co", fresh, "x".repeat(73)).statusCode, 400);
  assert.equal(active.password_changed_at, undefined, "rejected attempts change nothing");
});

function authed(user, token, db) {
  const req = makeReq({ headers: { authorization: `Bearer ${token}` }, db });
  const res = makeRes(); let passed = false;
  authMiddleware(req, res, () => { passed = true; });
  return { req, res, passed };
}

test("session tokens issued before password_changed_at are rejected; later ones accepted", () => {
  const w = world(); const user = w.db.users[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const old = jwt.sign({ id: user.id, iat: nowSec - 3600 }, config.jwtSecret, { expiresIn: "8h" });
  assert.equal(authed(user, old, w.db).passed, true, "no password change yet");
  user.password_changed_at = new Date((nowSec - 60) * 1000).toISOString();
  const r = authed(user, old, w.db);
  assert.equal(r.passed, false);
  assert.equal(r.res.statusCode, 401);
  const fresh = jwt.sign({ id: user.id, iat: nowSec }, config.jwtSecret, { expiresIn: "8h" });
  assert.equal(authed(user, fresh, w.db).passed, true);
  assert.equal(authed(user, generateToken(user), w.db).passed, true, "a token minted by login after the change works");
});

test("an unparseable password_changed_at does not lock everyone out", () => {
  const w = world(); const user = w.db.users[0]; user.password_changed_at = "garbage";
  assert.equal(authed(user, generateToken(user), w.db).passed, true);
});

test("inactive or deleted accounts are refused; role comes from the database, not the token", () => {
  const w = world();
  const tokenForInactive = generateToken(w.db.users[1]);
  assert.equal(authed(null, tokenForInactive, w.db).res.statusCode, 401);
  const forged = jwt.sign({ id: "u3", role: "Admin" }, config.jwtSecret, { expiresIn: "1h" });
  const r = authed(null, forged, w.db);
  assert.equal(r.passed, true);
  assert.equal(r.req.user.role, "Sales");
});

test("missing, malformed and wrongly-signed bearer tokens are 401", () => {
  const w = world();
  for (const header of [undefined, "Basic abc", "Bearer", "Bearer not.a.jwt", `Bearer ${jwt.sign({ id: "u1" }, "other-secret")}`]) {
    const req = makeReq({ headers: header ? { authorization: header } : {}, db: w.db });
    const res = makeRes(); let passed = false;
    authMiddleware(req, res, () => { passed = true; });
    assert.equal(passed, false, String(header)); assert.equal(res.statusCode, 401);
  }
});

test("auth middleware rejects a differently signed JWT algorithm", () => {
  const w = world();
  const user = w.db.users[0];
  const token = jwt.sign({ id: user.id }, config.jwtSecret, { algorithm: "HS384", expiresIn: "1h" });
  assert.equal(authed(user, token, w.db).res.statusCode, 401);
});

test("admin password change stamps password_changed_at (ends the user's existing sessions); other edits do not", () => {
  const w = world();
  w.db.users[0].role = "Admin";
  const admin = { id: "admin-x", role: "Admin", is_active: true, email: "a@a.co" };
  w.db.users.push(admin);
  const call = (body) => { const res = makeRes(); updateUser(makeReq({ params: { id: "u3" }, body, db: w.db, store: w.store, user: { id: "admin-x" } }), res); return res; };
  const target = w.db.users[2];
  const r1 = call({ name: "Renamed" });
  assert.equal(r1.statusCode, 200);
  assert.equal(target.password_changed_at, undefined);
  const r2 = call({ password: "a-new-long-password" });
  assert.equal(r2.statusCode, 200);
  assert.ok(target.password_changed_at);
});

test("same-second password and role changes revoke earlier sessions", () => {
  const w = world();
  const admin = { id: "admin-x", email: "a@a.co", role: "Admin", is_active: true };
  w.db.users.push(admin);
  const target = w.db.users[2];
  const call = (body) => {
    const res = makeRes();
    updateUser(makeReq({ params: { id: target.id }, body, db: w.db, store: w.store, user: { id: admin.id } }), res);
    assert.equal(res.statusCode, 200);
  };
  const old = generateToken(target);
  call({ password: "a-new-long-password" });
  assert.equal(authed(target, old, w.db).res.statusCode, 401);
  const afterPassword = generateToken(target);
  assert.equal(authed(target, afterPassword, w.db).passed, true);
  call({ role: "Finance" });
  assert.equal(authed(target, afterPassword, w.db).res.statusCode, 401);
  assert.equal(authed(target, generateToken(target), w.db).passed, true);
});

test("deactivation and reactivation cannot revive a token or disclose user secrets", () => {
  const w = world();
  const admin = { id: "admin-x", email: "a@a.co", role: "Admin", is_active: true };
  w.db.users.push(admin);
  const target = w.db.users[2];
  target.password_hash = "private-hash-marker";
  const old = generateToken(target);
  for (const action of [deactivateEntity("users"), reactivateEntity("users")]) {
    const res = makeRes();
    action(makeReq({ params: { id: target.id }, db: w.db, store: w.store, user: { id: admin.id } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.body).includes("private-hash-marker"), false);
  }
  assert.equal(authed(target, old, w.db).res.statusCode, 401);
  assert.equal(authed(target, generateToken(target), w.db).passed, true);
  assert.equal(JSON.stringify(audits).includes("private-hash-marker"), false);
});
