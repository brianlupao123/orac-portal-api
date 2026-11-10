import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import express from "express";
import { makeReq, makeRes } from "./_http.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import {
  issueTotpEnrollmentTicket, beginTotpEnrollment, confirmTotpEnrollment
} from "../src/controllers/totpController.js";
import { totpAt } from "../src/totp.js";

const PASSWORD = "marker-password-9f31c2";
const KEY = crypto.randomBytes(32).toString("base64");

function withEnv(fn) {
  const names = ["ORAC_TOTP_ENROLLMENT_ENABLED", "ORAC_TOTP_ENCRYPTION_KEY", "ORAC_TOTP_PROTECTED_ROLES", "ORAC_REQUIRE_PASSWORD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  process.env.ORAC_TOTP_ENCRYPTION_KEY = KEY;
  process.env.ORAC_REQUIRE_PASSWORD = "true";
  delete process.env.ORAC_TOTP_PROTECTED_ROLES;
  return Promise.resolve(fn()).finally(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  });
}

function world() {
  const target = { id: "fin-1", email: "fin@fixture.invalid", role: "Finance", is_active: true,
    password_hash: bcrypt.hashSync(PASSWORD, 4), password_changed_by: "fin-1" };
  const issuer = { id: "adm-issuer", email: "issuer@fixture.invalid", role: "Admin", is_active: true };
  const setter = { id: "adm-setter", email: "setter@fixture.invalid", role: "Admin", is_active: true };
  const db = { users: [target, issuer, setter], audit_logs: [] };
  const store = { audit(state, actor, entityType, entityId, action, oldValues, newValues) {
    state.audit_logs.push({ actor_id: actor?.id || "system", entity_type: entityType, entity_id: entityId, action, old_values: oldValues, new_values: newValues });
  } };
  const call = (handler, body, user) => {
    const req = makeReq({ body, db, store, user });
    const res = makeRes();
    return Promise.resolve(handler(req, res)).then(() => ({ req, res }));
  };
  return { target, issuer, setter, db, store, call };
}
const rows = (w, action) => w.db.audit_logs.filter((row) => row.action === action);
const lastRow = (w) => w.db.audit_logs.at(-1);

async function issueTicket(w, actor = w.issuer) {
  const out = await w.call(issueTotpEnrollmentTicket, { user_id: w.target.id }, actor);
  assert.equal(out.res.statusCode, 200);
  return out.res.body.data.ticket;
}
async function startEnrollment(w, ticket, overrides = {}) {
  return w.call(beginTotpEnrollment, { email: w.target.email, password: PASSWORD, ticket, ...overrides });
}

test("refused ticket issuance is audited with a reason code, persisted, and the response is unchanged", () => withEnv(async () => {
  const w = world();
  const cases = [
    ["permission", () => w.call(issueTotpEnrollmentTicket, { user_id: w.target.id }, w.target), null],
    ["target_not_found", () => w.call(issueTotpEnrollmentTicket, { user_id: "no-such-user" }, w.issuer), 404],
    ["self_issue", () => w.call(issueTotpEnrollmentTicket, { user_id: w.issuer.id }, w.issuer), 403]
  ];
  w.issuer.password_hash = bcrypt.hashSync("another-long-password", 4);
  for (const [reason, act, status] of cases) {
    w.db.audit_logs.length = 0;
    let thrown = null, out = null;
    try { out = await act(); } catch (error) { thrown = error; }
    if (reason === "permission") assert.equal(thrown?.status, 403);
    else assert.equal(out.res.statusCode, status);
    assert.equal(rows(w, "TOTP_ENROLLMENT_TICKET_DENIED").length, 1, reason);
    assert.equal(lastRow(w).new_values.reason, reason);
  }
  // Provenance refusals
  const provenance = [
    ["password_provenance_unrecorded", (t) => { delete t.password_changed_by; }],
    ["issuer_set_password", (t) => { t.password_changed_by = w.issuer.id; }],
    ["issuer_issued_setup_link", (t) => { t.password_changed_by = t.id; t.setup_link_issued_by = w.issuer.id; }],
    ["already_enrolled", (t) => { t.password_changed_by = t.id; delete t.setup_link_issued_by; t.totp = { secret: "x" }; }]
  ];
  for (const [reason, mutate] of provenance) {
    w.db.audit_logs.length = 0;
    mutate(w.target);
    const out = await w.call(issueTotpEnrollmentTicket, { user_id: w.target.id }, w.issuer);
    assert.equal(out.res.statusCode, 409, reason);
    assert.equal(out.req.persistOnFailure, true, `${reason} must persist`);
    assert.equal(rows(w, "TOTP_ENROLLMENT_TICKET_DENIED").length, 1);
    assert.equal(lastRow(w).new_values.reason, reason);
    assert.equal(lastRow(w).entity_id, w.target.id);
    assert.equal(lastRow(w).actor_id, w.issuer.id);
  }
}));

