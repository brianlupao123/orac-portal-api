import assert from "node:assert/strict";
import test from "node:test";
import { approveAccessRequest, rejectAccessRequest, issueAccessRequestSetupLink, createAccessRequest } from "../src/controllers/accessRequestsController.js";
import { resetPassword } from "../src/controllers/authController.js";
import { handleAuditForNotifications } from "../src/notifications.js";
import { issueSetupToken, verifySetupToken } from "../src/setupTokens.js";

function fixture() {
  const audits = [];
  const db = {
    users: [
      { id: "u_admin", email: "admin@x.test", role: "Admin", is_active: true },
      { id: "u_sales", email: "sales@x.test", role: "Sales", is_active: true },
      { id: "u_mgmt", email: "mgmt@x.test", role: "Management", is_active: true }
    ],
    clients: [{ id: "c1", name: "Client One" }, { id: "c_off", name: "Off", is_active: false }],
    access_requests: [{ id: "areq1", name: "Pat New", email: "pat@x.test", requested_role: "Technician", status: "Pending", created_at: new Date().toISOString() }],
    audit_logs: [], notifications: []
  };
  let counter = 0;
  const store = {
    id: (p) => `${p}_${++counter}`,
    audit(d, actor, type, id, action, o, n) {
      const entry = { id: `a${++counter}`, actor_id: actor?.id || "system", entity_type: type, entity_id: id, action, old_values: o, new_values: n, created_at: new Date().toISOString() };
      d.audit_logs.push(entry); audits.push(entry); handleAuditForNotifications(d, entry);
    }
  };
  return { db, store, audits };
}
const res = () => ({ statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } });
const call = (fn, f, userId, params, body) => { const r = res(); let thrown = null; try { fn({ db: f.db, store: f.store, user: { id: userId }, params, body }, r); } catch (e) { thrown = e; } return { r, thrown }; };

test("only an Admin can approve, reject or issue a setup link; everyone else gets 403 and nothing changes", () => {
  for (const userId of ["u_sales", "u_mgmt"]) {
    const f = fixture();
    for (const fn of [approveAccessRequest, rejectAccessRequest, issueAccessRequestSetupLink]) {
      const { thrown } = call(fn, f, userId, { id: "areq1" }, { role: "Technician" });
      assert.equal(thrown?.status, 403, `${userId} ${fn.name}`);
    }
    assert.equal(f.db.access_requests[0].status, "Pending");
    assert.equal(f.db.users.length, 3);
    assert.equal(f.audits.length, 0);
  }
});

test("approve rejects a non-role value (the shape the old UI sent) and creates nothing", () => {
  for (const role of [{ role: "Technician", client_id: undefined }, "Superuser", 7, ["Admin"]]) {
    const f = fixture();
    const { r } = call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role });
    assert.equal(r.statusCode, 400, JSON.stringify(role));
    assert.equal(f.db.users.length, 3);
    assert.equal(f.db.access_requests[0].status, "Pending");
  }
});

