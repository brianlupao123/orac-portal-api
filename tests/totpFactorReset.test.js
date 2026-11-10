import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { makeReq, makeRes } from "./_http.js";
import { resetTotpFactor, requestTotpFactorReset, approveTotpFactorReset } from "../src/controllers/totpController.js";

const KEY = crypto.randomBytes(32).toString("base64");

function setEnvironment() {
  const previous = {
    key: process.env.ORAC_TOTP_ENCRYPTION_KEY,
    enrollment: process.env.ORAC_TOTP_ENROLLMENT_ENABLED
  };
  process.env.ORAC_TOTP_ENCRYPTION_KEY = KEY;
  process.env.ORAC_TOTP_ENROLLMENT_ENABLED = "true";
  return () => {
    if (previous.key === undefined) delete process.env.ORAC_TOTP_ENCRYPTION_KEY;
    else process.env.ORAC_TOTP_ENCRYPTION_KEY = previous.key;
    if (previous.enrollment === undefined) delete process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
    else process.env.ORAC_TOTP_ENROLLMENT_ENABLED = previous.enrollment;
  };
}

function fixture() {
  const adminA = {
    id: "admin-a", email: "a@corp.invalid", role: "Admin", is_active: true,
    password_hash: bcrypt.hashSync("admin-a-pass", 4)
  };
  const adminB = {
    id: "admin-b", email: "b@corp.invalid", role: "Admin", is_active: true,
    password_hash: bcrypt.hashSync("admin-b-pass", 4)
  };
  const adminTarget = {
    id: "admin-target", email: "target@corp.invalid", role: "Admin", is_active: true,
    password_hash: bcrypt.hashSync("target-admin-pass", 4),
    totp: { secret: "encrypted-mock-secret", last_counter: 1 },
    totp_enrollment_ticket: { digest: "mock-digest" },
    session_epoch: 1
  };
  const financeUser = {
    id: "finance-1", email: "fin@corp.invalid", role: "Finance", is_active: true,
    password_hash: bcrypt.hashSync("finance-pass", 4),
    totp: { secret: "encrypted-mock-secret", last_counter: 1 },
    totp_enrollment_ticket: { digest: "mock-digest" },
    session_epoch: 2
  };
  const technician = { id: "tech-1", email: "tech@corp.invalid", role: "Technician", is_active: true };
  const db = {
    users: [adminA, adminB, adminTarget, financeUser, technician],
    audit_logs: []
  };
  const store = {
    audit: (state, actor, type, id, action, before, after) => {
      state.audit_logs.push({ actor_id: actor?.id, action, before, after, entity_type: type, entity_id: id });
    }
  };
  return { adminA, adminB, adminTarget, financeUser, technician, db, store };
}

test("resetTotpFactor is 404 when enrollment is dark", () => {
  const previous = process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
  delete process.env.ORAC_TOTP_ENROLLMENT_ENABLED;
  try {
    const f = fixture();
    const res = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.financeUser.id }, db: f.db, store: f.store, user: f.adminA }), res);
    assert.equal(res.statusCode, 404);
  } finally {
    if (previous !== undefined) process.env.ORAC_TOTP_ENROLLMENT_ENABLED = previous;
  }
});

test("resetTotpFactor requires manageUsers permission", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const res = makeRes();
    assert.throws(
      () => resetTotpFactor(makeReq({ body: { user_id: f.financeUser.id }, db: f.db, store: f.store, user: f.technician }), res),
      /cannot perform manageUsers/
    );
    const denied = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_DENIED");
    assert.ok(denied);
    assert.equal(denied.after.reason, "permission");
  } finally {
    restore();
  }
});

test("resetTotpFactor refuses self reset", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const res = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminA.id }, db: f.db, store: f.store, user: f.adminA }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    const denied = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_DENIED");
    assert.ok(denied);
    assert.equal(denied.after.reason, "self_reset");
  } finally {
    restore();
  }
});

test("resetTotpFactor refuses target without enrolled factor", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const res = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.technician.id }, db: f.db, store: f.store, user: f.adminA }), res);
    assert.equal(res.statusCode, 409);
    const denied = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_DENIED");
    assert.ok(denied);
    assert.equal(denied.after.reason, "not_enrolled");
  } finally {
    restore();
  }
});

test("resetTotpFactor strictly refuses Admin targets even with approver_id (requires two-step dual-authorization)", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const res = makeRes();
    // Testing the critical fix: passing approver_id in a single request MUST fail.
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id, approver_id: f.adminB.id }, db: f.db, store: f.store, user: f.adminA }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    const denied = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_DENIED");
    assert.ok(denied);
    assert.equal(denied.after.reason, "admin_requires_approval_workflow");
    // Confirm factor was NOT reset
    assert.ok(f.adminTarget.totp?.secret);
  } finally {
    restore();
  }
});

test("resetTotpFactor resets non-Admin user directly with single Admin", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const res = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.financeUser.id }, db: f.db, store: f.store, user: f.adminA }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(f.financeUser.totp, null);
    assert.equal(f.financeUser.totp_enrollment_ticket, null);
    assert.equal(f.financeUser.session_epoch, 3);
    const resetAudit = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET");
    assert.ok(resetAudit);
    assert.equal(resetAudit.actor_id, f.adminA.id);
    assert.equal(resetAudit.after.reset_by, f.adminA.id);
  } finally {
    restore();
  }
});

