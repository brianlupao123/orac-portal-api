import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeReq, makeRes } from "./_http.js";
import { resetTotpFactor } from "../src/controllers/totpController.js";

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
  const adminA = { id: "admin-a", email: "a@corp.invalid", role: "Admin", is_active: true };
  const adminB = { id: "admin-b", email: "b@corp.invalid", role: "Admin", is_active: true };
  const adminTarget = {
    id: "admin-target", email: "target@corp.invalid", role: "Admin", is_active: true,
    totp: { secret: "encrypted-mock-secret", last_counter: 1 },
    totp_enrollment_ticket: { digest: "mock-digest" },
    session_epoch: 1
  };
  const financeUser = {
    id: "finance-1", email: "fin@corp.invalid", role: "Finance", is_active: true,
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

test("resetTotpFactor resets non-Admin user with single Admin", () => {
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

test("resetTotpFactor for Admin target requires second independent Admin approval", () => {
  const restore = setEnvironment();
  try {
    const f = fixture();

    // 1. Missing approver
    const res1 = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), res1);
    assert.equal(res1.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "dual_admin_required");

    // 2. Approver is the actor
    const res2 = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id, approver_id: f.adminA.id }, db: f.db, store: f.store, user: f.adminA }), res2);
    assert.equal(res2.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "dual_admin_required");

    // 3. Approver is the target
    const res3 = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id, approver_id: f.adminTarget.id }, db: f.db, store: f.store, user: f.adminA }), res3);
    assert.equal(res3.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "dual_admin_required");

    // 4. Approver is not an Admin
    const res4 = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id, approver_id: f.technician.id }, db: f.db, store: f.store, user: f.adminA }), res4);
    assert.equal(res4.statusCode, 403);
    assert.equal(f.db.audit_logs.pop().after.reason, "approver_permission");

    // 5. Valid second Admin approver succeeds
    const res5 = makeRes();
    resetTotpFactor(makeReq({ body: { user_id: f.adminTarget.id, approver_id: f.adminB.id }, db: f.db, store: f.store, user: f.adminA }), res5);
    assert.equal(res5.statusCode, 200);
    assert.equal(f.adminTarget.totp, null);
    assert.equal(f.adminTarget.totp_enrollment_ticket, null);
    assert.equal(f.adminTarget.session_epoch, 2);

    const approveAudit = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET_APPROVED");
    assert.ok(approveAudit);
    assert.equal(approveAudit.after.approved_by, f.adminB.id);

    const resetAudit = f.db.audit_logs.find((log) => log.action === "TOTP_FACTOR_RESET");
    assert.ok(resetAudit);
    assert.equal(resetAudit.actor_id, f.adminA.id);
  } finally {
    restore();
  }
});