test("an unknown target is logged as 'unknown' and the submitted user_id is never recorded", () => withEnv(async () => {
  const w = world();
  const probe = "probe-user-id-7c1e";
  const out = await w.call(issueTotpEnrollmentTicket, { user_id: probe }, w.issuer);
  assert.equal(out.res.statusCode, 404);
  assert.equal(lastRow(w).entity_id, "unknown");
  assert.equal(JSON.stringify(w.db.audit_logs).includes(probe), false);
}));

test("refused enrollment start: identical 401 for every reason, audited per reason only for a known account", () => withEnv(async () => {
  const w = world();
  const ticket = await issueTicket(w);
  const wrongTicket = crypto.randomBytes(32).toString("base64url");
  const attempts = [
    ["bad_password", { password: "wrong-password-value" }],
    ["bad_ticket", { ticket: wrongTicket }],
    ["malformed_request", { ticket: "short" }]
  ];
  const bodies = new Set();
  for (const [reason, overrides] of attempts) {
    w.db.audit_logs.length = 0;
    const out = await startEnrollment(w, ticket, overrides);
    assert.equal(out.res.statusCode, 401, reason);
    bodies.add(JSON.stringify(out.res.body));
    assert.equal(out.req.persistOnFailure, true);
    assert.equal(rows(w, "TOTP_ENROLLMENT_START_DENIED").length, 1);
    assert.equal(lastRow(w).new_values.reason, reason);
    assert.equal(lastRow(w).entity_id, w.target.id);
    assert.equal(lastRow(w).actor_id, "anonymous");
  }
  // expired and stale tickets
  w.target.totp_enrollment_ticket.expires_at = Date.now() - 1;
  w.db.audit_logs.length = 0;
  let out = await startEnrollment(w, ticket);
  bodies.add(JSON.stringify(out.res.body));
  assert.equal(lastRow(w).new_values.reason, "ticket_expired");
  const fresh = await issueTicket(w);
  w.target.password_hash = bcrypt.hashSync("changed-after-issue-password", 4);
  w.db.audit_logs.length = 0;
  out = await w.call(beginTotpEnrollment, { email: w.target.email, password: "changed-after-issue-password", ticket: fresh });
  bodies.add(JSON.stringify(out.res.body));
  assert.equal(out.res.statusCode, 401);
  assert.equal(lastRow(w).new_values.reason, "ticket_stale");
  assert.equal(bodies.size, 1, "the caller must not learn which check failed");
  // unknown account: same response, no row, nothing persisted
  w.db.audit_logs.length = 0;
  out = await w.call(beginTotpEnrollment, { email: "nobody@fixture.invalid", password: PASSWORD, ticket });
  assert.equal(out.res.statusCode, 401);
  assert.equal(bodies.has(JSON.stringify(out.res.body)), true);
  assert.equal(w.db.audit_logs.length, 0);
  assert.notEqual(out.req.persistOnFailure, true);
}));

test("refused enrollment confirm is audited with a reason; a wrong code keeps its attempt count and a reason", () => withEnv(async () => {
  const w = world();
  const ticket = await issueTicket(w);
  const started = await startEnrollment(w, ticket);
  assert.equal(started.res.statusCode, 200);
  const { enrollment_id: enrollmentId, otpauth_uri: uri } = started.res.body.data;
  const secret = new URL(uri).searchParams.get("secret");
  const goodCode = totpAt(secret, Math.floor(Date.now() / 30_000));
  const confirm = (body) => w.call(confirmTotpEnrollment, { email: w.target.email, ...body });

  w.db.audit_logs.length = 0;
  let out = await confirm({ enrollment_id: crypto.randomBytes(32).toString("base64url"), code: goodCode });
  assert.equal(out.res.statusCode, 400);
  assert.equal(lastRow(w).action, "TOTP_ENROLLMENT_CONFIRM_DENIED");
  assert.equal(lastRow(w).new_values.reason, "bad_enrollment_id");
  assert.equal(out.req.persistOnFailure, true);

  out = await confirm({ enrollment_id: "short", code: goodCode });
  assert.equal(lastRow(w).new_values.reason, "malformed_request");

  w.db.audit_logs.length = 0;
  out = await confirm({ enrollment_id: enrollmentId, code: "000000" === goodCode ? "111111" : "000000" });
  assert.equal(out.res.statusCode, 400);
  assert.equal(lastRow(w).action, "TOTP_ENROLLMENT_CONFIRM_FAILED");
  assert.equal(lastRow(w).new_values.reason, "bad_code");
  assert.equal(w.target.totp.pending.attempts, 1);

  w.target.totp.pending.expires_at = Date.now() - 1;
  w.db.audit_logs.length = 0;
  out = await confirm({ enrollment_id: enrollmentId, code: goodCode });
  assert.equal(lastRow(w).new_values.reason, "expired");

  w.target.totp.pending.expires_at = Date.now() + 60_000;
  w.target.totp.pending.attempts = 5;
  out = await confirm({ enrollment_id: enrollmentId, code: goodCode });
  assert.equal(lastRow(w).new_values.reason, "attempts_exhausted");

  w.db.audit_logs.length = 0;
  const unknown = await w.call(confirmTotpEnrollment, { email: "nobody@fixture.invalid", enrollment_id: enrollmentId, code: goodCode });
  assert.equal(unknown.res.statusCode, 400);
  assert.equal(w.db.audit_logs.length, 0);
}));