test("requestTotpFactorReset validates caller and target constraints", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();

    // 1. Target not found
    const res1 = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: "unknown-id" }, db: f.db, store: f.store, user: f.adminA }), res1);
    assert.equal(res1.statusCode, 404);
    assert.equal(f.db.audit_logs.pop().after.reason, "target_not_found");

    // 2. Non-Admin target cannot use Admin request route
    const res2 = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.financeUser.id }, db: f.db, store: f.store, user: f.adminA }), res2);
    assert.equal(res2.statusCode, 400);
    assert.equal(f.db.audit_logs.pop().after.reason, "target_not_admin");

    // 3. Admin cannot request reset of their own factor
    const res3 = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.adminA.id }, db: f.db, store: f.store, user: f.adminA }), res3);
    assert.equal(res3.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "self_request");

    // 4. Successful request returns request_id and sets pending request
    const res4 = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), res4);
    assert.equal(res4.statusCode, 200);
    assert.ok(res4.body.data.request_id);
    assert.equal(typeof res4.body.data.request_id, "string");
    assert.ok(f.adminTarget.totp_factor_reset_request);
    assert.equal(f.adminTarget.totp_factor_reset_request.requested_by, f.adminA.id);

    const auditReq = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_REQUESTED");
    assert.ok(auditReq);
    assert.equal(auditReq.actor_id, f.adminA.id);
  } finally {
    restore();
  }
});

test("approveTotpFactorReset enforces dual-authorization gates, single-use, and replay resistance", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();

    // Setup: Admin A requests reset for adminTarget
    const reqRes = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), reqRes);
    assert.equal(reqRes.statusCode, 200);
    const requestId = reqRes.body.data.request_id;

    // 1. Target cannot approve their own reset
    const res1 = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: requestId }, db: f.db, store: f.store, user: f.adminTarget }), res1);
    assert.equal(res1.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "target_approval");

    // 2. Requester cannot approve their own request (self-approval rejected)
    const res2 = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: requestId }, db: f.db, store: f.store, user: f.adminA }), res2);
    assert.equal(res2.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "self_approval");

    // 3. Bad / wrong request_id is rejected
    const res3 = makeRes();
    const wrongId = crypto.randomBytes(32).toString("base64url");
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: wrongId }, db: f.db, store: f.store, user: f.adminB }), res3);
    assert.equal(res3.statusCode, 400);
    assert.equal(f.db.audit_logs.pop().after.reason, "bad_request_id");

    // 4. Stale request rejected if target session changed
    f.adminTarget.session_epoch = 99;
    const res4 = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: requestId }, db: f.db, store: f.store, user: f.adminB }), res4);
    assert.equal(res4.statusCode, 409);
    assert.equal(f.db.audit_logs.pop().after.reason, "request_stale");
    assert.equal(f.adminTarget.totp_factor_reset_request, null); // wiped on stale attempt

    // Re-create request for happy path testing
    f.adminTarget.session_epoch = 1;
    const reqRes2 = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), reqRes2);
    const validId = reqRes2.body.data.request_id;

    // 5. Independent authenticated Admin B successfully approves
    const res5 = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: validId }, db: f.db, store: f.store, user: f.adminB }), res5);
    assert.equal(res5.statusCode, 200);
    assert.equal(f.adminTarget.totp, null);
    assert.equal(f.adminTarget.totp_factor_reset_request, null);
    assert.equal(f.adminTarget.totp_enrollment_ticket, null);
    assert.equal(f.adminTarget.session_epoch, 2);

    // Verify distinct audit rows for approval and reset
    const approvedAudit = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_APPROVED");
    assert.ok(approvedAudit);
    assert.equal(approvedAudit.actor_id, f.adminB.id);
    assert.equal(approvedAudit.after.requested_by, f.adminA.id);
    assert.equal(approvedAudit.after.approved_by, f.adminB.id);

    const resetAudit = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET" && log.after.requested_by === f.adminA.id);
    assert.ok(resetAudit);
    assert.equal(resetAudit.actor_id, f.adminB.id);

    // 6. Replay resistance: approving again immediately fails (single-use consumed)
    const res6 = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: validId }, db: f.db, store: f.store, user: f.adminB }), res6);
    assert.equal(res6.statusCode, 404);
    assert.equal(f.db.audit_logs.pop().after.reason, "no_pending_request");
  } finally {
    restore();
  }
});

test("approveTotpFactorReset rejects expired requests", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();
    const reqRes = makeRes();
    requestTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), reqRes);
    const requestId = reqRes.body.data.request_id;

    // Fast-forward request expiration
    f.adminTarget.totp_factor_reset_request.expires_at = Date.now() - 1000;

    const res = makeRes();
    approveTotpFactorReset(makeReq({ body: { user_id: f.adminTarget.id, request_id: requestId }, db: f.db, store: f.store, user: f.adminB }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(f.db.audit_logs.pop().after.reason, "request_expired");
    assert.equal(f.adminTarget.totp_factor_reset_request, null);
  } finally {
    restore();
  }
});