test("Client Viewer approval still requires a real, active client; other roles never keep a client_id", () => {
  let f = fixture();
  assert.equal(call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Client Viewer" }).r.statusCode, 400);
  assert.equal(call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Client Viewer", client_id: "nope" }).r.statusCode, 400);
  assert.equal(call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Client Viewer", client_id: "c_off" }).r.statusCode, 400);
  assert.equal(f.db.users.length, 3);
  const ok = call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Client Viewer", client_id: "c1" });
  assert.equal(ok.r.statusCode, 200);
  assert.equal(f.db.users.at(-1).client_id, "c1");
  f = fixture();
  call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician", client_id: "c1" });
  assert.equal(f.db.users.at(-1).client_id, null);
});

test("the Admin's chosen role wins over the requested role, and an existing email cannot be approved twice", () => {
  const f = fixture();
  const { r } = call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Supervisor" });
  assert.equal(r.statusCode, 200);
  assert.equal(f.db.users.at(-1).role, "Supervisor");
  assert.equal(f.db.access_requests[0].approved_role, "Supervisor");
  const again = call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Supervisor" });
  assert.equal(again.r.statusCode, 400);
  const g = fixture();
  g.db.users.push({ id: "u_dup", email: "PAT@x.test", role: "Sales", is_active: true });
  assert.equal(call(approveAccessRequest, g, "u_admin", { id: "areq1" }, { role: "Technician" }).r.statusCode, 409);
});

test("nobody can request Admin", () => {
  const f = fixture();
  const r = res();
  createAccessRequest({ db: f.db, store: f.store, body: { name: "Eve", email: "eve@x.test", requested_role: "Admin", reason: "" } }, r);
  assert.equal(r.statusCode, 400);
});

test("public request input is bounded", () => {
  const f = fixture();
  for (const body of [{ name: "x".repeat(121), email: "a@x.test" }, { name: "n", email: "no-at-sign" }, { name: "n", email: "a@x.test", reason: "r".repeat(1001) }]) {
    const r = res();
    createAccessRequest({ db: f.db, store: f.store, body: { requested_role: "Sales", ...body } }, r);
    assert.equal(r.statusCode, 400);
  }
  assert.equal(f.db.access_requests.length, 1);
});

test("approval creates an account with no password and no token, and returns no secret", () => {
  const f = fixture();
  const { r } = call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician" });
  const created = f.db.users.at(-1);
  assert.equal(created.password_hash, null);
  assert.equal(created.reset_token, undefined);
  assert.equal(created.reset_token_hash, undefined);
  assert.equal(r.body.data.setup_link_required, true);
  assert.equal(JSON.stringify(r.body).includes("token"), false);
});

test("setup link: returned once with no-store, fragment-based, hashed at rest, absent from audit/notifications/lists/logs", () => {
  const logged = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(originals)) console[k] = (...a) => logged.push(a.join(" "));
  let token, r, f;
  try {
    f = fixture();
    call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician" });
    r = call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r;
  } finally { Object.assign(console, originals); }

  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  const path = r.body.data.setup_path;
  assert.match(path, /^\/reset-password#email=pat%40x\.test&token=[0-9a-f]{64}$/);
  assert.equal(path.includes("?"), false, "token must not be in a query string");
  token = path.split("token=")[1];

  const user = f.db.users.at(-1);
  assert.equal(user.reset_token, undefined);
  assert.notEqual(user.reset_token_hash, token);
  const persisted = JSON.stringify({ users: f.db.users, requests: f.db.access_requests, audit: f.db.audit_logs, notifications: f.db.notifications });
  assert.equal(persisted.includes(token), false, "raw token must not exist anywhere in stored state");
  assert.equal(logged.join("\n").includes(token), false, "raw token must not be logged");
  const issued = f.audits.find((a) => a.action === "ACCESS_REQUEST_SETUP_LINK_ISSUED");
  assert.ok(issued);
  assert.equal(JSON.stringify(issued).includes(token), false);
  assert.equal(JSON.stringify(f.db.access_requests).includes("token"), false);
});

test("the setup link works once, then never again; a new link retires the old one", () => {
  const f = fixture();
  call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician" });
  const first = call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.body.data.setup_path.split("token=")[1];
  const second = call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.body.data.setup_path.split("token=")[1];
  const attempt = (token, pw = "a-long-enough-password") => { const r = res(); resetPassword({ db: f.db, store: f.store, body: { email: "pat@x.test", token, new_password: pw } }, r); return r; };
  assert.equal(attempt(first).statusCode, 400, "old link is dead");
  assert.equal(attempt("0".repeat(64)).statusCode, 400);
  assert.equal(attempt(second, "short").statusCode, 400, "policy still applies");
  assert.equal(attempt(second).statusCode, 200);
  assert.equal(attempt(second).statusCode, 400, "single use");
  const after = f.db.users.at(-1);
  assert.ok(after.password_hash);
  assert.equal(after.reset_token_hash, null);
  assert.equal(f.db.access_requests[0].setup_link_issue_count, 2);
  // Once a password exists, this flow refuses to mint another link.
  assert.equal(call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.statusCode, 409);
});

test("setup link is refused for pending or rejected requests, unknown ids and inactive accounts", () => {
  let f = fixture();
  assert.equal(call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.statusCode, 409);
  assert.equal(call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq_gone" }).r.statusCode, 404);
  call(rejectAccessRequest, f, "u_admin", { id: "areq1" }, { reason: "no" });
  assert.equal(call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.statusCode, 409);
  f = fixture();
  call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician" });
  f.db.users.at(-1).is_active = false;
  assert.equal(call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.statusCode, 409);
});

test("expired tokens and inactive accounts cannot complete a reset", () => {
  const user = { id: "u", email: "e@x.test", is_active: true };
  const { token } = issueSetupToken(user, 1_000);
  assert.equal(verifySetupToken(user, token, 1_000 + 29 * 60 * 1000), true);
  assert.equal(verifySetupToken(user, token, 1_000 + 31 * 60 * 1000), false);
  const f = fixture();
  call(approveAccessRequest, f, "u_admin", { id: "areq1" }, { role: "Technician" });
  const t = call(issueAccessRequestSetupLink, f, "u_admin", { id: "areq1" }).r.body.data.setup_path.split("token=")[1];
  f.db.users.at(-1).is_active = false;
  const r = res();
  resetPassword({ db: f.db, store: f.store, body: { email: "pat@x.test", token: t, new_password: "a-long-enough-password" } }, r);
  assert.equal(r.statusCode, 400);
});

test("legacy plaintext reset tokens still verify until they expire (no silent breakage)", () => {
  const user = { reset_token: "legacy-token", reset_token_expires_at: Date.now() + 60_000 };
  assert.equal(verifySetupToken(user, "legacy-token"), true);
  assert.equal(verifySetupToken(user, "legacy-tokeX"), false);
  assert.equal(verifySetupToken({ reset_token: "t", reset_token_expires_at: Date.now() - 1 }, "t"), false);
  assert.equal(verifySetupToken({}, "x"), false);
  assert.equal(verifySetupToken(user, undefined), false);
});

test("creating a request notifies Admin, and the request stays listable without the notification", () => {
  const f = fixture();
  const r = res();
  createAccessRequest({ db: f.db, store: f.store, body: { name: "Kim", email: "kim@x.test", requested_role: "Sales", reason: "" } }, r);
  assert.equal(f.db.notifications.length, 1);
  f.db.notifications.length = 0; // simulate a lost notification
  assert.equal(f.db.access_requests.filter((x) => x.status === "Pending").length, 2);
});