test("denial rows never contain secrets, the submitted email, or submitted identifiers", () => withEnv(async () => {
  const w = world();
  const ticket = await issueTicket(w);
  const typedEmail = "TypedEmail@Fixture.Invalid";
  await w.call(beginTotpEnrollment, { email: typedEmail, password: PASSWORD, ticket });
  await startEnrollment(w, ticket, { password: "typed-wrong-password-55" });
  const wrongId = crypto.randomBytes(32).toString("base64url");
  const started = await startEnrollment(w, ticket);
  const secret = new URL(started.res.body.data.otpauth_uri).searchParams.get("secret");
  await w.call(confirmTotpEnrollment, { email: w.target.email, enrollment_id: wrongId, code: "123456" });
  await w.call(issueTotpEnrollmentTicket, { user_id: "probe-id-0099" }, w.issuer);
  const dump = JSON.stringify(w.db.audit_logs);
  for (const secretValue of [ticket, PASSWORD, "typed-wrong-password-55", wrongId, secret, "123456", "probe-id-0099",
    typedEmail, typedEmail.toLowerCase(), w.target.email, started.res.body.data.enrollment_id]) {
    assert.equal(dump.includes(secretValue), false, `audit leaked ${secretValue.slice(0, 6)}`);
  }
}));

test("the happy path still works and writes no denial rows", () => withEnv(async () => {
  const w = world();
  const ticket = await issueTicket(w);
  const started = await startEnrollment(w, ticket);
  assert.equal(started.res.statusCode, 200);
  const secret = new URL(started.res.body.data.otpauth_uri).searchParams.get("secret");
  const done = await w.call(confirmTotpEnrollment, { email: w.target.email, enrollment_id: started.res.body.data.enrollment_id,
    code: totpAt(secret, Math.floor(Date.now() / 30_000)) });
  assert.equal(done.res.statusCode, 200);
  assert.equal(done.res.body.data.recovery_codes.length, 10);
  assert.equal(w.db.audit_logs.some((row) => /DENIED/.test(row.action)), false);
}));

// Through the REAL persistenceMiddleware: a refused attempt must reach storage, an unknown account must not.
test("denials are saved by persistenceMiddleware; unknown accounts cause no write", () => withEnv(async () => {
  const w = world();
  const ticket = await issueTicket(w);
  let state = structuredClone(w.db);
  let writes = 0;
  const store = {
    audit: w.store.audit,
    read: async () => ({ db: structuredClone(state), release: {} }),
    write: async (db) => { writes += 1; state = structuredClone(db); },
    release: async () => {}
  };
  const app = express();
  app.use(express.json());
  app.use("/api", persistenceMiddleware(store));
  app.post("/api/auth/totp/enrollment/start", beginTotpEnrollment);
  const server = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (body) => {
      const response = await fetch(`${base}/auth/totp/enrollment/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    };
    assert.equal(await post({ email: w.target.email, password: "wrong-password-value", ticket }), 401);
    assert.equal(writes, 1);
    assert.equal(state.audit_logs.filter((row) => row.action === "TOTP_ENROLLMENT_START_DENIED").length, 1);
    assert.equal(await post({ email: "nobody@fixture.invalid", password: PASSWORD, ticket }), 401);
    assert.equal(writes, 1, "an unknown account must not cause a write");
    assert.equal(JSON.stringify(state.audit_logs).includes(ticket), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}));

// The permission refusal is thrown, so it reaches storage only through the global error handler (server.js).
test("a non-Admin ticket attempt thrown as 403 is still saved through persistenceMiddleware and the error handler", () => withEnv(async () => {
  const w = world();
  let state = structuredClone(w.db);
  const store = {
    audit: w.store.audit,
    read: async () => ({ db: structuredClone(state), release: {} }),
    write: async (db) => { state = structuredClone(db); },
    release: async () => {}
  };
  const app = express();
  app.use(express.json());
  app.use("/api", persistenceMiddleware(store));
  app.post("/api/auth/totp/enrollment/tickets", (req, res, next) => {
    req.user = { id: "fin-1" };
    try { issueTotpEnrollmentTicket(req, res); } catch (error) { next(error); }
  });
  // Same shape as the handler in server.js.
  app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = await new Promise((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/totp/enrollment/tickets`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: "fin-1" })
    });
    assert.equal(response.status, 403);
    const row = state.audit_logs.find((entry) => entry.action === "TOTP_ENROLLMENT_TICKET_DENIED");
    assert.equal(row?.new_values.reason, "permission");
    assert.equal(row?.actor_id, "fin-1");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}));
